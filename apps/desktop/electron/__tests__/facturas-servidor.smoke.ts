/**
 * Smoke de las rutas del teléfono para facturas de compra (`/lan/foto/…`).
 *
 *   cd apps/desktop && ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
 *     ./node_modules/tsx/dist/cli.mjs electron/__tests__/facturas-servidor.smoke.ts
 *
 * Usa una PuertaFotos falsa (sin servicio, sin base, sin Ollama):
 *  - la página sale con 200, sin caché y sin CORS, y su script compila;
 *  - la página trae los dos modos: input file (HTTP) y cámara guiada (HTTPS,
 *    getUserMedia sólo con isSecureContext); la cámara en sí no se puede
 *    probar acá: se prueba abriendo el enlace "Por internet" desde el teléfono;
 *  - token malo o función apagada → 404 "El enlace venció", indistinguibles;
 *  - lo que no es JPEG → 400; más de 12 MB → cortado sin llegar al servicio;
 *  - flujo hoja → hoja → quitar → cerrar → estado;
 *  - LanServer con `rutaExtra` atiende /lan/foto/ y sin ella sigue igual.
 */
import { request } from 'node:http';

import {
  atenderFotos,
  MAX_FOTO_BYTES,
  ServidorFotos,
  type PuertaFotos,
} from '../facturas/servidorFotos';
import { paginaTelefono } from '../facturas/paginaTelefono';
import { LanServer } from '../lan/LanServer';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const TOKEN = 'a'.repeat(32);
const TOKEN_OTRO = 'b'.repeat(32);
const silencio = { info: () => {}, warn: () => {}, error: () => {} };

interface PuertaFalsa extends PuertaFotos {
  encendida: boolean;
  fotos: Buffer[];
  cerradas: number;
  estado: string;
  leidas: number;
  fallarCon: Error | null;
  /** La foto "sale mal" (el servicio la rechaza) salvo que llegue con forzar. */
  fotoMala: string | null;
  forzadas: number;
  lento: boolean;
}

function puertaFalsa(conQuitar = true): PuertaFalsa {
  const p: PuertaFalsa = {
    encendida: true,
    fotos: [],
    cerradas: 0,
    estado: 'recibiendo',
    leidas: 0,
    fallarCon: null,
    fotoMala: null,
    forzadas: 0,
    lento: false,
    activo: () => p.encendida,
    validarToken: (t) => t === TOKEN,
    recibirFoto: async (_t, jpeg, opciones) => {
      if (p.fallarCon) throw p.fallarCon;
      if (opciones?.forzar) p.forzadas++;
      // Igual que FacturasError del servicio: un Error con `tipo: 'foto'`.
      else if (p.fotoMala) throw Object.assign(new Error(p.fotoMala), { tipo: 'foto' });
      p.fotos.push(jpeg);
      p.estado = 'recibiendo';
      return { hojas: p.fotos.length };
    },
    cerrarFactura: async () => {
      if (p.fotos.length === 0) throw new Error('No hay hojas para enviar');
      p.cerradas++;
      p.estado = 'en_cola';
      return { id: 'factura-1' };
    },
    estadoParaTelefono: () => ({
      factura:
        p.fotos.length === 0
          ? null
          : ({ estado: p.estado, hojas: p.fotos.length, hojasLeidas: p.leidas, error: null, lento: p.lento, rutaInterna: '/Users/x/secreto' } as never),
    }),
  };
  if (conQuitar) {
    p.quitarUltimaFoto = async () => {
      p.fotos.pop();
      return { hojas: p.fotos.length };
    };
  }
  return p;
}

/** JPEG mínimo creíble: cabecera FF D8 FF E0 + relleno + FF D9. */
function jpegFalso(bytes = 2048): Buffer {
  const b = Buffer.alloc(bytes, 0x11);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  b[bytes - 2] = 0xff; b[bytes - 1] = 0xd9;
  return b;
}

/** fetch acepta un Buffer como cuerpo; los tipos del DOM no lo saben. */
function cuerpo(b: Buffer): BodyInit {
  return b as unknown as BodyInit;
}

async function json(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Manda un cuerpo grande por trozos; devuelve el status o 'cortado' si la conexión se cayó. */
function subirGrande(port: number, ruta: string, totalBytes: number, declarar: boolean): Promise<number | 'cortado'> {
  return new Promise((resolve) => {
    let resuelto = false;
    const fin = (v: number | 'cortado'): void => {
      if (resuelto) return;
      resuelto = true;
      resolve(v);
    };
    const headers: Record<string, string | number> = { 'content-type': 'image/jpeg' };
    if (declarar) headers['content-length'] = totalBytes;
    const req = request({ host: '127.0.0.1', port, path: ruta, method: 'POST', headers, agent: false }, (res) => {
      res.resume();
      fin(res.statusCode ?? 0);
    });
    req.on('error', () => fin('cortado'));
    req.on('close', () => fin('cortado'));
    const trozo = Buffer.alloc(1024 * 1024, 0x22);
    trozo[0] = 0xff; trozo[1] = 0xd8;
    let enviado = 0;
    const seguir = (): void => {
      while (enviado < totalBytes) {
        if (req.destroyed) return;
        const n = Math.min(trozo.length, totalBytes - enviado);
        enviado += n;
        if (!req.write(n === trozo.length ? trozo : trozo.subarray(0, n))) {
          req.once('drain', seguir);
          return;
        }
      }
      req.end();
    };
    seguir();
    setTimeout(() => { req.destroy(); fin('cortado'); }, 15_000).unref();
  });
}

async function partePagina(): Promise<void> {
  console.log('\n[1] La página del teléfono');
  const html = paginaTelefono();
  check('trae el botón "Sacar foto de la hoja"', html.includes('Sacar foto de la hoja'));
  check('abre la cámara con <input type=file capture>', /<input[^>]+type="file"[^>]+accept="image\/\*"[^>]+capture="environment"/.test(html));
  check('no pide nada a otro servidor', !/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html));
  check('no tutea', !/\b(sacá|tocá|enviá|esperá|podés|querés|tenés|probá|volvé|alejate|acercate|acercá|alejá)\b/i.test(html));
  check('pesa menos de 60 KB', Buffer.byteLength(html) < 60_000, `${Buffer.byteLength(html)} bytes`);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
  // Los dos modos conviven en el mismo documento: el input (HTTP, Wi-Fi) y la cámara guiada (HTTPS, túnel).
  check('trae el botón "Abrir la cámara" (modo guiado) además del input', html.includes('Abrir la cámara') && /<button[^>]+id="btn-camara"[^>]+hidden/.test(html));
  check('getUserMedia sólo en contexto seguro (isSecureContext)', script.includes('getUserMedia') && /isSecureContext\s*&&\s*navigator\.mediaDevices/.test(script));
  check('el <video> lleva playsinline y muted (iPhone)', /<video[^>]+playsinline[^>]+muted/.test(html));
  check('sin cámara: cae al input sin recargar', /function sinCamara/.test(script) && /guiada = false/.test(script) && !/location\.reload/.test(script));
  for (const texto of ['Encuadre la hoja completa dentro del recuadro', 'Listo. Toque para capturar', 'Falta luz', 'Demasiado reflejo',
    'Enfocando…', 'Aléjese un poco', 'Acerque la hoja hasta llenar el recuadro', 'Ubique la hoja dentro del recuadro', '¿Capturar igual?', 'Linterna']) {
    check(`guía: texto "${texto}"`, html.includes(texto));
  }
  check('guía: analiza cada 300 ms sobre 240 px, promedio de 3 muestras', /ANALISIS_MS = 300/.test(script) && /LADO_VIVO = 240/.test(script) && /cam\.nitidez\.length > 3/.test(script));
  check('guía: umbrales (luz 80, reflejo 10 %, nitidez 120, hoja 25 %, llenado 85 %)', /LUZ_MINIMA = 80/.test(script) && /REFLEJO_MAXIMO = 0\.1\b/.test(script) && /NITIDEZ_VIVO = 120/.test(script) && /HOJA_MINIMA = 0\.25/.test(script) && /LLENADO_MINIMO = 0\.85/.test(script));
  check('captura: recorte al recuadro + 4 %, JPEG 0,9, lado mayor 2400 px', /MARGEN_RECORTE = 0\.04/.test(script) && /CALIDAD_CAPTURA = 0\.9\b/.test(script) && /LADO_CAPTURA = 2400/.test(script));
  check('captura: entra por el mismo camino que el input (procesar)', script.includes('procesar([blob], true)') && script.includes('procesar(cola, false)'));
  check('captura: en rojo pide confirmar, nunca bloquea', /cam\.clase === 'rojo' && !window\.confirm/.test(script));
  check('recuadro A4 vertical (210 × 297)', /210 \/ 297/.test(script) && /297 \/ 210/.test(script));
  check('botones de la cámara de 56 px o más', /\.cam-btn\{min-height:56px;min-width:56px/.test(html) && /\.cam-captura\{[^}]*width:78px;height:78px/.test(html));
  let compila = false;
  let detalle = '';
  try {
    new Function(script);
    compila = script.length > 1000;
  } catch (err) {
    detalle = String(err);
  }
  check('el script en línea compila', compila, detalle);
  check('el script es ES5 (sin let/const/=>/template)', !/\b(let|const)\s|=>|`/.test(script));
  for (const texto of ['Enviar factura (', 'Quitar', 'Enviando hoja ', 'Leyendo hoja ', 'Lista para revisar en la PC', 'Cargar otra factura']) {
    check(`texto "${texto.trim()}"`, html.includes(texto));
  }
  check('reduce a 2000 px y JPEG 0,88', /LADO = 2000/.test(script) && /CALIDAD = 0\.88/.test(script));
  check('sondea cada 3 s', /SONDEO_MS = 3000/.test(script));
  for (const texto of ['Repetir la foto', 'Usar igual', 'puede demorar unos minutos', 'muy oscura', 'muy borrosa']) {
    check(`texto "${texto}"`, html.includes(texto));
  }
  check('foto mala: atiende el 422 FOTO y reenvía con ?forzar=1', /st === 422 && r && r\.code === 'FOTO'/.test(script) && script.includes("'?forzar=1'"));
  check('control en el teléfono: brillo y nitidez con umbrales conservadores', /BRILLO_MINIMO = 45/.test(script) && /NITIDEZ_MINIMA = 12/.test(script) && /LADO_CONTROL = 800/.test(script));
}

async function parteServidor(): Promise<void> {
  console.log('\n[2] ServidorFotos: página, token, tamaño, flujo');
  const puerta = puertaFalsa();
  const servidor = new ServidorFotos({ puerta, port: 0, host: '127.0.0.1', log: silencio });
  await servidor.start();
  const port = servidor.puerto ?? 0;
  check('escucha en un puerto', port > 0, String(port));
  const base = `http://127.0.0.1:${port}/lan/foto/${TOKEN}`;

  // --- página
  const pag = await fetch(base);
  const cuerpoPag = await pag.text();
  check('GET página → 200 text/html', pag.status === 200 && (pag.headers.get('content-type') ?? '').startsWith('text/html'), String(pag.status));
  check('la página es la del teléfono', cuerpoPag.includes('Sacar foto de la hoja'));
  check('cache-control: no-store', pag.headers.get('cache-control') === 'no-store', String(pag.headers.get('cache-control')));
  check('sin CORS abierto', pag.headers.get('access-control-allow-origin') === null);
  const csp = pag.headers.get('content-security-policy') ?? '';
  check('con content-security-policy', csp.includes("default-src 'none'"));
  const directiva = (nombre: string): string => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${nombre} `)) ?? '';
  check('CSP: blob: sólo en img-src y media-src (video en vivo), no en script ni connect',
    directiva('img-src').includes('blob:') && directiva('media-src').includes('blob:') &&
      !directiva('script-src').includes('blob:') && !directiva('connect-src').includes('blob:') && directiva('connect-src') === "connect-src 'self'",
    csp);
  check('la página de la cámara se sirve con los dos modos', cuerpoPag.includes('Abrir la cámara') && cuerpoPag.includes('capture="environment"'));
  check('el token no viaja escrito en el HTML', !cuerpoPag.includes(TOKEN));
  const conBarra = await fetch(`${base}/`);
  check('GET página con barra final → 200', conBarra.status === 200, String(conBarra.status));
  await conBarra.text();

  // --- token malo
  for (const [nombre, malo] of [['desconocido', TOKEN_OTRO], ['mal formado', 'xyz'], ['con mayúsculas', 'A'.repeat(32)], ['con ..', '..%2F..%2Fetc']] as const) {
    const r = await fetch(`http://127.0.0.1:${port}/lan/foto/${malo}`);
    const t = await r.text();
    check(`token ${nombre} → 404 "El enlace venció"`, r.status === 404 && t.includes('El enlace venció') && !t.includes('Sacar foto'), String(r.status));
  }
  const malPost = await fetch(`http://127.0.0.1:${port}/lan/foto/${TOKEN_OTRO}/hoja`, { method: 'POST', body: cuerpo(jpegFalso()) });
  const malPostJson = await json(malPost);
  check('POST hoja con token malo → 404 y no llega al servicio', malPost.status === 404 && malPostJson?.ok === false && puerta.fotos.length === 0, String(malPost.status));
  check('el 404 tampoco se cachea ni abre CORS', malPost.headers.get('cache-control') === 'no-store' && malPost.headers.get('access-control-allow-origin') === null);
  const malEstado = await fetch(`http://127.0.0.1:${port}/lan/foto/${TOKEN_OTRO}/estado`);
  check('GET estado con token malo → 404', malEstado.status === 404, String(malEstado.status));
  await malEstado.text();

  // --- nada fuera de /lan/foto/
  for (const ruta of ['/', '/lan/ping', '/lan/rpc', '/lan/foto', '/index.html']) {
    const r = await fetch(`http://127.0.0.1:${port}${ruta}`);
    await r.text();
    check(`${ruta} → 404`, r.status === 404, String(r.status));
  }
  const opt = await fetch(base, { method: 'OPTIONS' });
  await opt.text();
  check('OPTIONS no abre CORS', opt.status === 405 && opt.headers.get('access-control-allow-origin') === null, String(opt.status));
  const rara = await fetch(`${base}/otra`);
  await rara.text();
  const profunda = await fetch(`${base}/hoja/1`);
  await profunda.text();
  check('acción desconocida → 404', rara.status === 404 && profunda.status === 404, `${rara.status}/${profunda.status}`);
  const getHoja = await fetch(`${base}/hoja`);
  await getHoja.text();
  check('GET sobre /hoja → 405', getHoja.status === 405, String(getHoja.status));

  // --- estado sin factura
  const e0 = await json(await fetch(`${base}/estado`));
  check('estado sin factura → factura null', e0?.ok === true && e0.factura === null, JSON.stringify(e0));

  // --- no-JPEG
  const png = await fetch(`${base}/hoja`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: cuerpo(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')) });
  const pngJson = await json(png);
  check('PNG disfrazado → 400', png.status === 400 && pngJson?.ok === false && puerta.fotos.length === 0, `${png.status} ${JSON.stringify(pngJson)}`);
  const vacio = await fetch(`${base}/hoja`, { method: 'POST' });
  await vacio.text();
  check('cuerpo vacío → 400', vacio.status === 400 && puerta.fotos.length === 0, String(vacio.status));

  // --- más de 12 MB
  const declarado = await subirGrande(port, `/lan/foto/${TOKEN}/hoja`, MAX_FOTO_BYTES + 1, true);
  check('13 MB declarados en content-length → 413 o conexión cortada', declarado === 413 || declarado === 'cortado', String(declarado));
  const sinDeclarar = await subirGrande(port, `/lan/foto/${TOKEN}/hoja`, 13 * 1024 * 1024, false);
  check('13 MB por trozos (sin content-length) → 413 o conexión cortada', sinDeclarar === 413 || sinDeclarar === 'cortado', String(sinDeclarar));
  check('ninguna foto grande llegó al servicio', puerta.fotos.length === 0, String(puerta.fotos.length));
  const justo = await subirGrande(port, `/lan/foto/${TOKEN}/hoja`, MAX_FOTO_BYTES, true);
  check('12 MB justos → 200', justo === 200 && puerta.fotos.length === 1 && puerta.fotos[0]?.length === MAX_FOTO_BYTES, String(justo));
  puerta.fotos.length = 0;
  const sinTokenGrande = await subirGrande(port, `/lan/foto/${TOKEN_OTRO}/hoja`, 13 * 1024 * 1024, false);
  check('13 MB con token malo → 404 o cortado, sin leer el cuerpo', sinTokenGrande === 404 || sinTokenGrande === 'cortado', String(sinTokenGrande));

  // --- flujo
  const h1 = await json(await fetch(`${base}/hoja`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: cuerpo(jpegFalso(3000)) }));
  const h2 = await json(await fetch(`${base}/hoja`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: cuerpo(jpegFalso(4000)) }));
  const h3 = await json(await fetch(`${base}/hoja`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: cuerpo(jpegFalso(5000)) }));
  check('tres hojas → hojas 1, 2, 3', h1?.hojas === 1 && h2?.hojas === 2 && h3?.hojas === 3, `${h1?.hojas}/${h2?.hojas}/${h3?.hojas}`);
  check('el servicio recibió los bytes tal cual', puerta.fotos[0]?.length === 3000 && puerta.fotos[1]?.equals(jpegFalso(4000)) === true);
  const q = await json(await fetch(`${base}/quitar`, { method: 'POST' }));
  check('quitar → saca la última', q?.ok === true && q.hojas === 2 && puerta.fotos.length === 2, JSON.stringify(q));
  const e1 = await json(await fetch(`${base}/estado`));
  const f1 = e1?.factura as Record<string, unknown> | null;
  check('estado recibiendo con 2 hojas', f1?.estado === 'recibiendo' && f1.hojas === 2 && e1?.puedeQuitar === true, JSON.stringify(e1));
  check('el estado no deja salir campos extra del servicio', !JSON.stringify(e1).includes('secreto') && Object.keys(f1 ?? {}).sort().join() === 'error,estado,hojas,hojasLeidas,lento' && f1?.lento === false, JSON.stringify(e1));
  puerta.lento = true;
  const eLento = (await json(await fetch(`${base}/estado`)))?.factura as Record<string, unknown> | null;
  check('estado: avisa cuando se lee con «Mejorar lectura» (lento)', eLento?.lento === true, JSON.stringify(eLento));
  puerta.lento = false;

  // Foto mala: la PC la leyó y no sirve. 422 FOTO con el motivo, la hoja NO se agrega.
  const MOTIVO =
    'La foto salió borrosa u oscura. Por favor, vuelva a sacarla con más luz y sin mover el teléfono. ' +
    'Falta parte de la hoja a la izquierda. Por favor, saque la foto de más lejos para que entre la hoja completa.';
  puerta.fotoMala = MOTIVO;
  const mala = await fetch(`${base}/hoja`, { method: 'POST', body: cuerpo(jpegFalso(2500)) });
  const malaJson = await json(mala);
  check('foto mala → 422 con code FOTO y el motivo entero', mala.status === 422 && malaJson?.ok === false && malaJson.code === 'FOTO' && malaJson.message === MOTIVO, `${mala.status} ${JSON.stringify(malaJson)}`);
  check('la hoja mala NO se agregó', puerta.fotos.length === 2 && puerta.forzadas === 0);
  const igual = await fetch(`${base}/hoja?forzar=1`, { method: 'POST', body: cuerpo(jpegFalso(2500)) });
  const igualJson = await json(igual);
  check('«Usar igual» (?forzar=1) → se acepta', igual.status === 200 && igualJson?.hojas === 3 && puerta.forzadas === 1 && puerta.fotos.length === 3, `${igual.status} ${JSON.stringify(igualJson)}`);
  const noForzar = await fetch(`${base}/hoja?forzar=0&x=forzar=1x`, { method: 'POST', body: cuerpo(jpegFalso(2500)) });
  await noForzar.text();
  check('sólo forzar=1 exacto fuerza', noForzar.status === 422 && puerta.forzadas === 1);
  puerta.fotoMala = '/Users/x/secreto\nsalto';
  const conRuta = await json(await fetch(`${base}/hoja`, { method: 'POST', body: cuerpo(jpegFalso(2500)) }));
  check('un motivo con rutas no sale: mensaje genérico', conRuta?.code === 'FOTO' && !String(conRuta.message).includes('/Users'), JSON.stringify(conRuta));
  puerta.fotoMala = null;
  await fetch(`${base}/quitar`, { method: 'POST' });

  puerta.fallarCon = new Error('La factura ya tiene 12 hojas');
  const lleno = await fetch(`${base}/hoja`, { method: 'POST', body: cuerpo(jpegFalso()) });
  const llenoJson = await json(lleno);
  check('error del servicio pensado para el usuario → 400 con su mensaje', lleno.status === 400 && llenoJson?.message === 'La factura ya tiene 12 hojas', JSON.stringify(llenoJson));
  puerta.fallarCon = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/x/facturas/hoja-1.jpg'"), { code: 'ENOENT' });
  const roto = await fetch(`${base}/hoja`, { method: 'POST', body: cuerpo(jpegFalso()) });
  const rotoTexto = await roto.text();
  check('error del sistema → mensaje genérico, sin rutas de la PC', roto.status === 400 && !rotoTexto.includes('/Users') && !rotoTexto.includes('ENOENT'), rotoTexto);
  puerta.fallarCon = null;

  const c = await json(await fetch(`${base}/cerrar`, { method: 'POST' }));
  check('cerrar → id de la factura', c?.ok === true && c.id === 'factura-1' && puerta.cerradas === 1, JSON.stringify(c));
  const e2 = (await json(await fetch(`${base}/estado`)))?.factura as Record<string, unknown> | null;
  check('estado en_cola', e2?.estado === 'en_cola' && e2.hojas === 2 && e2.hojasLeidas === 0, JSON.stringify(e2));
  puerta.estado = 'leyendo';
  puerta.leidas = 1;
  const e3 = (await json(await fetch(`${base}/estado`)))?.factura as Record<string, unknown> | null;
  check('estado leyendo, 1 de 2 leída', e3?.estado === 'leyendo' && e3.hojasLeidas === 1, JSON.stringify(e3));
  puerta.estado = 'lista';
  puerta.leidas = 2;
  const e4 = (await json(await fetch(`${base}/estado`)))?.factura as Record<string, unknown> | null;
  check('estado lista', e4?.estado === 'lista' && e4.hojasLeidas === 2 && e4.error === null, JSON.stringify(e4));

  // --- función apagada: igual que un token malo
  puerta.encendida = false;
  const ap1 = await fetch(base);
  const ap1t = await ap1.text();
  const ap2 = await fetch(`${base}/hoja`, { method: 'POST', body: cuerpo(jpegFalso()) });
  await ap2.text();
  const ap3 = await fetch(`${base}/estado`);
  await ap3.text();
  const ap4 = await fetch(`${base}/cerrar`, { method: 'POST' });
  await ap4.text();
  check('función apagada: página → 404 "El enlace venció"', ap1.status === 404 && ap1t.includes('El enlace venció'), String(ap1.status));
  check('función apagada: hoja, estado y cerrar → 404', ap2.status === 404 && ap3.status === 404 && ap4.status === 404, `${ap2.status}/${ap3.status}/${ap4.status}`);
  check('función apagada: nada llegó al servicio', puerta.fotos.length === 2 && puerta.cerradas === 1);
  puerta.encendida = true;

  await servidor.stop();
  check('stop: deja de escuchar', servidor.puerto === null);
  let sigue = false;
  try {
    await fetch(base, { signal: AbortSignal.timeout(1500) });
    sigue = true;
  } catch {
    // no contesta: dejó de escuchar
  }
  check('stop: el puerto ya no contesta', !sigue);

  // --- servicio sin quitarUltimaFoto
  const p2 = puertaFalsa(false);
  const s2 = new ServidorFotos({ puerta: p2, port: 0, host: '127.0.0.1', log: silencio });
  await s2.start();
  const b2 = `http://127.0.0.1:${s2.puerto}/lan/foto/${TOKEN}`;
  await (await fetch(`${b2}/hoja`, { method: 'POST', body: cuerpo(jpegFalso()) })).text();
  const q2 = await fetch(`${b2}/quitar`, { method: 'POST' });
  await q2.text();
  const est2 = await json(await fetch(`${b2}/estado`));
  check('sin quitarUltimaFoto: /quitar → 404 y puedeQuitar false', q2.status === 404 && est2?.puedeQuitar === false && p2.fotos.length === 1, `${q2.status} ${JSON.stringify(est2)}`);
  await s2.stop();
}

async function parteLan(): Promise<void> {
  console.log('\n[3] LanServer: rutaExtra');
  const puerta = puertaFalsa();
  const handlers = { 'articles:list': async () => ({ ok: true as const, data: { canal: 'articles:list' } }) };

  const PORT = 47761;
  const con = new LanServer({ handlers, port: PORT, token: '123456', log: silencio, rutaExtra: atenderFotos(puerta, silencio) });
  await con.start();
  const u = `http://127.0.0.1:${PORT}`;
  const pag = await fetch(`${u}/lan/foto/${TOKEN}`);
  const pagT = await pag.text();
  check('con rutaExtra: GET /lan/foto/<token> → la página', pag.status === 200 && pagT.includes('Sacar foto de la hoja'), String(pag.status));
  check('con rutaExtra: la página sale sin CORS', pag.headers.get('access-control-allow-origin') === null);
  const hoja = await json(await fetch(`${u}/lan/foto/${TOKEN}/hoja`, { method: 'POST', body: cuerpo(jpegFalso()) }));
  check('con rutaExtra: POST hoja llega al servicio', hoja?.ok === true && hoja.hojas === 1 && puerta.fotos.length === 1, JSON.stringify(hoja));
  const malo = await fetch(`${u}/lan/foto/${TOKEN_OTRO}`);
  const maloT = await malo.text();
  check('con rutaExtra: token malo → 404 "El enlace venció"', malo.status === 404 && maloT.includes('El enlace venció'), String(malo.status));
  const ping = await json(await fetch(`${u}/lan/ping`));
  check('con rutaExtra: /lan/ping sigue igual', ping?.ok === true, JSON.stringify(ping));
  const rpc = await fetch(`${u}/lan/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'articles:list', token: '123456' }) });
  const rpcJ = await json(rpc);
  check('con rutaExtra: /lan/rpc sigue igual', rpc.status === 200 && rpcJ?.ok === true, String(rpc.status));
  const sinPin = await fetch(`${u}/lan/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'articles:list', token: '000000' }) });
  await sinPin.text();
  check('con rutaExtra: /lan/rpc sigue pidiendo el PIN', sinPin.status === 401, String(sinPin.status));
  const parecida = await fetch(`${u}/lan/fotos/${TOKEN}`);
  await parecida.text();
  check('con rutaExtra: /lan/fotos/… (otro prefijo) no entra', parecida.status === 404 && puerta.fotos.length === 1, String(parecida.status));
  await con.stop();

  const PORT2 = 47762;
  const sin = new LanServer({ handlers, port: PORT2, token: '123456', log: silencio });
  await sin.start();
  const u2 = `http://127.0.0.1:${PORT2}`;
  const r = await fetch(`${u2}/lan/foto/${TOKEN}`);
  const rj = await json(r);
  check('sin rutaExtra: GET /lan/foto/<token> → 404 "Ruta inexistente"', r.status === 404 && rj?.message === 'Ruta inexistente', `${r.status} ${JSON.stringify(rj)}`);
  const r2 = await fetch(`${u2}/lan/foto/${TOKEN}/hoja`, { method: 'POST', body: cuerpo(jpegFalso()) });
  await r2.text();
  check('sin rutaExtra: POST hoja → 404', r2.status === 404, String(r2.status));
  const ping2 = await json(await fetch(`${u2}/lan/ping`));
  check('sin rutaExtra: /lan/ping contesta', ping2?.ok === true);
  await sin.stop();
}

async function main(): Promise<void> {
  await partePagina();
  await parteServidor();
  await parteLan();
  if (failures > 0) {
    console.error(`\nTEST FACTURAS SERVIDOR FALLÓ — ${failures} check(s) con error.\n`);
    process.exit(1);
  }
  console.log('\n✅ TODO OK — TEST FACTURAS SERVIDOR\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ Excepción durante el test del servidor de fotos:', err);
  process.exit(1);
});
