#!/usr/bin/env node
// Lector de facturas con PaddleOCR (PP-OCR) sobre onnxruntime-node: Node puro, sólo
// CPU, sin GPU ni Python. Prueba para reemplazar al lector de Windows.
//
// Imprime EXACTAMENTE el mismo JSON que native/ocr-mac/vision.swift (lo consume
// electron/facturas/lectorSistema.ts → interpretarLectura):
//   { "ancho": px, "alto": px, "textos": [ { "t", "x0", "y0", "x1", "y1", "h", "c" } ] }
//   (x0,y0)-(x1,y1) = base del texto, normalizada 0..1, "y" hacia ABAJO, con la
//   orientación EXIF aplicada; h = alto de letra / alto de la foto; c = confianza 0..1.
//
// Uso:  node paddle-ocr.mjs <foto> [opciones]
//       node paddle-ocr.mjs --probar          → "disponible"
// Opciones (todas con valor por defecto razonable):
//   --det <onnx>      modelo de detección (DB)         [modelos/ch_PP-OCRv4_det_mobile.onnx]
//   --rec <onnx>      modelo de reconocimiento (CRNN)  [modelos/latin_PP-OCRv5_rec_mobile.onnx]
//   --dic <txt>       diccionario del reconocedor; si no se da, se saca de los
//                     metadatos del ONNX (clave "character", modelos de RapidOCR)
//   --lado <px>       lado mayor al que se reduce la foto antes de leer [2000]
//   --umbral <0..1>   umbral del mapa de detección (PaddleOCR usa 0,3)  [0.3]
//   --caja <0..1>     puntaje mínimo de una caja (media del mapa dentro del
//                     contorno; PaddleOCR usa 0,6). Apagado por defecto: con estas
//                     fotos el mapa da 0,15–0,45 en cajas perfectas (confianza 0,99)
//                     y con 0,5 se pierden descripciones enteras; filtra la confianza [0]
//   --unclip <n>      cuánto se agranda cada contorno (PaddleOCR: 1,5)   [1.5]
//   --margen <n>      margen a cada costado del recorte, en altos de letra [0]
//   --sin-unir        NO pegar las cajitas de 1–2 caracteres (un "-", una "x" de
//                     birome, una viñeta) a la caja vecina de la derecha. Por defecto
//                     se pegan: sueltas, el reconocedor las lee como basura, y así el
//                     signo de un importe negativo llega junto al número (como en la Mac).
//   --color           leer la foto en color (por defecto se pasa a gris "canal
//                     más claro" = max(R,G,B), igual que la Mac: borra birome/resaltador)
//   --hilos <n>       hilos de ONNX Runtime (por defecto, los que decida ORT)
//   --dibujar <png>   guarda la foto procesada con las cajas (para mirar)
//   --tiempos         imprime tiempos y memoria por stderr
//
// Pipeline (el de PaddleOCR, sin el paso de clasificación de ángulo):
//   foto → EXIF → reducir → gris max(R,G,B) → DB (detección) → umbral → contornos +
//   minAreaRect + puntaje + unclip → unir cajitas → recorte enderezado de cada caja →
//   CRNN a 48 px de alto → CTC con el diccionario.
// El postproceso de la detección y el recorte están portados de PaddleOCR
// (misma lógica que splitIntoLineImages de @gutenye/ocr-common, MIT), con opencv-js
// (WASM) y js-clipper. No se usa `Ocr.detect()` del paquete @gutenye/ocr-node porque
// junta las cajas por renglón con una regla fija (mezcla filas en hojas torcidas), no
// normaliza la entrada del reconocedor y no calcula el puntaje de las cajas.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import cvModulo from '@techstark/opencv-js';
import clipper from 'js-clipper';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MODELOS = join(AQUI, 'modelos');

// ---------------------------------------------------------------------------
// Opciones
// ---------------------------------------------------------------------------

export function leerOpciones(argv) {
  const o = {
    foto: null,
    det: join(MODELOS, 'ch_PP-OCRv4_det_mobile.onnx'),
    rec: join(MODELOS, 'latin_PP-OCRv5_rec_mobile.onnx'),
    dic: null,
    lado: 2000,
    umbral: 0.3,
    caja: 0,
    unclip: 1.5,
    margen: 0,
    unir: true,
    color: false,
    hilos: 0,
    dibujar: null,
    tiempos: false,
    probar: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--probar') o.probar = true;
    else if (a === '--det') o.det = resolve(v());
    else if (a === '--rec') o.rec = resolve(v());
    else if (a === '--dic') o.dic = resolve(v());
    else if (a === '--lado') o.lado = Number(v());
    else if (a === '--umbral') o.umbral = Number(v());
    else if (a === '--caja') o.caja = Number(v());
    else if (a === '--unclip') o.unclip = Number(v());
    else if (a === '--margen') o.margen = Number(v());
    else if (a === '--sin-unir') o.unir = false;
    else if (a === '--color') o.color = true;
    else if (a === '--hilos') o.hilos = Number(v());
    else if (a === '--dibujar') o.dibujar = resolve(v());
    else if (a === '--tiempos') o.tiempos = true;
    else if (a === '--depurar') o.depurar = true; // agrega "p" (puntaje de la caja) a cada texto; sólo para mirar
    else if (a.startsWith('--')) throw new Error(`opción desconocida: ${a}`);
    else o.foto = a;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Diccionario: desde archivo o desde los metadatos del ONNX (RapidOCR guarda la
// lista de caracteres en metadata_props con la clave "character").
// ---------------------------------------------------------------------------

function varint(b, p) {
  let r = 0;
  let s = 0;
  let byte;
  do {
    byte = b[p.i++];
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

/** Lista de caracteres del reconocedor: índice 0 = blanco CTC, i → chars[i-1]; termina en espacio. */
export function cargarDiccionario(o) {
  let lineas;
  if (o.dic) lineas = readFileSync(o.dic, 'utf8').split('\n');
  else {
    const m = metadatosOnnx(o.rec);
    if (!m.character) throw new Error(`el modelo ${o.rec} no trae diccionario embebido: pase --dic`);
    lineas = m.character.split('\n');
  }
  if (lineas.length && lineas[lineas.length - 1] === '') lineas.pop(); // salto final del archivo
  // RapidOCR/PaddleOCR agregan SIEMPRE el espacio al final (aunque el diccionario ya lo
  // tenga, como el latin v3): clases del modelo = caracteres + espacio + blanco.
  lineas.push(' ');
  return lineas;
}

// ---------------------------------------------------------------------------
// Foto → imagen de trabajo (gris max(R,G,B), tamaño múltiplo de 32)
// ---------------------------------------------------------------------------

async function prepararFoto(o) {
  const base = sharp(o.foto, { limitInputPixels: false }).rotate(); // aplica la orientación EXIF
  const meta = await base.metadata();
  let W = meta.width;
  let H = meta.height;
  if ((meta.orientation ?? 1) >= 5) [W, H] = [H, W];
  const esc = Math.min(1, o.lado / Math.max(W, H));
  const w = Math.max(32, Math.round((W * esc) / 32) * 32);
  const h = Math.max(32, Math.round((H * esc) / 32) * 32);
  // fit 'fill': estira ≤ 31 px por lado (nada) y así no hay bandas que corran las cajas.
  const { data } = await base.resize({ width: w, height: h, fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = w * h;
  const rgba = new Uint8Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const r = data[j];
    const g = data[j + 1];
    const b = data[j + 2];
    if (o.color) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
    } else {
      const m = r > g ? (r > b ? r : b) : g > b ? g : b;
      rgba[i * 4] = m;
      rgba[i * 4 + 1] = m;
      rgba[i * 4 + 2] = m;
    }
    rgba[i * 4 + 3] = 255;
  }
  return { ancho: W, alto: H, w, h, rgba };
}

// ---------------------------------------------------------------------------
// OpenCV (WASM): se inicializa solo, hay que esperarlo la primera vez.
// ---------------------------------------------------------------------------

// OJO: el módulo de Emscripten tiene un método `then` (no es una Promise real) y si
// se lo resuelve/devuelve dentro de una promesa, el motor lo "adopta" sin fin y el
// proceso se cuelga. Por eso acá se espera con una promesa VACÍA y `cv` se usa
// siempre como la constante del módulo, nunca como valor de una promesa.
const cv = cvModulo;
let cvEsperaPromesa = null;
function esperarCv() {
  if (!cvEsperaPromesa) {
    cvEsperaPromesa =
      typeof cv.Mat === 'function'
        ? Promise.resolve()
        : new Promise((listo) => {
            cv.then(() => listo()); // Emscripten llama a `then` al terminar de inicializar el WASM
          });
  }
  return cvEsperaPromesa;
}

// ---------------------------------------------------------------------------
// Geometría de cajas (puntos [x, y]; caja = [arriba-izq, arriba-der, abajo-der, abajo-izq])
// ---------------------------------------------------------------------------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Rectángulo mínimo girado de un contorno (getMiniBoxes de PaddleOCR). */
function rectMinimo(cv, cnt) {
  const r = cv.minAreaRect(cnt);
  const th = (r.angle * Math.PI) / 180;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const cx = r.center.x;
  const cy = r.center.y;
  const dx = r.size.width / 2;
  const dy = r.size.height / 2;
  const pts = [
    [cx - dx * cs + dy * sn, cy - dx * sn - dy * cs],
    [cx + dx * cs + dy * sn, cy + dx * sn - dy * cs],
    [cx + dx * cs - dy * sn, cy + dx * sn + dy * cs],
    [cx - dx * cs - dy * sn, cy - dx * sn + dy * cs],
  ].sort((a, b) => a[0] - b[0]);
  const [i1, i4] = pts[1][1] > pts[0][1] ? [0, 1] : [1, 0];
  const [i2, i3] = pts[3][1] > pts[2][1] ? [2, 3] : [3, 2];
  return { puntos: [pts[i1], pts[i2], pts[i3], pts[i4]], lado: Math.min(r.size.width, r.size.height) };
}

function areaPoligono(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][1] * p[i][0] - p[j][0] * p[i][1];
  return a / 2;
}

function perimetro(p) {
  let s = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += dist(p[i], p[j]);
  return s;
}

/** Agranda el contorno (unclip de DB): la red predice el texto "encogido". */
function desclipar(puntos, ratio) {
  const area = Math.abs(areaPoligono(puntos));
  const per = perimetro(puntos);
  if (per === 0) return [];
  const off = new clipper.ClipperOffset();
  off.AddPath(
    puntos.map(([X, Y]) => ({ X, Y })),
    clipper.JoinType.jtRound,
    clipper.EndType.etClosedPolygon,
  );
  const out = [];
  off.Execute(out, (area * ratio) / per);
  return out[0] ? out[0].map((p) => [p.X, p.Y]) : [];
}

/** Media del mapa de probabilidad dentro del rectángulo de la caja (box_score_fast). */
function puntajeCaja(prob, mw, mh, puntos) {
  const xs = puntos.map((p) => p[0]);
  const ys = puntos.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(mw - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(mh - 1, Math.ceil(Math.max(...ys)));
  let s = 0;
  let k = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) (s += prob[y * mw + x]), k++;
  return k ? s / k : 0;
}

/** Mapa de probabilidad → cajas [{box, puntaje}] en píxeles del mapa (postproceso DB de PaddleOCR). */
function cajasDesdeMapa(cv, prob, mw, mh, o) {
  const bin = new cv.Mat(mh, mw, cv.CV_8UC1);
  const d = bin.data;
  for (let i = 0; i < mw * mh; i++) d[i] = prob[i] > o.umbral ? 255 : 0;
  const contornos = new cv.MatVector();
  const jerarquia = new cv.Mat();
  cv.findContours(bin, contornos, jerarquia, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  const cajas = [];
  for (let i = 0; i < contornos.size(); i++) {
    const cnt = contornos.get(i);
    const r = rectMinimo(cv, cnt);
    cnt.delete();
    if (r.lado < 3) continue;
    const puntaje = puntajeCaja(prob, mw, mh, r.puntos);
    if (puntaje < o.caja) continue;
    const ex = desclipar(r.puntos, o.unclip);
    if (ex.length < 3) continue;
    const m = cv.matFromArray(ex.length, 1, cv.CV_32SC2, ex.flat().map(Math.round));
    const r2 = rectMinimo(cv, m);
    m.delete();
    if (r2.lado < 5) continue;
    cajas.push({ box: r2.puntos, puntaje });
  }
  bin.delete();
  contornos.delete();
  jerarquia.delete();
  return cajas;
}

/**
 * Pega las cajitas de 1–2 caracteres a la caja vecina de la derecha en el mismo
 * renglón. Sueltas, el reconocedor las lee como basura ("DE", "e", "6") y el
 * signo "-" de los importes negativos se pierde; pegadas, el número llega con
 * su signo ("- 114,46"), que es lo que devuelve la Mac y lo que el parser espera.
 */
function unirCajitas(cv, cajas) {
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
      const pts = [...a.box, ...b.box];
      const m = cv.matFromArray(8, 1, cv.CV_32FC2, pts.flat());
      const r = rectMinimo(cv, m);
      m.delete();
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

/** Recorte enderezado de una caja (getRotateCropImage de PaddleOCR); RGBA. */
function recortar(cv, src, puntos, margen) {
  let p = puntos;
  if (margen > 0) {
    const [tl, tr, br, bl] = puntos;
    const alto = (dist(tl, bl) + dist(tr, br)) / 2;
    const L = dist(tl, tr) || 1;
    const u = [((tr[0] - tl[0]) / L) * margen * alto, ((tr[1] - tl[1]) / L) * margen * alto];
    p = [
      [tl[0] - u[0], tl[1] - u[1]],
      [tr[0] + u[0], tr[1] + u[1]],
      [br[0] + u[0], br[1] + u[1]],
      [bl[0] - u[0], bl[1] - u[1]],
    ];
  }
  const w = Math.floor(Math.max(dist(p[0], p[1]), dist(p[2], p[3])));
  const h = Math.floor(Math.max(dist(p[0], p[3]), dist(p[1], p[2])));
  if (w < 2 || h < 2) return null;
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, p.flat());
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  let fin = dst;
  if (h / w >= 1.5) {
    // texto vertical: se gira 90°
    const rot = new cv.Mat();
    const M2 = cv.getRotationMatrix2D(new cv.Point(dst.cols / 2, dst.cols / 2), 90, 1);
    cv.warpAffine(dst, rot, M2, new cv.Size(dst.rows, dst.cols), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    M2.delete();
    dst.delete();
    fin = rot;
  }
  const out = { data: new Uint8Array(fin.data), width: fin.cols, height: fin.rows };
  fin.delete();
  srcTri.delete();
  dstTri.delete();
  M.delete();
  return out;
}

// ---------------------------------------------------------------------------
// Detección (DB)
// ---------------------------------------------------------------------------

const MEDIA_DET = [0.485, 0.456, 0.406]; // PaddleOCR aplica estas medias sobre la imagen BGR
const DESVIO_DET = [0.229, 0.224, 0.225];

async function detectar(sesion, img, o) {
  const { w, h, rgba } = img;
  const n = w * h;
  const entrada = new Float32Array(3 * n);
  // canal 0 = B, 1 = G, 2 = R (orden de PaddleOCR)
  for (let i = 0; i < n; i++) {
    entrada[i] = (rgba[i * 4 + 2] / 255 - MEDIA_DET[0]) / DESVIO_DET[0];
    entrada[n + i] = (rgba[i * 4 + 1] / 255 - MEDIA_DET[1]) / DESVIO_DET[1];
    entrada[2 * n + i] = (rgba[i * 4] / 255 - MEDIA_DET[2]) / DESVIO_DET[2];
  }
  const salida = await sesion.run({ [sesion.inputNames[0]]: new Tensor('float32', entrada, [1, 3, h, w]) });
  const mapa = salida[sesion.outputNames[0]];
  const mh = mapa.dims[2];
  const mw = mapa.dims[3];
  await esperarCv();
  let cajas = cajasDesdeMapa(cv, mapa.data, mw, mh, o);
  // El mapa sale del tamaño de la entrada; por las dudas, se escala.
  const rx = w / mw;
  const ry = h / mh;
  if (rx !== 1 || ry !== 1) for (const c of cajas) c.box = c.box.map(([x, y]) => [x * rx, y * ry]);
  if (o.unir) cajas = unirCajitas(cv, cajas);
  const src = cv.matFromImageData({ data: rgba, width: w, height: h });
  for (const c of cajas) c.image = recortar(cv, src, c.box, o.margen);
  src.delete();
  return cajas;
}

// ---------------------------------------------------------------------------
// Reconocimiento (CRNN + CTC)
// ---------------------------------------------------------------------------

const ALTO_REC = 48;

async function reconocer(sesion, caja, dic) {
  const img = caja.image; // RGBA del recorte enderezado
  if (!img || img.width < 2 || img.height < 2) return null;
  const w = Math.max(8, Math.round((ALTO_REC * img.width) / img.height));
  const { data } = await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize({ width: w, height: ALTO_REC, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = w * ALTO_REC;
  const entrada = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    entrada[i] = (data[i * 4 + 2] / 255 - 0.5) / 0.5;
    entrada[n + i] = (data[i * 4 + 1] / 255 - 0.5) / 0.5;
    entrada[2 * n + i] = (data[i * 4] / 255 - 0.5) / 0.5;
  }
  const salida = await sesion.run({ [sesion.inputNames[0]]: new Tensor('float32', entrada, [1, 3, ALTO_REC, w]) });
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

export async function leerHoja(o) {
  const t0 = performance.now();
  const opcionesOrt = o.hilos > 0 ? { intraOpNumThreads: o.hilos, interOpNumThreads: 1 } : {};
  const [det, rec] = await Promise.all([InferenceSession.create(o.det, opcionesOrt), InferenceSession.create(o.rec, opcionesOrt), esperarCv()]);
  const dic = cargarDiccionario(o);
  const t1 = performance.now();
  const img = await prepararFoto(o);
  const t2 = performance.now();
  const cajas = await detectar(det, img, o);
  const t3 = performance.now();
  const textos = [];
  let clasesVistas = null;
  for (const c of cajas) {
    const r = await reconocer(rec, c, dic);
    if (!r || !r.texto.trim()) continue;
    clasesVistas = r.clases;
    const [tl, , br, bl] = c.box; // [arriba-izq, arriba-der, abajo-der, abajo-izq]
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
  if (o.dibujar) {
    const poligonos = cajas
      .map((c) => `<polygon points="${c.box.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="none" stroke="red" stroke-width="2"/>`)
      .join('');
    await sharp(Buffer.from(img.rgba.buffer), { raw: { width: img.w, height: img.h, channels: 4 } })
      .composite([{ input: Buffer.from(`<svg width="${img.w}" height="${img.h}">${poligonos}</svg>`), left: 0, top: 0 }])
      .png()
      .toFile(o.dibujar);
  }
  if (o.tiempos) {
    const ms = (a, b) => `${(b - a).toFixed(0)} ms`;
    process.stderr.write(
      `modelos ${ms(t0, t1)} · foto ${ms(t1, t2)} (${img.w}×${img.h}) · detección ${ms(t2, t3)} (${cajas.length} cajas) · reconocimiento ${ms(t3, t4)} (${textos.length} textos) · total sin carga ${ms(t1, t4)} · total ${ms(t0, t4)} · rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB\n`,
    );
  }
  await Promise.all([det.release(), rec.release()]);
  return { ancho: img.ancho, alto: img.alto, textos };
}

const esPrincipal = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (esPrincipal) {
  try {
    const o = leerOpciones(process.argv.slice(2));
    if (o.probar) {
      process.stdout.write('disponible\n');
      process.exit(0);
    }
    if (!o.foto) throw new Error('uso: paddle-ocr.mjs <foto> [opciones] | --probar');
    if (!existsSync(o.foto)) throw new Error(`no se pudo abrir la foto: ${o.foto}`);
    const lectura = await leerHoja(o);
    process.stdout.write(JSON.stringify(lectura) + '\n');
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
