/**
 * Facturas por teléfono — lector PaddleOCR (native/ocr-paddle/leer.mjs) y la
 * cadena de lectores de LectorSistema.
 *  (a) leer.mjs corre con el Electron del repo como Node (ELECTRON_RUN_AS_NODE)
 *      sobre dos fotos reales (tools/ocr-facturas/muestras) y, con el pipeline de
 *      la app (interpretarLectura → armarRenglones → parsearTexto), da los
 *      renglones y la suma esperados en menos de 15 s por hoja.
 *  (b) LectorSistema prueba los lectores en orden, anota cuál leyó (`lector`) y
 *      avisa claro cuando ninguno pudo.
 *  (c) la lista de lectores de cada plataforma.
 *   pnpm test:facturas-paddle
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  LectorSistema,
  armarRenglones,
  interpretarLectura,
  lectoresPorPlataforma,
  programaDeLector,
  type LectorDeHoja,
  type LecturaSistema,
} from '../facturas/lectorSistema';
import { parsearTexto } from '../facturas/parser';

const here = dirname(fileURLToPath(import.meta.url));
const dirDesktop = join(here, '..', '..');
const dirNative = join(dirDesktop, 'native');
const dirMuestras = join(dirDesktop, '..', '..', 'tools', 'ocr-facturas', 'muestras');
const script = join(dirNative, 'ocr-paddle', 'leer.mjs');
const ejecutar = promisify(execFile);

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${detalle ? `  → ${detalle}` : ''}`);
}

/** Ejecutable de Electron del repo (en Node, `require('electron')` devuelve su ruta). */
function electronDelRepo(): string {
  try {
    const e = createRequire(import.meta.url)('electron') as unknown;
    if (typeof e === 'string' && existsSync(e)) return e;
  } catch {
    /* sin el paquete electron se usa el Node actual */
  }
  return process.execPath;
}
const electron = electronDelRepo();
const envNode = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

/** JPEG mínimo (sólo la cabecera): alcanza para pasar el control de LectorSistema. */
const JPEG_MINIMO = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** Un JPEG con sólo un segmento EXIF que dice la orientación `o`. */
function jpegConOrientacion(o: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 a continuación
  tiff.writeUInt16BE(1, 8); // una entrada
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(o, 18);
  tiff.writeUInt32BE(0, 22); // sin IFD1
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const cabecera = Buffer.from([0xff, 0xe1, 0, 0]);
  cabecera.writeUInt16BE(app1.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), cabecera, app1, Buffer.from([0xff, 0xd9])]);
}

function lecturaJson(cajas: number): string {
  const textos = Array.from({ length: cajas }, (_, i) => ({ t: `texto ${i}`, x0: 0.1, y0: 0.1 + i * 0.05, x1: 0.5, y1: 0.1 + i * 0.05, h: 0.02, c: 0.9 }));
  return JSON.stringify({ ancho: 1000, alto: 1400, textos });
}

interface LectorFalso extends LectorDeHoja {
  llamadas: number;
  pruebas: number;
}
function falso(nombre: string, disponible: boolean, leer: (ruta: string) => Promise<string>): LectorFalso {
  const l: LectorFalso = {
    nombre,
    llamadas: 0,
    pruebas: 0,
    probar: async () => {
      l.pruebas++;
      return disponible;
    },
    leer: async (ruta) => {
      l.llamadas++;
      if (!existsSync(ruta)) throw new Error('la foto temporal no existe');
      return leer(ruta);
    },
  };
  return l;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

async function main(): Promise<void> {
  // --- 1. Piezas de leer.mjs (JavaScript puro) -------------------------------------
  {
    type Modulo = {
      orientacionExif(b: Buffer): number;
      orientar(g: Uint8Array, w: number, h: number, o: number): { g: Uint8Array; w: number; h: number };
      redimensionar(src: Uint8Array, wIn: number, hIn: number, wOut: number, hOut: number): Uint8Array;
      rectMinimo(puntos: number[][]): { puntos: number[][]; lado: number } | null;
      cargarDiccionario(ruta: string): string[];
    };
    const m = (await import(pathToFileURL(script).href)) as Modulo;
    check(m.orientacionExif(jpegConOrientacion(6)) === 6 && m.orientacionExif(jpegConOrientacion(8)) === 8, 'EXIF: lee la orientación 6 y 8');
    check(m.orientacionExif(JPEG_MINIMO) === 1 && m.orientacionExif(Buffer.from('no soy jpeg')) === 1 && m.orientacionExif(jpegConOrientacion(0)) === 1, 'EXIF: sin segmento, basura o valor inválido → 1');

    const img = new Uint8Array([1, 2, 3, 4, 5, 6]); // 3×2
    const g6 = m.orientar(img, 3, 2, 6);
    const g8 = m.orientar(img, 3, 2, 8);
    const g3 = m.orientar(img, 3, 2, 3);
    check(g6.w === 2 && g6.h === 3 && Array.from(g6.g).join() === '4,1,5,2,6,3', 'orientar 6 (90° horario)', Array.from(g6.g).join());
    check(g8.w === 2 && g8.h === 3 && Array.from(g8.g).join() === '3,6,2,5,1,4', 'orientar 8 (90° antihorario)', Array.from(g8.g).join());
    check(g3.w === 3 && Array.from(g3.g).join() === '6,5,4,3,2,1', 'orientar 3 (180°)');

    const plana = new Uint8Array(64 * 48).fill(200);
    const chica = m.redimensionar(plana, 64, 48, 32, 24);
    check(chica.length === 32 * 24 && chica.every((v) => v === 200), 'redimensionar: una imagen pareja sigue pareja');
    const borde = m.redimensionar(new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]), 8, 1, 2, 1);
    check(borde[0]! < 64 && borde[1]! > 191 && Math.abs(borde[0]! + borde[1]! - 255) <= 2, 'redimensionar: achicar conserva el brillo medio', Array.from(borde).join());

    // Rectángulo de 10×4 girado 30°, con puntos adentro: el mínimo es ese rectángulo.
    const ang = Math.PI / 6;
    const gira = (x: number, y: number): number[] => [x * Math.cos(ang) - y * Math.sin(ang) + 50, x * Math.sin(ang) + y * Math.cos(ang) + 50];
    const puntos: number[][] = [];
    for (let x = 0; x <= 10; x += 0.5) for (let y = 0; y <= 4; y += 0.5) puntos.push(gira(x, y));
    const r = m.rectMinimo(puntos)!;
    const d = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
    const lados = [d(r.puntos[0]!, r.puntos[1]!), d(r.puntos[1]!, r.puntos[2]!)].sort((a, b) => a - b);
    check(Math.abs(r.lado - 4) < 0.01 && Math.abs(lados[0]! - 4) < 0.01 && Math.abs(lados[1]! - 10) < 0.01, 'rectMinimo: rectángulo girado 30°', `lado ${r.lado.toFixed(3)}, ${lados.map((l) => l.toFixed(2)).join('×')}`);
    check(m.rectMinimo([[3, 3]])!.lado === 0 && m.rectMinimo([])! === null, 'rectMinimo: un punto → lado 0; nada → null');

    const dic = m.cargarDiccionario(join(dirNative, 'ocr-paddle', 'modelos', 'latin_PP-OCRv5_rec_mobile.onnx'));
    check(dic.length > 100 && dic[dic.length - 1] === ' ' && dic.includes('ñ') && dic.includes('7'), `diccionario embebido en el ONNX: ${dic.length} caracteres, con ñ y dígitos`);
  }

  // --- 2. El script con el Electron del repo como Node -------------------------------
  {
    console.log(`ℹ️  ejecutable: ${electron}`);
    const { stdout } = await ejecutar(electron, [script, '--probar'], { env: envNode, timeout: 60_000 });
    check(/^disponible\s*$/.test(stdout), 'leer.mjs --probar → disponible', stdout.trim());
    let msg = '';
    await ejecutar(electron, [script, join(dirMuestras, 'no-existe.jpg')], { env: envNode, timeout: 60_000 }).catch((e: { stderr?: string }) => (msg = e.stderr ?? ''));
    check(/no se pudo abrir la foto/.test(msg), 'leer.mjs sin foto → error claro', msg.trim());
    msg = '';
    await ejecutar(electron, [script, join(dirDesktop, 'package.json')], { env: envNode, timeout: 60_000 }).catch((e: { stderr?: string; code?: number }) => (msg = `${e.code} ${e.stderr ?? ''}`));
    check(msg.length > 0 && !/^0 /.test(msg), 'leer.mjs con un archivo que no es JPEG → termina con error', msg.trim().slice(0, 80));
    msg = '';
    await ejecutar(electron, [script, '--filtro', 'cualquiera', 'x.jpg'], { env: envNode, timeout: 60_000 }).catch((e: { stderr?: string }) => (msg = e.stderr ?? ''));
    check(/--filtro/.test(msg), 'leer.mjs con una opción inválida → error claro', msg.trim());
  }

  // --- 3. Fotos reales, pipeline completo -------------------------------------------
  const esperado: Record<string, { renglones: number; suma: number | null }> = {
    'bernardi-2': { renglones: 19, suma: 49519.4 },
    'vital-15': { renglones: 10, suma: null },
  };
  if (Object.keys(esperado).every((h) => existsSync(join(dirMuestras, `${h}.jpg`)))) {
    // Salida cruda del script: JSON válido para interpretarLectura, coordenadas en 0..1.
    const { stdout } = await ejecutar(electron, [script, join(dirMuestras, 'vital-15.jpg')], { env: envNode, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    const cruda = interpretarLectura(stdout);
    const enRango = cruda.textos.every((c) => [c.x0, c.y0, c.x1, c.y1].every((v) => v >= 0 && v <= 1) && c.h > 0 && c.h < 0.2 && c.c >= 0 && c.c <= 1);
    check(cruda.ancho === 4032 && cruda.alto === 3024 && cruda.textos.length >= 100 && enRango, `JSON crudo de vital-15: ${cruda.ancho}×${cruda.alto}, ${cruda.textos.length} cajas, todo en rango`);

    const lector = new LectorSistema({ baseNativa: dirNative, electronPath: electron, nombres: ['paddle'] });
    check(lector.nombres.join() === 'paddle' && (await lector.disponible()) === true, 'LectorSistema sólo con paddle: disponible');
    for (const [hoja, esp] of Object.entries(esperado)) {
      const t0 = Date.now();
      const lectura = await lector.leerHoja(readFileSync(join(dirMuestras, `${hoja}.jpg`)));
      const ms = Date.now() - t0;
      const renglones = parsearTexto(armarRenglones(lectura).join('\n'));
      const suma = r2(renglones.reduce((s, r) => s + (r.importe ?? 0), 0));
      check(lectura.lector === 'paddle' && lectura.textos.length >= 100, `${hoja}: leída con paddle, ${lectura.textos.length} cajas`);
      check(ms < 15_000, `${hoja}: ${ms} ms (< 15 s)`);
      check(renglones.length === esp.renglones, `${hoja}: ${renglones.length} renglones (esperados ${esp.renglones})`);
      if (esp.suma !== null) check(Math.abs(suma - esp.suma) <= 0.05, `${hoja}: suma ${suma.toFixed(2)} ≈ ${esp.suma.toFixed(2)} (± 0,05)`);
    }
  } else {
    console.log(`ℹ️  fotos reales no probadas: falta tools/ocr-facturas/muestras (${Object.keys(esperado).join(', ')})`);
  }

  // --- 4. Cadena de lectores ----------------------------------------------------------
  {
    const avisos: string[] = [];
    const log = (m: string): void => void avisos.push(m);
    const anda = falso('anda', true, async () => lecturaJson(3));
    const falla = falso('falla', true, async () => {
      throw new Error('se rompió');
    });
    const vacio = falso('vacio', true, async () => lecturaJson(0));
    const ilegible = falso('ilegible', true, async () => 'esto no es una lectura');
    const ausente = falso('ausente', false, async () => lecturaJson(5));

    let l = await new LectorSistema({ lectores: [falla, anda], log }).leerHoja(JPEG_MINIMO);
    check(l.lector === 'anda' && l.textos.length === 3 && falla.llamadas === 1 && anda.llamadas === 1, 'falla → sigue con el siguiente y anota `lector`', `lector=${l.lector}`);
    check(avisos.length === 1 && /falla: se rompió/.test(avisos[0]!) && /anda/.test(avisos[0]!), 'el pase al siguiente se avisa en el log', avisos[0]);

    l = await new LectorSistema({ lectores: [vacio, anda] }).leerHoja(JPEG_MINIMO);
    check(l.lector === 'anda', 'cero cajas → sigue con el siguiente');
    l = await new LectorSistema({ lectores: [ilegible, anda] }).leerHoja(JPEG_MINIMO);
    check(l.lector === 'anda', 'salida ilegible → sigue con el siguiente');

    const conAusente = new LectorSistema({ lectores: [ausente, anda] });
    check((await conAusente.disponible()) === true, 'con uno ausente y otro que anda → disponible');
    l = await conAusente.leerHoja(JPEG_MINIMO);
    await conAusente.leerHoja(JPEG_MINIMO);
    check(l.lector === 'anda' && ausente.llamadas === 0 && ausente.pruebas === 1, 'el ausente no se ejecuta y se le pregunta una sola vez', `pruebas=${ausente.pruebas} llamadas=${ausente.llamadas}`);

    const vacioSolo = await new LectorSistema({ lectores: [vacio] }).leerHoja(JPEG_MINIMO);
    check(vacioSolo.textos.length === 0 && vacioSolo.lector === 'vacio', 'todos sin texto → lectura vacía (calidadDeFoto avisa), no error');

    let msg = '';
    await new LectorSistema({ lectores: [falla, ilegible] }).leerHoja(JPEG_MINIMO).catch((e: Error) => (msg = e.message));
    check(/lector de texto del sistema/.test(msg) && /falla: se rompió/.test(msg) && /ilegible: /.test(msg), 'todos fallan → error claro con el motivo de cada uno', msg);
    msg = '';
    await new LectorSistema({ lectores: [ausente] }).leerHoja(JPEG_MINIMO).catch((e: Error) => (msg = e.message));
    check(/no está disponible/.test(msg), 'ninguno disponible → error claro', msg);
    msg = '';
    const sinLectores = new LectorSistema({ lectores: [] });
    await sinLectores.leerHoja(JPEG_MINIMO).catch((e: Error) => (msg = e.message));
    check((await sinLectores.disponible()) === false && /no tiene lector/.test(msg), 'sin lectores → no disponible y error claro', msg);
    msg = '';
    await new LectorSistema({ lectores: [anda] }).leerHoja(Buffer.from('no soy un jpeg')).catch((e: Error) => (msg = e.message));
    check(/JPEG/.test(msg), 'lo que no es JPEG → error claro antes de llamar a nadie', msg);

    // De a una hoja por vez.
    let enCurso = 0;
    let maximo = 0;
    const lento = falso('lento', true, async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await new Promise((r) => setTimeout(r, 30));
      enCurso--;
      return lecturaJson(2);
    });
    const cola = new LectorSistema({ lectores: [lento] });
    await Promise.all([cola.leerHoja(JPEG_MINIMO), cola.leerHoja(JPEG_MINIMO), cola.leerHoja(JPEG_MINIMO)]);
    check(maximo === 1 && lento.llamadas === 3 && lento.pruebas === 1, 'las hojas se leen de a una y el lector se prueba una vez', `máximo en curso ${maximo}`);
  }

  // --- 5. Lectores por plataforma ------------------------------------------------------
  {
    check(lectoresPorPlataforma('win32').join() === 'paddle,windows-ocr', 'win32: paddle y después windows-ocr');
    check(lectoresPorPlataforma('darwin').join() === 'vision,paddle', 'darwin: vision y después paddle');
    check(lectoresPorPlataforma('linux').join() === 'paddle', 'linux: sólo paddle');
    check(programaDeLector('paddle') === join('ocr-paddle', 'leer.mjs') && programaDeLector('vision') === join('ocr-mac', 'vision-ocr') && programaDeLector('windows-ocr') === join('ocr-win', 'leer.ps1'), 'programaDeLector');
    check(new LectorSistema({ baseNativa: '/x', plataforma: 'win32' }).nombres.join() === 'paddle,windows-ocr', 'LectorSistema arma la cadena de la plataforma');
    check(new LectorSistema({ baseNativa: '/x', plataforma: 'darwin', nombres: ['paddle'] }).nombres.join() === 'paddle', '`nombres` elige los lectores');
    const noExiste = new LectorSistema({ baseNativa: join(dirNative, 'no-existe'), plataforma: 'win32', electronPath: electron });
    check((await noExiste.disponible()) === false, 'sin programas auxiliares → no disponible (sin ejecutar nada)');
    const lecturaTipada: LecturaSistema = { ancho: 1, alto: 1, textos: [] };
    check(lecturaTipada.lector === undefined, '`lector` es opcional en LecturaSistema (los lectores falsos de otras pruebas siguen compilando)');
  }

  console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
  process.exit(fallas ? 1 : 0);
}

void main();
