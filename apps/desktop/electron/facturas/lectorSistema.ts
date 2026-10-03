/**
 * Facturas de compra por teléfono — lector de texto "del sistema": programas
 * auxiliares locales que devuelven cajas de texto con su posición.
 *
 * Tres lectores, encadenados por plataforma (`lectoresPorPlataforma`):
 *   vision       Apple Vision (native/ocr-mac/vision-ocr): viene con la Mac, ~0,5 s por hoja.
 *   windows-ocr  Windows.Media.Ocr (native/ocr-win/leer.ps1): viene con Windows, pero
 *                lee peor (122 de 140 renglones en las fotos reales; medido sólo en
 *                GitHub Actions, ver tools/ocr-facturas/RESULTADOS.md).
 *   paddle       PaddleOCR sobre ONNX Runtime (native/ocr-paddle/leer.mjs): 140 de 140,
 *                1,7–3,8 s por hoja en la Mac, ~600–800 MB mientras lee. Corre con el
 *                propio ejecutable de Electron como Node (ELECTRON_RUN_AS_NODE).
 *   Windows: paddle y, de respaldo, windows-ocr. Mac: vision y, de respaldo, paddle.
 *   Si un lector falla (error, salida ilegible o ni una caja) se prueba el siguiente;
 *   `LecturaSistema.lector` dice cuál leyó.
 *
 * Es el lector PRINCIPAL de `servicio.ts` (el de Ollama, lector.ts, queda
 * para «Mejorar lectura» y como respaldo automático si éste falla al leer una
 * hoja). Los programas de `native/` se empaquetan con `extraResources`.
 *
 * El lector NO devuelve una tabla: devuelve cajas de texto con su posición. Acá se hace:
 *   armarRenglones()  cajas → una línea de texto por renglón de la hoja
 *                     (después parser.ts las convierte en renglones de compra)
 *   calidadDeFoto()   avisa si la foto no sirve (hoja cortada, borrosa, torcida)
 *   LectorSistema     ejecuta los programas auxiliares, en orden, hasta que uno lee
 *
 * Sin Electron ni base de datos: se prueba con tsx (facturas-sistema.smoke.ts,
 * facturas-paddle.smoke.ts).
 */
import { execFile } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Una caja de texto (un tramo de renglón). Coordenadas normalizadas 0..1, "y" hacia abajo. */
export interface CajaTexto {
  /** Texto leído. */
  t: string;
  /** Extremo izquierdo de la base del texto. */
  x0: number;
  y0: number;
  /** Extremo derecho de la base del texto. */
  x1: number;
  y1: number;
  /** Alto de la letra, como fracción del alto de la foto. */
  h: number;
  /** Confianza 0..1 (Windows no la informa: llega 1). */
  c: number;
}

export interface LecturaSistema {
  /** Tamaño de la foto en píxeles (ya girada según su orientación). */
  ancho: number;
  alto: number;
  textos: CajaTexto[];
  /** Qué lector la produjo (`vision`, `windows-ocr`, `paddle`); lo anota `LectorSistema`. */
  lector?: string;
}

// ---------------------------------------------------------------------------
// Cajas → renglones
// ---------------------------------------------------------------------------

interface Caja {
  t: string;
  /** Píxeles. */
  x0: number;
  x1: number;
  /** Centro de la base. */
  xm: number;
  ym: number;
  h: number;
  /** Altura ya enderezada. */
  y: number;
}

const mediana = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const o = [...xs].sort((a, b) => a - b);
  const m = o.length >> 1;
  return o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
};

function aPixeles(lectura: LecturaSistema): Caja[] {
  const W = lectura.ancho > 0 ? lectura.ancho : 1;
  const H = lectura.alto > 0 ? lectura.alto : 1;
  const cajas: Caja[] = [];
  for (const c of Array.isArray(lectura.textos) ? lectura.textos : []) {
    if (!c || typeof c.t !== 'string' || !c.t.trim()) continue;
    const nums = [c.x0, c.y0, c.x1, c.y1, c.h];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const x0 = Math.min(c.x0, c.x1) * W;
    const x1 = Math.max(c.x0, c.x1) * W;
    const ym = ((c.y0 + c.y1) / 2) * H;
    cajas.push({ t: c.t.trim(), x0, x1, xm: (x0 + x1) / 2, ym, h: Math.max(1, c.h * H), y: ym });
  }
  return cajas;
}

/**
 * Inclinación de la hoja (pendiente dy/dx) y cuánto cambia esa pendiente de
 * arriba hacia abajo (perspectiva: foto sacada en ángulo).
 *
 * La pendiente de cada caja NO sirve (la caja que da el lector es holgada: en
 * una descripción larga se desvía 1–2°). Se busca la pendiente que mejor ALINEA
 * los centros de las cajas en renglones: la que deja más pares de cajas, lejos
 * entre sí a lo ancho, a la misma altura.
 */
function estimarInclinacion(cajas: Caja[], ancho: number, alto: number): { pendiente: number; perspectiva: number } {
  if (cajas.length < 6) return { pendiente: 0, perspectiva: 0 };
  const hMed = mediana(cajas.map((c) => c.h));
  const tol = hMed * 0.22;
  const lejos = ancho * 0.05;
  const cx = ancho / 2;
  const cy = alto / 2;
  // Con muchas cajas se toma una muestra pareja: alcanza y no tarda.
  const paso = Math.max(1, Math.floor(cajas.length / 400));
  const pts = cajas.filter((_, i) => i % paso === 0).map((c) => ({ x: c.xm - cx, y: c.ym - cy }));
  const puntaje = (s: number, k: number): number => {
    const ys = pts.map((p) => p.y - (s + k * p.y) * p.x);
    let n = 0;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.abs(ys[i]! - ys[j]!);
        if (d < tol && Math.abs(pts[i]!.x - pts[j]!.x) > lejos) n += 1 - d / tol;
      }
    }
    return n;
  };
  let mejor = { pendiente: 0, perspectiva: 0, p: puntaje(0, 0) };
  const probar = (s: number, k: number): void => {
    const p = puntaje(s, k);
    // Ante un empate gana lo más derecho (no se inventa inclinación).
    if (p > mejor.p * 1.0001) mejor = { pendiente: s, perspectiva: k, p };
  };
  for (let s = -0.3; s <= 0.3001; s += 0.004) probar(s, 0);
  const s0 = mejor.pendiente;
  // Perspectiva: la pendiente cambia hasta ±0,03 entre el centro y el borde de la hoja.
  const kMax = 0.03 / Math.max(1, cy);
  for (let ik = -6; ik <= 6; ik++) {
    for (let ds = -0.006; ds <= 0.0061; ds += 0.001) probar(s0 + ds, (kMax * ik) / 6);
  }
  return { pendiente: mejor.pendiente, perspectiva: mejor.perspectiva };
}

function enderezar(cajas: Caja[], ancho: number, alto: number): { pendiente: number } {
  const { pendiente, perspectiva } = estimarInclinacion(cajas, ancho, alto);
  const cx = ancho / 2;
  const cy = alto / 2;
  for (const c of cajas) c.y = c.ym - (pendiente + perspectiva * (c.ym - cy)) * (c.xm - cx);
  return { pendiente };
}

/** Un importe/precio impreso: termina en decimales (`1.234,56`, `2599,00`, `x 6.443,79`). */
const RE_DINERO = /\d[.,]\d{2}$/;

/**
 * Columna ancla: la columna de números con decimales que más renglones tiene
 * (precios / importes: es lo que el lector lee mejor y está en TODOS los
 * renglones de artículos). Las columnas se reconocen por el borde derecho
 * (los números se imprimen alineados a la derecha).
 */
function columnaAncla(cajas: Caja[], ancho: number): Caja[] {
  const dinero = cajas.filter((c) => RE_DINERO.test(c.t) && c.x1 - c.x0 < ancho * 0.25).sort((a, b) => a.x1 - b.x1);
  const tol = ancho * 0.02;
  let mejor: Caja[] = [];
  for (let i = 0; i < dinero.length; i++) {
    const grupo: Caja[] = [];
    for (let j = i; j < dinero.length && dinero[j]!.x1 - dinero[i]!.x1 <= tol * 2; j++) grupo.push(dinero[j]!);
    if (grupo.length > mejor.length) mejor = grupo; // ante empate queda la de más a la izquierda (el precio)
  }
  return mejor;
}

interface Fila {
  cajas: Caja[];
  y: number;
}

/**
 * Renglones de la hoja, de arriba hacia abajo: cada uno es el texto de sus cajas
 * de izquierda a derecha, unidas con dos espacios.
 *
 *  1. Se endereza la hoja (inclinación + perspectiva).
 *  2. Cada caja de la columna ancla (precios) define UN renglón: dos precios
 *     nunca se mezclan en la misma fila aunque la hoja esté torcida o arrugada.
 *  3. Las demás cajas van al renglón ancla más cercano en altura. Se reparten
 *     empezando por las más cercanas a la columna ancla y la altura se compara
 *     contra la caja del renglón más próxima a lo ancho: así un renglón que se
 *     "cae" hacia un costado (hoja curvada) se sigue de caja en caja. Una caja
 *     anormalmente alta (más de 1,5× la mediana: la birome o un tachón la
 *     estiraron) se ubica por su CENTRO, no por su base; si así no cae en
 *     ningún renglón, por la base.
 *  4. Dos cajas con texto que se pisan a lo ancho en la misma fila: una se
 *     "cayó" de la fila vecina. La que peor encaja (la alta; si no, la más
 *     lejos de la altura de la fila) pasa a la fila vecina que no tiene texto
 *     en esa zona.
 *  5. Lo que no queda cerca de ningún ancla (encabezado, pie) se agrupa por altura.
 */
export function armarRenglones(lectura: LecturaSistema): string[] {
  const cajas = aPixeles(lectura);
  if (cajas.length === 0) return [];
  const ancho = lectura.ancho > 0 ? lectura.ancho : 1;
  const alto = lectura.alto > 0 ? lectura.alto : 1;
  enderezar(cajas, ancho, alto);
  const hMed = mediana(cajas.map((c) => c.h));
  /** Caja anormalmente alta: su base ya no dice en qué renglón está el texto. */
  const alta = (c: Caja): boolean => c.h > hMed * 1.5;
  /** Altura con la que se ubica una caja: su base; si es alta, su centro. */
  const yDe = (c: Caja): number => (alta(c) ? c.y - c.h / 2 : c.y);

  const anclas = columnaAncla(cajas, ancho).sort((a, b) => a.y - b.y);
  const filas: Fila[] = [];
  const sueltas: Caja[] = [];
  if (anclas.length >= 2) {
    const xAncla = mediana(anclas.map((a) => a.xm));
    // Dos anclas a la misma altura (columna partida en dos cajas) son un solo renglón.
    for (const a of anclas) {
      const ult = filas[filas.length - 1];
      if (ult && Math.abs(a.y - ult.y) < hMed * 0.3) ult.cajas.push(a);
      else filas.push({ cajas: [a], y: a.y });
    }
    const paso = filas.map((f, i) => {
      const arriba = i > 0 ? f.y - filas[i - 1]!.y : Infinity;
      const abajo = i < filas.length - 1 ? filas[i + 1]!.y - f.y : Infinity;
      const p = Math.min(arriba, abajo);
      return Number.isFinite(p) ? p : hMed * 1.5;
    });
    const esAncla = new Set(anclas);
    const resto = cajas.filter((c) => !esAncla.has(c)).sort((a, b) => Math.abs(a.xm - xAncla) - Math.abs(b.xm - xAncla));
    /** Fila más cercana a la altura `yc` para la caja `c`, y a qué distancia. */
    const ubicar = (c: Caja, yc: number): { i: number; d: number } => {
      let mejor = -1;
      let dMejor = Infinity;
      for (let i = 0; i < filas.length; i++) {
        const f = filas[i]!;
        if (Math.abs(f.y - yc) > hMed * 3) continue;
        // Altura del renglón cerca de esta caja: la de su vecina más próxima a lo ancho.
        let vecina = f.cajas[0]!;
        let dx = Infinity;
        for (const m of f.cajas) {
          const d = c.x1 < m.x0 ? m.x0 - c.x1 : m.x1 < c.x0 ? c.x0 - m.x1 : 0;
          if (d < dx) {
            dx = d;
            vecina = m;
          }
        }
        // …o la del ancla, si la vecina es una caja mal medida (birome).
        const d = Math.min(Math.abs(vecina.y - yc), Math.abs(f.y - yc));
        if (d < dMejor) {
          dMejor = d;
          mejor = i;
        }
      }
      return { i: mejor, d: dMejor };
    };
    const cabe = (u: { i: number; d: number }): boolean => u.i >= 0 && u.d <= Math.min(paso[u.i]! * 0.45, hMed * 0.8);
    for (const c of resto) {
      let u = ubicar(c, yDe(c));
      // Caja alta cuyo centro no cae en ningún renglón: se prueba con la base.
      if (!cabe(u) && alta(c)) u = ubicar(c, c.y);
      if (cabe(u)) filas[u.i]!.cajas.push(c);
      else sueltas.push(c);
    }

    // Dos cajas con texto que se pisan a lo ancho en la misma fila ("* SPEED
    // CON CAFE 24X24" y "• POWERADE MOUNTAIN BLAST" en la fila de 940): la que
    // peor encaja pasa a la fila vecina sin texto en esa zona (la de 29071).
    const conLetras = (c: Caja): boolean => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(c.t);
    const sePisan = (a: Caja, b: Caja): boolean =>
      Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0);
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i]!;
      for (let intentos = 0; intentos < 4; intentos++) {
        const letras = f.cajas.filter(conLetras);
        let movida = false;
        for (let a = 0; a < letras.length && !movida; a++) {
          for (let b = a + 1; b < letras.length && !movida; b++) {
            const p = letras[a]!;
            const q = letras[b]!;
            if (!sePisan(p, q)) continue;
            const peor = alta(p) !== alta(q) ? (alta(p) ? p : q) : Math.abs(yDe(p) - f.y) >= Math.abs(yDe(q) - f.y) ? p : q;
            const destino = [filas[i - 1], filas[i + 1]]
              .filter((v): v is Fila => !!v && Math.abs(yDe(peor) - v.y) <= hMed * 3 && !v.cajas.some((m) => conLetras(m) && sePisan(m, peor)))
              .sort((v, w) => Math.abs(yDe(peor) - v.y) - Math.abs(yDe(peor) - w.y))[0];
            if (!destino) continue;
            f.cajas.splice(f.cajas.indexOf(peor), 1);
            destino.cajas.push(peor);
            movida = true;
          }
        }
        if (!movida) break;
      }
    }
  } else {
    sueltas.push(...cajas);
  }

  // Sin ancla: agrupado simple por altura (tolerancia relativa al alto de letra).
  sueltas.sort((a, b) => a.y - b.y);
  let actual: Fila | null = null;
  for (const c of sueltas) {
    if (actual && Math.abs(c.y - actual.y) < hMed * 0.5) {
      actual.cajas.push(c);
      actual.y = actual.cajas.reduce((s, m) => s + m.y, 0) / actual.cajas.length;
    } else {
      actual = { cajas: [c], y: c.y };
      filas.push(actual);
    }
  }

  filas.sort((a, b) => a.y - b.y);
  return filas.map((f) =>
    [...f.cajas]
      .sort((a, b) => a.x0 - b.x0)
      .map((c) => c.t)
      .join('  '),
  );
}

// ---------------------------------------------------------------------------
// Calidad de la foto
// ---------------------------------------------------------------------------

export interface CalidadFoto {
  ok: boolean;
  /** Mensajes para mostrar tal cual en el teléfono / en la revisión. */
  problemas: string[];
}

/**
 * Control rápido de la foto ANTES de leer renglones: si algo de esto falla,
 * conviene pedir otra foto en vez de mostrar renglones dudosos.
 */
export function calidadDeFoto(lectura: LecturaSistema): CalidadFoto {
  const problemas: string[] = [];
  const cajas = aPixeles(lectura);
  const ancho = lectura.ancho > 0 ? lectura.ancho : 1;
  const alto = lectura.alto > 0 ? lectura.alto : 1;

  // Borrosa u oscura: casi no hay texto, o el lector duda de casi todo.
  const validas = (Array.isArray(lectura.textos) ? lectura.textos : []).filter((c) => c && typeof c.t === 'string' && c.t.trim());
  let letras = 0;
  let confianza = 0;
  for (const c of validas) {
    const n = c.t.trim().length;
    letras += n;
    confianza += n * (typeof c.c === 'number' && Number.isFinite(c.c) ? c.c : 1);
  }
  const confianzaMedia = letras > 0 ? confianza / letras : 0;
  if (cajas.length < 8 || confianzaMedia < 0.55) {
    problemas.push('La foto salió borrosa u oscura. Por favor, vuelva a sacarla con más luz y sin mover el teléfono.');
  }

  if (cajas.length >= 8) {
    // Hoja cortada: varias cajas pegadas al borde. El texto impreso siempre deja margen.
    const borde = ancho * 0.006;
    const minimo = Math.max(3, Math.ceil(cajas.length * 0.04));
    const izq = cajas.filter((c) => c.x0 <= borde).length;
    const der = cajas.filter((c) => c.x1 >= ancho - borde).length;
    if (izq >= minimo) problemas.push('Falta parte de la hoja a la izquierda. Por favor, saque la foto de más lejos para que entre la hoja completa.');
    if (der >= minimo) problemas.push('Falta parte de la hoja a la derecha. Por favor, saque la foto de más lejos para que entre la hoja completa.');

    // Inclinación: más de ~8° ya mezcla columnas y deforma la letra.
    const { pendiente } = estimarInclinacion(cajas, ancho, alto);
    if (Math.abs(pendiente) > 0.14) {
      problemas.push('La hoja salió muy inclinada. Por favor, saque la foto con la hoja derecha.');
    }
  }
  return { ok: problemas.length === 0, problemas };
}

// ---------------------------------------------------------------------------
// Programas auxiliares (lectores) y cadena por plataforma
// ---------------------------------------------------------------------------

/** Nombre de cada lector; `LecturaSistema.lector` dice cuál leyó la hoja. */
export type NombreLector = 'vision' | 'windows-ocr' | 'paddle';

/**
 * Lectores de cada plataforma, en el orden en que se prueban: si uno falla
 * (error, salida ilegible o ni una caja de texto) se pasa al siguiente.
 *   win32  → PaddleOCR y, de respaldo, Windows.Media.Ocr (lee bastante peor)
 *   darwin → Apple Vision (más rápido) y, de respaldo, PaddleOCR
 *   otros  → PaddleOCR
 */
export function lectoresPorPlataforma(plataforma: NodeJS.Platform = process.platform): NombreLector[] {
  if (plataforma === 'win32') return ['paddle', 'windows-ocr'];
  if (plataforma === 'darwin') return ['vision', 'paddle'];
  return ['paddle'];
}

/** Programa de cada lector dentro de `native/` (desarrollo) o `resources/ocr` (empaquetado). */
export function programaDeLector(nombre: NombreLector): string {
  if (nombre === 'vision') return join('ocr-mac', 'vision-ocr');
  if (nombre === 'windows-ocr') return join('ocr-win', 'leer.ps1');
  return join('ocr-paddle', 'leer.mjs');
}

/** Programa del lector del SISTEMA OPERATIVO de cada plataforma (null = esa plataforma no tiene). */
export function programaPorPlataforma(plataforma: NodeJS.Platform = process.platform): string | null {
  if (plataforma === 'darwin') return programaDeLector('vision');
  if (plataforma === 'win32') return programaDeLector('windows-ocr');
  return null;
}

/**
 * Un lector concreto: cómo saber si anda en esta PC y cómo leer una foto.
 * Interno; se expone para probar la cadena de `LectorSistema` con lectores falsos.
 */
export interface LectorDeHoja {
  nombre: string;
  /** ¿Puede usarse en esta PC? Se llama una vez por sesión; el resultado queda guardado. */
  probar(): Promise<boolean>;
  /** Lee la foto (archivo JPEG) y devuelve lo que imprimió el programa (el JSON de cajas). */
  leer(rutaFoto: string, timeoutMs: number): Promise<string>;
}

export interface OpcionesLectorSistema {
  /**
   * Carpeta con los programas auxiliares: `native/` en desarrollo,
   * `resources/ocr` empaquetado (extraResources de electron-builder.yml).
   */
  baseNativa?: string;
  /**
   * Ejecutable con el que corre el lector PaddleOCR (leer.mjs) como Node: en la
   * app, `process.execPath` (el propio Electron, con ELECTRON_RUN_AS_NODE=1).
   * Por defecto, el ejecutable actual.
   */
  electronPath?: string;
  /**
   * Carpetas `node_modules` donde leer.mjs encuentra onnxruntime-node y jpeg-js
   * (empaquetado: resources/app.asar/node_modules y app.asar.unpacked/node_modules).
   * Sin esto, leer.mjs los resuelve desde su propia carpeta (desarrollo).
   */
  nodeModules?: string[];
  /** Lectores a usar, en orden. Por defecto, los de la plataforma (`lectoresPorPlataforma`). */
  nombres?: NombreLector[];
  /** Lectores ya armados (para pruebas); reemplaza a `nombres`/`baseNativa`. */
  lectores?: LectorDeHoja[];
  /**
   * Compatibilidad: ruta del programa del lector del sistema operativo de esta
   * plataforma (vision-ocr / leer.ps1) y nada más (sin PaddleOCR).
   */
  programa?: string;
  /** Por defecto, la plataforma actual. */
  plataforma?: NodeJS.Platform;
  /** Tope por hoja y por lector. La primera lectura en Mac puede tardar ~45 s (el sistema carga el motor). */
  timeoutMs?: number;
  /** Carpeta para la foto temporal (por defecto, la del sistema). */
  dirTemporal?: string;
  /** A dónde contar cuándo un lector falló y se usó el siguiente. */
  log?: (mensaje: string) => void;
}

interface Comando {
  comando: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function ejecutar(cmd: Comando, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd.comando,
      cmd.args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8', env: cmd.env },
      (error, stdout, stderr) => {
        if (error) {
          const detalle = String(stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
          const e = error as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) reject(new Error(`tardó demasiado (más de ${Math.round(timeoutMs / 1000)} s)`));
          else reject(new Error(`falló${detalle ? `: ${detalle}` : ` (${e.code ?? e.message})`}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** El lector real `nombre` con su programa auxiliar en `programa`. */
function lectorReal(nombre: NombreLector, programa: string, o: OpcionesLectorSistema): LectorDeHoja {
  const comando = (rutaFoto: string | null): Comando => {
    if (nombre === 'vision') return { comando: programa, args: rutaFoto ? [rutaFoto] : ['--probar'] };
    if (nombre === 'windows-ocr') {
      // Windows PowerShell 5.1 (el que trae Windows): PowerShell 7 no carga los tipos WinRT.
      const raiz = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const ps = join(raiz, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const base = ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', programa];
      return { comando: ps, args: rutaFoto ? [...base, '-Ruta', rutaFoto] : [...base, '-Probar'] };
    }
    // PaddleOCR: leer.mjs con Electron como Node (o el Node que corre, en las pruebas).
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    if (o.nodeModules && o.nodeModules.length > 0) env.STOCKFLOW_OCR_NODE_MODULES = o.nodeModules.join(delimiter);
    return { comando: o.electronPath ?? process.execPath, args: rutaFoto ? [programa, rutaFoto] : [programa, '--probar'], env };
  };
  return {
    nombre,
    /**
     * Mac: el binario existe y CORRE en esta máquina (`--probar`: un binario de
     * otra arquitectura pasa `access()` pero no arranca). Windows: el script existe
     * y Windows tiene un idioma de lectura instalado. PaddleOCR: están los modelos
     * y carga onnxruntime-node en esta plataforma.
     */
    async probar() {
      try {
        await access(programa, nombre === 'vision' ? FS.X_OK : FS.R_OK);
      } catch {
        return false;
      }
      try {
        const salida = await ejecutar(comando(null), 30_000);
        return /\bdisponible\b/i.test(salida) && !/no disponible/i.test(salida);
      } catch (e) {
        // Mac: un binario compilado antes de `--probar` toma el argumento como
        // una foto y termina con "no se pudo abrir la foto": corrió, así que lee.
        return nombre === 'vision' && /no se pudo abrir la foto/.test((e as Error).message);
      }
    },
    leer: (rutaFoto, timeoutMs) => ejecutar(comando(rutaFoto), timeoutMs),
  };
}

/** Los lectores reales que piden las opciones, en orden. */
function crearLectores(o: OpcionesLectorSistema, plataforma: NodeJS.Platform): LectorDeHoja[] {
  if (o.lectores) return o.lectores;
  if (o.baseNativa === undefined && o.programa !== undefined) {
    // Compatibilidad: sólo el lector del sistema operativo, con esa ruta.
    const nombre: NombreLector | null = plataforma === 'darwin' ? 'vision' : plataforma === 'win32' ? 'windows-ocr' : null;
    return nombre ? [lectorReal(nombre, o.programa, o)] : [];
  }
  const base = o.baseNativa ?? '';
  return (o.nombres ?? lectoresPorPlataforma(plataforma)).map((n) => lectorReal(n, join(base, programaDeLector(n)), o));
}

/** Valida y normaliza lo que imprimió el programa auxiliar. Tira si no es una lectura. */
export function interpretarLectura(salida: string): LecturaSistema {
  // Por si el programa escribió algo antes del JSON (avisos de PowerShell).
  const desde = salida.indexOf('{');
  const hasta = salida.lastIndexOf('}');
  if (desde < 0 || hasta <= desde) throw new Error('El lector de texto del sistema no devolvió una lectura.');
  let crudo: unknown;
  try {
    crudo = JSON.parse(salida.slice(desde, hasta + 1));
  } catch {
    throw new Error('El lector de texto del sistema devolvió una lectura ilegible.');
  }
  const o = crudo as { ancho?: unknown; alto?: unknown; textos?: unknown };
  const ancho = Number(o.ancho);
  const alto = Number(o.alto);
  if (!(ancho > 0) || !(alto > 0)) throw new Error('El lector de texto del sistema devolvió una lectura sin tamaño de foto.');
  const textos: CajaTexto[] = [];
  // PowerShell entrega un objeto suelto cuando la lista tiene un solo elemento.
  const lista = Array.isArray(o.textos) ? o.textos : o.textos && typeof o.textos === 'object' ? [o.textos] : [];
  for (const c of lista as Array<Record<string, unknown>>) {
    if (!c || typeof c.t !== 'string' || !c.t.trim()) continue;
    const [x0, y0, x1, y1, h] = [c.x0, c.y0, c.x1, c.y1, c.h].map(Number) as [number, number, number, number, number];
    if (![x0, y0, x1, y1, h].every(Number.isFinite)) continue;
    const conf = Number(c.c);
    textos.push({ t: c.t, x0, y0, x1, y1, h, c: Number.isFinite(conf) ? conf : 1 });
  }
  return { ancho, alto, textos };
}

/**
 * Lee una hoja con los lectores de la plataforma, en orden, hasta que uno la lee.
 * De a una hoja por vez (las llamadas se encolan): los programas auxiliares usan
 * todos los núcleos y no ganan nada corriendo dos a la vez.
 */
export class LectorSistema {
  private readonly lectores: LectorDeHoja[];
  private readonly timeoutMs: number;
  private readonly dirTemporal: string;
  private readonly log: (mensaje: string) => void;
  private cola: Promise<unknown> = Promise.resolve();
  private readonly andan = new Map<LectorDeHoja, Promise<boolean>>();

  constructor(opciones: OpcionesLectorSistema = {}) {
    this.lectores = crearLectores(opciones, opciones.plataforma ?? process.platform);
    this.timeoutMs = opciones.timeoutMs ?? 120_000;
    this.dirTemporal = opciones.dirTemporal ?? tmpdir();
    this.log = opciones.log ?? (() => undefined);
  }

  /** Nombres de los lectores, en el orden en que se prueban. */
  get nombres(): string[] {
    return this.lectores.map((l) => l.nombre);
  }

  /**
   * ¿Hay algún lector que ande en esta PC? A cada uno se le pregunta una sola
   * vez (`probar()`); el resultado queda guardado.
   */
  async disponible(): Promise<boolean> {
    for (const l of this.lectores) if (await this.anda(l)) return true;
    return false;
  }

  private anda(l: LectorDeHoja): Promise<boolean> {
    let p = this.andan.get(l);
    if (!p) {
      p = l.probar().catch(() => false);
      this.andan.set(l, p);
    }
    return p;
  }

  /**
   * Cajas de texto de una hoja (JPEG), con `lector` = quién la leyó. Si un
   * lector falla, se prueba el siguiente. Tira con un mensaje claro si ninguno
   * pudo leer la foto.
   */
  leerHoja(jpeg: Buffer): Promise<LecturaSistema> {
    const tarea = this.cola.then(() => this.leerAhora(jpeg));
    this.cola = tarea.catch(() => undefined);
    return tarea;
  }

  private async leerAhora(jpeg: Buffer): Promise<LecturaSistema> {
    if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new Error('La foto no es un JPEG válido.');
    }
    if (this.lectores.length === 0) throw new Error('Esta computadora no tiene lector de texto del sistema.');
    const dir = await mkdtemp(join(this.dirTemporal, 'stockflow-hoja-'));
    const ruta = join(dir, 'hoja.jpg');
    try {
      await writeFile(ruta, jpeg);
      const fallas: string[] = [];
      let vacia: LecturaSistema | null = null;
      for (const l of this.lectores) {
        if (!(await this.anda(l))) {
          fallas.push(`${l.nombre}: no está disponible en esta PC`);
          continue;
        }
        try {
          const lectura = interpretarLectura(await l.leer(ruta, this.timeoutMs));
          lectura.lector = l.nombre;
          if (lectura.textos.length === 0) {
            vacia ??= lectura;
            fallas.push(`${l.nombre}: no encontró texto`);
            continue;
          }
          if (fallas.length > 0) this.log(`hoja leída con ${l.nombre} (${fallas.join('; ')})`);
          return lectura;
        } catch (e) {
          fallas.push(`${l.nombre}: ${(e as Error).message}`);
        }
      }
      // Ninguno encontró texto pero alguno leyó la foto: la lectura vacía sigue
      // su curso (calidadDeFoto avisa que la foto salió borrosa u oscura).
      if (vacia) {
        this.log(`hoja sin texto para todos los lectores (${fallas.join('; ')})`);
        return vacia;
      }
      throw new Error(`El lector de texto del sistema no pudo leer la hoja (${fallas.join('; ')}).`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
