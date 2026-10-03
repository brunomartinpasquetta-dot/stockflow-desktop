// Facturas de compra por teléfono — lector de texto PaddleOCR (PP-OCRv5) sobre
// ONNX Runtime. Node puro, sólo CPU, sin Python ni GPU. Es el lector PRINCIPAL en
// Windows y el RESPALDO en Mac (si Apple Vision falla); ver lectorSistema.ts.
//
// Corre con el propio ejecutable de Electron como Node, así no depende de un Node
// instalado en la PC del cliente:
//   ELECTRON_RUN_AS_NODE=1 <StockFlow.exe|Electron> leer.mjs <foto.jpg> [opciones]
//   ELECTRON_RUN_AS_NODE=1 <electron> leer.mjs --probar      → "disponible" | "no disponible: motivo"
//
// Imprime EXACTAMENTE el mismo JSON que ocr-mac/vision.swift y ocr-win/leer.ps1
// (lo valida `interpretarLectura` de electron/facturas/lectorSistema.ts):
//   { "ancho": px, "alto": px, "textos": [ { "t", "x0", "y0", "x1", "y1", "h", "c" } ] }
//   (x0,y0)-(x1,y1) = base del texto, normalizada 0..1, "y" hacia ABAJO, con la
//   orientación EXIF aplicada; h = alto de letra / alto de la foto; c = confianza 0..1.
//
// Módulos: `onnxruntime-node` y `jpeg-js` se toman de las carpetas node_modules que
// llegan en STOCKFLOW_OCR_NODE_MODULES (separadas por ":" o ";"; empaquetado:
// resources/app.asar/node_modules, que Electron en modo Node sabe leer, y
// app.asar.unpacked/node_modules). Si no llega nada, se resuelven desde acá
// (desarrollo: apps/desktop/node_modules). Nada más: ni sharp ni OpenCV; la foto se
// decodifica con jpeg-js y la reducción, el gris, los contornos y los recortes son
// JavaScript puro.
//
// Pipeline (el de PaddleOCR, sin el clasificador de ángulo), igual al prototipo
// tools/ocr-facturas/paddle-ocr.mjs que midió 140/140 renglones en las 8 fotos reales:
//   foto → EXIF → gris "canal más claro" max(R,G,B) (borra birome y resaltador, como
//   en la Mac) → reducir a 2000 px de lado (múltiplo de 32) → DB (detección) → umbral
//   → componentes conexas → rectángulo mínimo girado + puntaje + agrandar (unclip)
//   → unir cajitas de 1–2 caracteres a su vecina → recorte enderezado de cada caja a
//   48 px de alto → CRNN → CTC con el diccionario embebido en el ONNX.
//
// Opciones (valores por defecto = los medidos; ver tools/ocr-facturas/RESULTADOS.md):
//   --lado <px>      lado mayor al que se reduce la foto [2000]
//   --hilos <n>      hilos de ONNX Runtime [min(4, núcleos)]
//   --umbral <0..1>  umbral del mapa de detección [0.3]
//   --caja <0..1>    puntaje mínimo de una caja (PaddleOCR usa 0,6; con estas fotos
//                    filtra descripciones enteras, por eso va apagado) [0]
//   --unclip <n>     cuánto se agranda cada contorno [1.5]
//   --sin-unir       no pegar las cajitas de 1–2 caracteres a la vecina de la derecha
//   --det/--rec <onnx>  otros modelos (para experimentar)
//   --filtro <lanczos|triangulo>  filtro con que se reduce la foto [lanczos]
//   --lineal         recortes con interpolación bilineal en vez de bicúbica (para comparar)
//   --tiempos        tiempos y memoria por stderr
//   --depurar        agrega "p" (puntaje de la caja) a cada texto
//
// Memoria: ~500–800 MB mientras lee (la foto de 12 MP decodificada + los dos modelos).
// El proceso muere con cada hoja: no hay nada que liberar entre hojas.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MODELOS = join(AQUI, 'modelos');

// ---------------------------------------------------------------------------
// Módulos (onnxruntime-node, jpeg-js)
// ---------------------------------------------------------------------------

/** Carpetas node_modules candidatas, en orden: las que manda la app y la propia. */
function carpetasDeModulos() {
  return (process.env.STOCKFLOW_OCR_NODE_MODULES || '').split(delimiter).filter((d) => d.trim());
}

/**
 * Carga un módulo CommonJS por nombre desde las carpetas candidatas. Se usa
 * `require` (no `import()`): el `require` de Electron en modo Node lee adentro
 * de app.asar y redirige los .node a app.asar.unpacked; el cargador ESM no.
 */
function cargarModulo(nombre) {
  const requerir = createRequire(import.meta.url);
  const motivos = [];
  for (const dir of carpetasDeModulos()) {
    const ruta = join(dir, nombre);
    try {
      return requerir(ruta);
    } catch (e) {
      motivos.push(`${ruta}: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
    }
  }
  try {
    return requerir(nombre);
  } catch (e) {
    motivos.push(`${nombre} (desde ${AQUI}): ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
  }
  throw new Error(`no se pudo cargar ${nombre}: ${motivos.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// Opciones
// ---------------------------------------------------------------------------

export function leerOpciones(argv) {
  const o = {
    foto: null,
    det: join(MODELOS, 'ch_PP-OCRv5_det_mobile.onnx'),
    rec: join(MODELOS, 'latin_PP-OCRv5_rec_mobile.onnx'),
    lado: 2000,
    umbral: 0.3,
    caja: 0,
    unclip: 1.5,
    unir: true,
    hilos: Math.min(4, Math.max(1, cpus().length || 1)),
    filtro: 'lanczos',
    cubico: true,
    tiempos: false,
    depurar: false,
    probar: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`falta el valor de ${a}`);
      return x;
    };
    if (a === '--probar') o.probar = true;
    else if (a === '--det') o.det = resolve(v());
    else if (a === '--rec') o.rec = resolve(v());
    else if (a === '--lado') o.lado = Number(v());
    else if (a === '--umbral') o.umbral = Number(v());
    else if (a === '--caja') o.caja = Number(v());
    else if (a === '--unclip') o.unclip = Number(v());
    else if (a === '--sin-unir') o.unir = false;
    else if (a === '--hilos') o.hilos = Number(v());
    else if (a === '--filtro') o.filtro = v();
    else if (a === '--lineal') o.cubico = false;
    else if (a === '--tiempos') o.tiempos = true;
    else if (a === '--depurar') o.depurar = true;
    else if (a.startsWith('--')) throw new Error(`opción desconocida: ${a}`);
    else o.foto = a;
  }
  if (!(o.lado >= 320) || !(o.hilos >= 1) || !(o.umbral > 0 && o.umbral < 1) || !(o.unclip > 0)) {
    throw new Error('opciones fuera de rango');
  }
  if (o.filtro !== 'lanczos' && o.filtro !== 'triangulo') throw new Error(`--filtro ${o.filtro}: tiene que ser lanczos o triangulo`);
  return o;
}

// ---------------------------------------------------------------------------
// Diccionario: metadatos del ONNX (RapidOCR guarda la lista de caracteres en
// metadata_props con la clave "character").
// ---------------------------------------------------------------------------

function varint(b, p) {
  let r = 0;
  let s = 0;
  let byte;
  do {
    byte = b[p.i++];
    if (byte === undefined) throw new Error('ONNX truncado');
    r += (byte & 0x7f) * 2 ** s;
    s += 7;
  } while (byte & 0x80);
  return r;
}

/** metadata_props del ModelProto (campo 14), sin cargar el grafo. */
export function metadatosOnnx(ruta) {
  const b = readFileSync(ruta);
  const p = { i: 0 };
  const out = {};
  while (p.i < b.length) {
    const tag = varint(b, p);
    const campo = tag >> 3;
    const wt = tag & 7;
    if (wt === 0) varint(b, p);
    else if (wt === 1) p.i += 8;
    else if (wt === 5) p.i += 4;
    else if (wt === 2) {
      const len = varint(b, p);
      const fin = p.i + len;
      if (campo === 14) {
        let k = '';
        let v = '';
        while (p.i < fin) {
          const t = varint(b, p);
          const l = varint(b, p);
          const s = b.toString('utf8', p.i, p.i + l);
          p.i += l;
          if (t >> 3 === 1) k = s;
          else v = s;
        }
        out[k] = v;
      } else p.i = fin;
    } else throw new Error(`ONNX ilegible (wire type ${wt})`);
  }
  return out;
}

/** Caracteres del reconocedor: índice 0 = blanco CTC, i → chars[i-1]; termina en espacio. */
export function cargarDiccionario(rutaRec) {
  const m = metadatosOnnx(rutaRec);
  if (!m.character) throw new Error(`el modelo ${rutaRec} no trae el diccionario embebido`);
  const lineas = m.character.split('\n');
  if (lineas.length && lineas[lineas.length - 1] === '') lineas.pop();
  // RapidOCR/PaddleOCR agregan SIEMPRE el espacio al final: clases = caracteres + espacio + blanco.
  lineas.push(' ');
  return lineas;
}

// ---------------------------------------------------------------------------
// Foto JPEG → gris max(R,G,B) → orientación EXIF → tamaño de trabajo (múltiplo de 32)
// ---------------------------------------------------------------------------

/** Orientación EXIF (tag 0x0112) del JPEG, 1..8; 1 si no la tiene o no se entiende. */
export function orientacionExif(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return 1; // no es un segmento: el archivo está raro
    const marcador = buf[p + 1];
    if (marcador === 0xff) {
      p++; // relleno
      continue;
    }
    if (marcador === 0xd8 || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      p += 2; // sin longitud
      continue;
    }
    if (marcador === 0xda || marcador === 0xd9) return 1; // empieza la imagen o termina: no hubo EXIF
    const largo = buf.readUInt16BE(p + 2);
    if (largo < 2) return 1;
    if (marcador === 0xe1 && largo >= 16 && buf.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      const t = p + 10; // cabecera TIFF
      const fin = Math.min(buf.length, p + 2 + largo);
      const orden = buf.toString('latin1', t, t + 2);
      if (orden !== 'II' && orden !== 'MM') return 1;
      const le = orden === 'II';
      const u16 = (q) => (q + 2 <= fin ? (le ? buf.readUInt16LE(q) : buf.readUInt16BE(q)) : 0);
      const u32 = (q) => (q + 4 <= fin ? (le ? buf.readUInt32LE(q) : buf.readUInt32BE(q)) : 0);
      if (u16(t + 2) !== 42) return 1;
      const ifd = t + u32(t + 4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > fin) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8); // SHORT: queda en los primeros 2 bytes del valor
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    p += 2 + largo;
  }
  return 1;
}

/** JPEG → gris "canal más claro" (max(R,G,B)) a resolución completa, sin orientar. */
function decodificarGris(buf, jpeg) {
  const img = jpeg.decode(buf, {
    useTArray: true,
    formatAsRGBA: false,
    tolerantDecoding: true,
    maxResolutionInMP: 100,
    maxMemoryUsageInMB: 2048,
  });
  const n = img.width * img.height;
  const d = img.data;
  const g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = d[j];
    const v = d[j + 1];
    const b = d[j + 2];
    g[i] = r > v ? (r > b ? r : b) : v > b ? v : b;
  }
  return { gris: g, w: img.width, h: img.height };
}

/** Núcleo Lanczos de 3 lóbulos (el que usa sharp por defecto), t en píxeles de salida. */
function lanczos3(t) {
  if (t === 0) return 1;
  const x = Math.abs(t);
  if (x >= 3) return 0;
  const a = Math.PI * x;
  return (3 * Math.sin(a) * Math.sin(a / 3)) / (a * a);
}

/**
 * Pesos de un filtro separable cuyo soporte crece con la reducción: al achicar
 * promedia todos los píxeles de origen que caen en cada píxel de destino (no
 * saltea trazos finos); al agrandar interpola. `triangulo` = bilineal;
 * `lanczos` = Lanczos3 (más nítido; es lo que hacía sharp en el prototipo).
 */
function pesosFiltro(nIn, nOut, filtro) {
  const esc = nIn / nOut;
  const escala = Math.max(1, esc);
  const lobulos = filtro === 'lanczos' ? 3 : 1;
  const radio = escala * lobulos;
  const nucleo = filtro === 'lanczos' ? (t) => lanczos3(t / escala) : (t) => Math.max(0, 1 - Math.abs(t) / escala);
  const maxTaps = Math.ceil(radio) * 2 + 1;
  const inicio = new Int32Array(nOut);
  const cantidad = new Int32Array(nOut);
  const pesos = new Float32Array(nOut * maxTaps);
  for (let i = 0; i < nOut; i++) {
    const c = (i + 0.5) * esc - 0.5;
    const a = Math.max(0, Math.ceil(c - radio));
    const b = Math.min(nIn - 1, Math.floor(c + radio));
    let suma = 0;
    for (let x = a; x <= b; x++) {
      const p = nucleo(x - c);
      pesos[i * maxTaps + (x - a)] = p;
      suma += p;
    }
    if (suma !== 0) for (let x = a; x <= b; x++) pesos[i * maxTaps + (x - a)] /= suma;
    inicio[i] = a;
    cantidad[i] = b - a + 1;
  }
  return { inicio, cantidad, pesos, maxTaps };
}

/** Cambia el tamaño de una imagen gris (filtro separable, horizontal y después vertical). */
export function redimensionar(src, wIn, hIn, wOut, hOut, filtro = 'lanczos') {
  if (wIn === wOut && hIn === hOut) return src;
  const fx = pesosFiltro(wIn, wOut, filtro);
  const tmp = new Float32Array(wOut * hIn);
  for (let y = 0; y < hIn; y++) {
    const fila = y * wIn;
    const salida = y * wOut;
    for (let x = 0; x < wOut; x++) {
      const a = fx.inicio[x];
      const n = fx.cantidad[x];
      const pb = x * fx.maxTaps;
      let s = 0;
      for (let k = 0; k < n; k++) s += src[fila + a + k] * fx.pesos[pb + k];
      tmp[salida + x] = s;
    }
  }
  const fy = pesosFiltro(hIn, hOut, filtro);
  const out = new Uint8Array(wOut * hOut);
  const acum = new Float32Array(wOut);
  for (let y = 0; y < hOut; y++) {
    acum.fill(0);
    const a = fy.inicio[y];
    const n = fy.cantidad[y];
    const pb = y * fy.maxTaps;
    for (let k = 0; k < n; k++) {
      const p = fy.pesos[pb + k];
      const fila = (a + k) * wOut;
      for (let x = 0; x < wOut; x++) acum[x] += tmp[fila + x] * p;
    }
    const salida = y * wOut;
    for (let x = 0; x < wOut; x++) {
      const v = Math.round(acum[x]);
      out[salida + x] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

/** Aplica la orientación EXIF a una imagen gris; devuelve la imagen derecha. */
export function orientar(g, w, h, o) {
  if (o === 1) return { g, w, h };
  const gira = o >= 5;
  const W = gira ? h : w;
  const H = gira ? w : h;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X;
      let Y;
      switch (o) {
        case 2: // espejo horizontal
          X = w - 1 - x;
          Y = y;
          break;
        case 3: // 180°
          X = w - 1 - x;
          Y = h - 1 - y;
          break;
        case 4: // espejo vertical
          X = x;
          Y = h - 1 - y;
          break;
        case 5: // transpuesta
          X = y;
          Y = x;
          break;
        case 6: // 90° horario (la foto vertical típica del teléfono)
          X = h - 1 - y;
          Y = x;
          break;
        case 7: // transversa
          X = h - 1 - y;
          Y = w - 1 - x;
          break;
        default: // 8: 90° antihorario
          X = y;
          Y = w - 1 - x;
      }
      out[Y * W + X] = g[y * w + x];
    }
  }
  return { g: out, w: W, h: H };
}

/** Foto → { ancho, alto (de la foto derecha), w, h (de trabajo, múltiplos de 32), gris }. */
function prepararFoto(buf, o, jpeg) {
  const orientacion = orientacionExif(buf);
  const d = decodificarGris(buf, jpeg);
  const gira = orientacion >= 5;
  const W = gira ? d.h : d.w;
  const H = gira ? d.w : d.h;
  const esc = Math.min(1, o.lado / Math.max(W, H));
  // Se estira ≤ 31 px por lado para caer en un múltiplo de 32 (así no hay bandas que corran las cajas).
  const w = Math.max(32, Math.round((W * esc) / 32) * 32);
  const h = Math.max(32, Math.round((H * esc) / 32) * 32);
  const chica = redimensionar(d.gris, d.w, d.h, gira ? h : w, gira ? w : h, o.filtro);
  const derecha = orientar(chica, gira ? h : w, gira ? w : h, orientacion);
  return { ancho: W, alto: H, w: derecha.w, h: derecha.h, gris: derecha.g };
}

// ---------------------------------------------------------------------------
// Geometría de cajas (puntos [x, y]; caja = [arriba-izq, arriba-der, abajo-der, abajo-izq])
// ---------------------------------------------------------------------------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Cierre convexo (monotone chain), en sentido antihorario, sin puntos colineales. */
function cascoConvexo(puntos) {
  const pts = [...puntos].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cruz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inf = [];
  for (const p of pts) {
    while (inf.length >= 2 && cruz(inf[inf.length - 2], inf[inf.length - 1], p) <= 0) inf.pop();
    inf.push(p);
  }
  const sup = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (sup.length >= 2 && cruz(sup[sup.length - 2], sup[sup.length - 1], p) <= 0) sup.pop();
    sup.push(p);
  }
  inf.pop();
  sup.pop();
  return inf.concat(sup);
}

/** Ordena las 4 esquinas como PaddleOCR: arriba-izq, arriba-der, abajo-der, abajo-izq. */
function ordenarEsquinas(pts) {
  pts.sort((a, b) => a[0] - b[0]);
  const [i1, i4] = pts[1][1] > pts[0][1] ? [0, 1] : [1, 0];
  const [i2, i3] = pts[3][1] > pts[2][1] ? [2, 3] : [3, 2];
  return [pts[i1], pts[i2], pts[i3], pts[i4]];
}

/**
 * Rectángulo mínimo girado que contiene los puntos (minAreaRect de OpenCV:
 * calibres rotativos sobre el casco convexo). `lado` = el lado menor.
 */
export function rectMinimo(puntos) {
  const casco = cascoConvexo(puntos);
  if (casco.length === 0) return null;
  if (casco.length < 3) {
    const a = casco[0];
    const b = casco[casco.length - 1];
    return { puntos: ordenarEsquinas([a, b, [b[0], b[1]], [a[0], a[1]]]), lado: 0 };
  }
  let mejor = null;
  const n = casco.length;
  for (let i = 0; i < n; i++) {
    const a = casco[i];
    const b = casco[(i + 1) % n];
    const L = dist(a, b);
    if (L === 0) continue;
    const ux = (b[0] - a[0]) / L;
    const uy = (b[1] - a[1]) / L;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of casco) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!mejor || area < mejor.area) mejor = { area, ux, uy, minU, maxU, minV, maxV };
  }
  if (!mejor) return null;
  const { ux, uy, minU, maxU, minV, maxV } = mejor;
  const esquina = (u, v) => [u * ux - v * uy, u * uy + v * ux];
  return {
    puntos: ordenarEsquinas([esquina(minU, minV), esquina(maxU, minV), esquina(maxU, maxV), esquina(minU, maxV)]),
    lado: Math.min(maxU - minU, maxV - minV),
  };
}

/**
 * Agranda el rectángulo (unclip de DB: la red predice el texto "encogido"):
 * cada lado se corre hacia afuera área·ratio/perímetro, lo mismo que el offset
 * redondeado de Clipper seguido del rectángulo mínimo que usa PaddleOCR.
 */
function agrandar(box, ratio) {
  const [tl, tr, br, bl] = box;
  const ancho = (dist(tl, tr) + dist(bl, br)) / 2;
  const alto = (dist(tl, bl) + dist(tr, br)) / 2;
  const per = 2 * (ancho + alto);
  if (per === 0) return null;
  const d = (ancho * alto * ratio) / per;
  const L = dist(tl, tr) || 1;
  const M = dist(tl, bl) || 1;
  const ux = (tr[0] - tl[0]) / L;
  const uy = (tr[1] - tl[1]) / L;
  const vx = (bl[0] - tl[0]) / M;
  const vy = (bl[1] - tl[1]) / M;
  return {
    puntos: [
      [tl[0] - d * ux - d * vx, tl[1] - d * uy - d * vy],
      [tr[0] + d * ux - d * vx, tr[1] + d * uy - d * vy],
      [br[0] + d * ux + d * vx, br[1] + d * uy + d * vy],
      [bl[0] - d * ux + d * vx, bl[1] - d * uy + d * vy],
    ],
    lado: Math.min(ancho, alto) + 2 * d,
  };
}

/** Media del mapa de probabilidad dentro del rectángulo de la caja (box_score_fast). */
function puntajeCaja(prob, mw, mh, puntos) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [x, y] of puntos) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  x0 = Math.max(0, Math.floor(x0));
  x1 = Math.min(mw - 1, Math.ceil(x1));
  y0 = Math.max(0, Math.floor(y0));
  y1 = Math.min(mh - 1, Math.ceil(y1));
  let s = 0;
  let k = 0;
  for (let y = y0; y <= y1; y++) {
    const fila = y * mw;
    for (let x = x0; x <= x1; x++) {
      s += prob[fila + x];
      k++;
    }
  }
  return k ? s / k : 0;
}

/**
 * Componentes conexas (vecindad de 8) del mapa binarizado. De cada una
 * devuelve sólo los extremos izquierdo y derecho de cada fila: son los únicos
 * puntos que pueden ser vértices del casco convexo, y alcanzan para el
 * rectángulo mínimo.
 */
function componentes(bin, w, h) {
  const pila = new Int32Array(w * h);
  const salida = [];
  for (let i0 = 0; i0 < bin.length; i0++) {
    if (bin[i0] !== 1) continue;
    const extremos = new Map(); // fila → [xMin, xMax]
    let tope = 0;
    pila[tope++] = i0;
    bin[i0] = 2;
    while (tope > 0) {
      const i = pila[--tope];
      const x = i % w;
      const y = (i - x) / w;
      const e = extremos.get(y);
      if (e) {
        if (x < e[0]) e[0] = x;
        if (x > e[1]) e[1] = x;
      } else extremos.set(y, [x, x]);
      const yA = y > 0 ? y - 1 : 0;
      const yB = y < h - 1 ? y + 1 : h - 1;
      const xA = x > 0 ? x - 1 : 0;
      const xB = x < w - 1 ? x + 1 : w - 1;
      for (let yy = yA; yy <= yB; yy++) {
        const fila = yy * w;
        for (let xx = xA; xx <= xB; xx++) {
          const j = fila + xx;
          if (bin[j] === 1) {
            bin[j] = 2;
            pila[tope++] = j;
          }
        }
      }
    }
    const puntos = [];
    for (const [y, [a, b]] of extremos) {
      puntos.push([a, y]);
      if (b !== a) puntos.push([b, y]);
    }
    salida.push(puntos);
  }
  return salida;
}

/** Mapa de probabilidad → cajas [{box, puntaje}] en píxeles del mapa (postproceso DB de PaddleOCR). */
function cajasDesdeMapa(prob, mw, mh, o) {
  const bin = new Uint8Array(mw * mh);
  for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > o.umbral ? 1 : 0;
  const cajas = [];
  for (const puntos of componentes(bin, mw, mh)) {
    const r = rectMinimo(puntos);
    if (!r || r.lado < 3) continue;
    const puntaje = puntajeCaja(prob, mw, mh, r.puntos);
    if (puntaje < o.caja) continue;
    const g = agrandar(r.puntos, o.unclip);
    if (!g || g.lado < 5) continue;
    cajas.push({ box: g.puntos, puntaje });
  }
  return cajas;
}

/**
 * Pega las cajitas de 1–2 caracteres a la caja vecina de la derecha en el mismo
 * renglón. Sueltas, el reconocedor las lee como basura y el signo "-" de los
 * importes negativos se pierde; pegadas, el número llega con su signo
 * ("- 114,46"), que es lo que devuelve la Mac y lo que el parser espera.
 */
function unirCajitas(cajas) {
  const medir = (c) => {
    const [tl, tr, br, bl] = c.box;
    c.alto = (dist(tl, bl) + dist(tr, br)) / 2;
    c.ancho = (dist(tl, tr) + dist(bl, br)) / 2;
    c.cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
    c.xIzq = Math.min(tl[0], bl[0]);
    c.xDer = Math.max(tr[0], br[0]);
  };
  const vivas = cajas.map((c) => ({ ...c }));
  for (const c of vivas) medir(c);
  for (let intentos = 0; intentos < 3; intentos++) {
    let cambio = false;
    for (let i = 0; i < vivas.length; i++) {
      const a = vivas[i];
      if (a.ancho > a.alto * 1.5) continue; // no es una cajita
      let mejor = -1;
      let dMejor = Infinity;
      for (let j = 0; j < vivas.length; j++) {
        if (j === i) continue;
        const b = vivas[j];
        const hueco = b.xIzq - a.xDer;
        if (hueco < -a.alto * 0.3 || hueco > a.alto * 1.2) continue; // está a la derecha y cerca
        const solape = Math.min(a.cy + a.alto / 2, b.cy + b.alto / 2) - Math.max(a.cy - a.alto / 2, b.cy - b.alto / 2);
        if (solape < Math.min(a.alto, b.alto) * 0.5) continue; // mismo renglón
        if (b.alto > a.alto * 3 || a.alto > b.alto * 3) continue;
        if (hueco < dMejor) {
          dMejor = hueco;
          mejor = j;
        }
      }
      if (mejor < 0) continue;
      const b = vivas[mejor];
      const r = rectMinimo([...a.box, ...b.box]);
      if (!r) continue;
      const unida = { box: r.puntos, puntaje: Math.max(a.puntaje, b.puntaje) };
      medir(unida);
      vivas.splice(Math.max(i, mejor), 1);
      vivas.splice(Math.min(i, mejor), 1, unida);
      cambio = true;
      i = -1; // de nuevo desde el principio: la unida puede seguir uniéndose
    }
    if (!cambio) break;
  }
  return vivas.map(({ box, puntaje }) => ({ box, puntaje }));
}

// ---------------------------------------------------------------------------
// Recorte enderezado de una caja → entrada del reconocedor (48 px de alto)
// ---------------------------------------------------------------------------

const ALTO_REC = 48;

/** Valor bilineal de la imagen gris en (x, y), con borde replicado. */
function muestra(g, w, h, x, y) {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 < w - 1 ? x0 + 1 : x0;
  const y1 = y0 < h - 1 ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const a = g[y0 * w + x0];
  const b = g[y0 * w + x1];
  const c = g[y1 * w + x0];
  const d = g[y1 * w + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Pesos del núcleo bicúbico de Keys con a = −0,75 (INTER_CUBIC de OpenCV) para la fracción f. */
function pesosCubicos(f) {
  const A = -0.75;
  const w = (t) => {
    t = Math.abs(t);
    if (t <= 1) return (A + 2) * t * t * t - (A + 3) * t * t + 1;
    if (t < 2) return A * t * t * t - 5 * A * t * t + 8 * A * t - 4 * A;
    return 0;
  };
  return [w(f + 1), w(f), w(1 - f), w(2 - f)];
}

/** Valor bicúbico de la imagen gris en (x, y), con borde replicado. */
function muestraCubica(g, w, h, x, y) {
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const px = pesosCubicos(x - x0);
  const py = pesosCubicos(y - y0);
  let s = 0;
  for (let j = 0; j < 4; j++) {
    let yy = y0 - 1 + j;
    if (yy < 0) yy = 0;
    else if (yy > h - 1) yy = h - 1;
    const fila = yy * w;
    let f = 0;
    for (let i = 0; i < 4; i++) {
      let xx = x0 - 1 + i;
      if (xx < 0) xx = 0;
      else if (xx > w - 1) xx = w - 1;
      f += g[fila + xx] * px[i];
    }
    s += f * py[j];
  }
  return s < 0 ? 0 : s > 255 ? 255 : s;
}

/**
 * Recorte enderezado de la caja (getRotateCropImage de PaddleOCR) ya a 48 px de
 * alto y normalizado para el CRNN: tensor [1, 3, 48, ancho] con los tres
 * canales iguales (la imagen es gris). Se muestrea directo de la imagen de
 * trabajo: cada píxel del recorte promedia k×k muestras bicúbicas (bilineales
 * con `--lineal`), con k según cuánto se achica (así no se saltean trazos).
 * Texto vertical (alto ≥ 1,5 × ancho) se gira 90°.
 */
function entradaReconocedor(img, box, cubico) {
  const valorEn = cubico ? muestraCubica : muestra;
  const [tl, tr, br, bl] = box;
  let ancho = Math.floor(Math.max(dist(tl, tr), dist(br, bl)));
  let alto = Math.floor(Math.max(dist(tl, bl), dist(tr, br)));
  if (ancho < 2 || alto < 2) return null;
  // origen + eje "a lo ancho" + eje "a lo alto" del recorte, en píxeles de la imagen
  let origen = tl;
  let ejeU = [tr[0] - tl[0], tr[1] - tl[1]];
  let ejeV = [bl[0] - tl[0], bl[1] - tl[1]];
  if (alto / ancho >= 1.5) {
    // vertical: se lee de arriba hacia abajo girando el recorte 90° antihorario
    origen = tr;
    ejeU = [br[0] - tr[0], br[1] - tr[1]];
    ejeV = [tl[0] - tr[0], tl[1] - tr[1]];
    [ancho, alto] = [alto, ancho];
  }
  const wRec = Math.max(8, Math.round((ALTO_REC * ancho) / alto));
  const k = Math.min(4, Math.max(1, Math.ceil(alto / ALTO_REC)));
  const n = wRec * ALTO_REC;
  const entrada = new Float32Array(3 * n);
  const { gris: g, w, h } = img;
  for (let j = 0; j < ALTO_REC; j++) {
    for (let i = 0; i < wRec; i++) {
      let s = 0;
      for (let a = 0; a < k; a++) {
        const v = (j + (a + 0.5) / k) / ALTO_REC;
        for (let b = 0; b < k; b++) {
          const u = (i + (b + 0.5) / k) / wRec;
          s += valorEn(g, w, h, origen[0] + u * ejeU[0] + v * ejeV[0], origen[1] + u * ejeU[1] + v * ejeV[1]);
        }
      }
      const valor = (s / (k * k) / 255 - 0.5) / 0.5;
      const p = j * wRec + i;
      entrada[p] = valor;
      entrada[n + p] = valor;
      entrada[2 * n + p] = valor;
    }
  }
  return { entrada, ancho: wRec };
}

// ---------------------------------------------------------------------------
// Detección (DB)
// ---------------------------------------------------------------------------

const MEDIA_DET = [0.485, 0.456, 0.406]; // PaddleOCR normaliza así la imagen BGR
const DESVIO_DET = [0.229, 0.224, 0.225];

async function detectar(ort, sesion, img, o) {
  const { w, h, gris } = img;
  const n = w * h;
  const entrada = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const base = c * n;
    const m = MEDIA_DET[c];
    const d = DESVIO_DET[c];
    for (let i = 0; i < n; i++) entrada[base + i] = (gris[i] / 255 - m) / d;
  }
  const salida = await sesion.run({ [sesion.inputNames[0]]: new ort.Tensor('float32', entrada, [1, 3, h, w]) });
  const mapa = salida[sesion.outputNames[0]];
  const mh = mapa.dims[2];
  const mw = mapa.dims[3];
  let cajas = cajasDesdeMapa(mapa.data, mw, mh, o);
  // El mapa sale del tamaño de la entrada; por las dudas, se escala.
  const rx = w / mw;
  const ry = h / mh;
  if (rx !== 1 || ry !== 1) for (const c of cajas) c.box = c.box.map(([x, y]) => [x * rx, y * ry]);
  if (o.unir) cajas = unirCajitas(cajas);
  return cajas;
}

// ---------------------------------------------------------------------------
// Reconocimiento (CRNN + CTC)
// ---------------------------------------------------------------------------

async function reconocer(ort, sesion, img, caja, dic, o) {
  const e = entradaReconocedor(img, caja.box, o.cubico);
  if (!e) return null;
  const salida = await sesion.run({ [sesion.inputNames[0]]: new ort.Tensor('float32', e.entrada, [1, 3, ALTO_REC, e.ancho]) });
  const t = salida[sesion.outputNames[0]];
  const pasos = t.dims[1];
  const clases = t.dims[2];
  const p = t.data;
  // CTC greedy: argmax por paso, sin blancos ni repetidos.
  let texto = '';
  let suma = 0;
  let k = 0;
  let anterior = -1;
  for (let s = 0; s < pasos; s++) {
    let mejor = 0;
    let pm = p[s * clases];
    for (let c = 1; c < clases; c++) {
      const v = p[s * clases + c];
      if (v > pm) {
        pm = v;
        mejor = c;
      }
    }
    if (mejor !== 0 && mejor !== anterior) {
      texto += dic[mejor - 1] ?? '';
      suma += pm;
      k++;
    }
    anterior = mejor;
  }
  if (k === 0) return null;
  return { texto, confianza: suma / k, clases };
}

// ---------------------------------------------------------------------------
// Programa
// ---------------------------------------------------------------------------

function comprobarModelos(o) {
  for (const m of [o.det, o.rec]) if (!existsSync(m)) throw new Error(`falta el modelo ${m}`);
}

/** Lee una hoja; devuelve la lectura en el formato de interpretarLectura. */
export async function leerHoja(o) {
  const t0 = performance.now();
  comprobarModelos(o);
  const jpeg = cargarModulo('jpeg-js');
  const ort = cargarModulo('onnxruntime-node');
  const foto = readFileSync(o.foto);
  const opcionesOrt = { intraOpNumThreads: o.hilos, interOpNumThreads: 1 };
  const [det, rec] = await Promise.all([ort.InferenceSession.create(o.det, opcionesOrt), ort.InferenceSession.create(o.rec, opcionesOrt)]);
  try {
    const dic = cargarDiccionario(o.rec);
    const t1 = performance.now();
    const img = prepararFoto(foto, o, jpeg);
    const t2 = performance.now();
    const cajas = await detectar(ort, det, img, o);
    const t3 = performance.now();
    const textos = [];
    let clasesVistas = null;
    for (const c of cajas) {
      const r = await reconocer(ort, rec, img, c, dic, o);
      if (!r || !r.texto.trim()) continue;
      clasesVistas = r.clases;
      const [tl, , br, bl] = c.box;
      const lim = (v) => Math.min(1, Math.max(0, v));
      const texto = {
        t: r.texto,
        x0: lim(bl[0] / img.w),
        y0: lim(bl[1] / img.h),
        x1: lim(br[0] / img.w),
        y1: lim(br[1] / img.h),
        h: Math.hypot(tl[0] - bl[0], tl[1] - bl[1]) / img.h,
        c: r.confianza,
      };
      if (o.depurar) texto.p = Math.round(c.puntaje * 1000) / 1000;
      textos.push(texto);
    }
    const t4 = performance.now();
    if (clasesVistas !== null && clasesVistas !== dic.length + 1) {
      process.stderr.write(`AVISO: el modelo tiene ${clasesVistas} clases y el diccionario ${dic.length} caracteres (+1 blanco): no coinciden\n`);
    }
    if (o.tiempos) {
      const ms = (a, b) => `${(b - a).toFixed(0)} ms`;
      process.stderr.write(
        `modelos ${ms(t0, t1)} · foto ${ms(t1, t2)} (${img.w}×${img.h}) · detección ${ms(t2, t3)} (${cajas.length} cajas) · reconocimiento ${ms(t3, t4)} (${textos.length} textos) · total ${ms(t0, t4)} · ${o.hilos} hilos · rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n`,
      );
    }
    return { ancho: img.ancho, alto: img.alto, textos };
  } finally {
    await Promise.all([det.release(), rec.release()]).catch(() => undefined);
  }
}

/** `--probar`: ¿están los modelos y cargan los módulos nativos en esta PC? */
function probar(o) {
  try {
    comprobarModelos(o);
    cargarModulo('jpeg-js');
    const ort = cargarModulo('onnxruntime-node');
    if (typeof ort.InferenceSession?.create !== 'function') throw new Error('onnxruntime-node no expone InferenceSession');
    return 'disponible';
  } catch (e) {
    return `no disponible: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const esPrincipal = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esPrincipal) {
  try {
    const o = leerOpciones(process.argv.slice(2));
    if (o.probar) {
      process.stdout.write(`${probar(o)}\n`);
      process.exit(0);
    }
    if (!o.foto) throw new Error('uso: leer.mjs <foto> [opciones] | --probar');
    if (!existsSync(o.foto)) throw new Error(`no se pudo abrir la foto: ${o.foto}`);
    const lectura = await leerHoja(o);
    process.stdout.write(`${JSON.stringify(lectura)}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
