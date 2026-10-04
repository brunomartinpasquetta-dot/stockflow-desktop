/**
 * Facturas de compra por teléfono — del TEXTO leído a renglones de compra.
 *
 * El lector devuelve cada hoja como texto: líneas con las columnas separadas por
 * espacios (lector del sistema: lectorSistema.ts arma una línea por renglón) o
 * una tabla HTML (GLM-OCR). Acá NO hay otra IA: los renglones
 * se arman con código y se controlan con la cuenta de la propia factura
 *   cantidad × unidades por bulto × precio unitario = importe
 * Esa cuenta es la que decide qué número es cada cosa (no la posición de la
 * columna ni el nombre del proveedor), y la que avisa cuando algo se leyó mal:
 *   ok        → la cuenta cierra con lo leído
 *   corregido → no cerraba o faltaba un dato, pero la cuenta dice cuál es: la
 *               cantidad (importe ÷ precio da un entero), o un importe/precio leído
 *               con UN dígito mal cuando el precio con IVA hace de testigo
 *   revisar   → no cierra o faltan datos; lo mira el usuario (sale en rojo)
 *
 * El texto del lector del sistema trae además marcas de birome leídas como
 * letras sueltas ("x 6.443,79", "DUN"), cantidades tapadas y números cortados
 * en el borde de la foto: se toleran, y lo que no se puede confirmar con la
 * cuenta queda en `revisar` (nunca en `ok`).
 *
 * Sin Electron ni base de datos: se prueba con tsx (facturas-parser.smoke.ts).
 */
import { enPesos, packEnDescripcion, r2 } from '../../src/lib/facturaACompra';

export interface RenglonLeido {
  codigo: string | null;
  descripcion: string;
  /** En la unidad del precio (bultos/unidades/kg, tal cual la factura). */
  cantidad: number | null;
  /** UxB. */
  unidadesPorBulto: number | null;
  /** Sin IVA si la factura trae los dos. */
  precioUnitario: number | null;
  /** Neto del renglón (negativo en descuentos/promociones). */
  importe: number | null;
  /** Renglón de promoción/bonificación (importe negativo). */
  esDescuento: boolean;
  estado: 'ok' | 'corregido' | 'revisar';
  /** Texto corto para la pantalla de revisión. */
  motivo: string | null;
  /** El renglón tal como se leyó. */
  original: string;
  hoja: number;
  /**
   * Alícuota de IVA del renglón (10.5, 21…) cuando la factura la trae y el
   * precio con IVA la confirma. Sirve para avisar si no es la del artículo.
   */
  tasaIva?: number | null;
  /**
   * El código no venía en la línea del renglón: estaba SOLO en una línea
   * vecina y se le pegó por posición, sin certeza de que sea el suyo (un
   * proveedor que imprime el código de barras debajo de cada producto, o una
   * hoja sin columna de código). No se vincula solo por él ni se recuerda.
   */
  codigoSuelto?: boolean;
  /**
   * La cantidad YA está en unidades: la línea trae además los bultos y
   * bultos × (pack que dice la descripción) = cantidad ("… 12X500  6,00
   * 72,00 …": 6 × 12 = 72). La pantalla no propone unidades por bulto para
   * este renglón ni se le aplican las recordadas. `unidadesPorBulto` queda null.
   */
  packResuelto?: boolean;
  /** Bultos leídos cuando `packResuelto` (sólo informativo). */
  bultos?: number | null;
}

/** Cómo escribe los números el documento: `1.234,56` (argentino) o `1,234.56`. */
export type FormatoNumeros = 'argentino' | 'ingles';

export interface OpcionesParser {
  hoja?: number;
  /** Si no viene, se detecta del propio texto. */
  formato?: FormatoNumeros;
}

interface Numero {
  valor: number;
  /** Cantidad de decimales escritos (0 = entero). */
  decimales: number;
  texto: string;
  /** El signo menos venía suelto (`- 276,78`): puede ser una marca de birome. */
  signoSuelto?: boolean;
  /** Empieza con el separador (`.733,92`): le falta al menos un dígito adelante. */
  cortado?: boolean;
}

// ---------------------------------------------------------------------------
// Texto → líneas
// ---------------------------------------------------------------------------

const ENTIDADES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

/**
 * Deja una línea por renglón del documento. Una tabla HTML pasa a una línea por
 * `<tr>` con las celdas unidas por un espacio (las vacías desaparecen: no hacen
 * falta, la cuenta ubica cada número). También acepta tablas Markdown (`| a | b |`).
 * Se corta por `<tr` y no por pares abre/cierra a propósito: si el lector se
 * quedó sin tokens a mitad de la tabla, la última fila igual se aprovecha.
 */
export function aLineas(texto: string): string[] {
  let t = texto.replace(/\r\n?/g, '\n');
  if (/<\s*(table|tr|td|th)\b/i.test(t)) {
    t = t
      .replace(/<\s*br\s*\/?\s*>/gi, ' ')
      .replace(/<\s*\/?\s*(tr|table|thead|tbody|tfoot|p|div)\b[^>]*>/gi, '\n')
      .replace(/<\s*\/\s*(td|th)\s*>/gi, ' ')
      .replace(/<[^>\n]*>/g, ' ')
      .replace(/<[^>\n]*$/, ' '); // etiqueta cortada al final
  }
  t = t
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTIDADES[m] ?? m)
    .replace(/[   \t]/g, ' ')
    .replace(/[−–—]/g, '-');
  const lineas: string[] = [];
  for (let l of t.split('\n')) {
    if (/^\s*\|/.test(l)) {
      if (/^[\s|:\-]+$/.test(l)) continue; // separador de tabla Markdown
      l = l.replace(/\|/g, ' ');
    }
    l = l.replace(/\s+/g, ' ').trim();
    if (l) lineas.push(l);
  }
  return lineas;
}

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

/**
 * Formato de números del documento. Vota cada número con decimales: si tiene
 * los dos separadores, el decimal es el último; si tiene uno solo, es decimal
 * cuando NO lo siguen exactamente 3 dígitos (`1.234` es separador de miles).
 * Ante la duda, argentino.
 */
export function detectarFormato(texto: string): FormatoNumeros {
  let arg = 0;
  let ing = 0;
  for (const linea of aLineas(texto)) {
    for (const tok of linea.split(' ')) {
      const m = /^-?\$?(\d[\d.,]*\d)-?$/.exec(tok);
      if (!m) continue;
      const n = m[1]!;
      const coma = n.lastIndexOf(',');
      const punto = n.lastIndexOf('.');
      if (coma < 0 && punto < 0) continue;
      if (coma >= 0 && punto >= 0) {
        if (coma > punto) arg++;
        else ing++;
        continue;
      }
      const pos = Math.max(coma, punto);
      const cola = n.length - pos - 1;
      if (cola === 3) continue; // miles: no dice nada
      if (n.indexOf(n[pos]!) !== pos) continue; // separador repetido: miles
      if (coma >= 0) arg++;
      else ing++;
    }
  }
  return ing > arg ? 'ingles' : 'argentino';
}

const RE_NUM: Record<FormatoNumeros, RegExp> = {
  argentino: /^(-?)\$?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(-?)$/,
  ingles: /^(-?)\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(-?)$/,
};

/** Un token como número del documento, o null si no lo es. Acepta `-12,50` y `12,50-`. */
function aNumero(tok: string, formato: FormatoNumeros): Numero | null {
  const m = RE_NUM[formato].exec(tok);
  if (!m) return null;
  const entero = m[2]!.replace(/[.,]/g, '');
  const dec = m[3] ?? '';
  let valor = Number(dec ? `${entero}.${dec}` : entero);
  if (!Number.isFinite(valor)) return null;
  if (m[1] === '-' || m[4] === '-') valor = -valor;
  return { valor, decimales: dec.length, texto: tok };
}

/** Marca que antepone tokenizar() al número cuyo signo menos venía suelto. */
const SUELTO = '\u2212';

/**
 * Separa en tokens. Pega el signo suelto al número que sigue (`- 276,78` →
 * `−276,78`, con la marca SUELTO para saber que no estaba pegado) y une los
 * decimales que el lector separó (`415, 01` → `415,01`).
 */
function tokenizar(linea: string, formato: FormatoNumeros): string[] {
  const dec = formato === 'argentino' ? ',' : '.';
  const crudos = linea.split(' ').filter(Boolean);
  const unidos: string[] = [];
  for (let i = 0; i < crudos.length; i++) {
    const t = crudos[i]!;
    const sig = crudos[i + 1];
    if (sig && /^\d{2}$/.test(sig) && t.endsWith(dec) && aNumero(t.slice(0, -1), formato)?.decimales === 0) {
      unidos.push(t + sig);
      i++;
      continue;
    }
    unidos.push(t);
  }
  const out: string[] = [];
  for (let i = 0; i < unidos.length; i++) {
    const t = unidos[i]!;
    const sig = unidos[i + 1];
    if (t === '$') continue;
    if (t === '-' && sig && /^\$?\d/.test(sig) && aNumero(sig, formato)) {
      out.push(`${SUELTO}${sig}`);
      i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * Número de un token ya pasado por tokenizar(): entiende el signo suelto, el
 * número cortado y un separador de más al final (`1880.001.`: el lector pegó
 * un punto a un número que ya trae sus decimales). Si al número le FALTAN los
 * decimales (`4.958.`, `1.090,`) no es un número: se leyó roto.
 */
function numeroDeToken(tok: string, formato: FormatoNumeros): Numero | null {
  if (tok.startsWith(SUELTO)) {
    const n = aNumero(tok.slice(1), formato);
    return n ? { valor: -n.valor, decimales: n.decimales, texto: `- ${n.texto}`, signoSuelto: true } : null;
  }
  if (/^[.,]\d/.test(tok)) {
    const n = aNumero(tok.slice(1), formato);
    return n && n.decimales > 0 ? { ...n, texto: tok, cortado: true } : null;
  }
  if (/\d[.,]$/.test(tok)) {
    const n = aNumero(tok.slice(0, -1), formato);
    return n && n.decimales >= 2 ? { ...n, texto: tok } : null;
  }
  return aNumero(tok, formato);
}

// ---------------------------------------------------------------------------
// La cuenta
// ---------------------------------------------------------------------------

/** Unidades de medida que acompañan a la cantidad (`3 UN`, `1 BTO`, `20.00 KGR`). */
const UNIDADES = new Set([
  'UN', 'UNI', 'UND', 'UNID', 'U', 'BTO', 'BULTO', 'BUL', 'CAJ', 'CAJA', 'CJA', 'CJ', 'KG', 'KGR', 'KGS',
  'GR', 'LT', 'LTS', 'L', 'ML', 'PAQ', 'PACK', 'PQ', 'DOC', 'MT', 'MTS', 'PZA', 'PZ', 'BOL', 'FDO', 'DISP',
]);
const esUnidad = (tok: string): boolean => UNIDADES.has(tok.replace(/\.$/, '').toUpperCase());
/** Unidades que son un bulto cerrado: el precio es por unidad y hay "unidades por bulto". */
const BULTOS = new Set(['BTO', 'BULTO', 'BUL', 'CAJ', 'CAJA', 'CJA', 'CJ', 'PAQ', 'PACK', 'PQ', 'FDO']);
/**
 * Unidad con una letra de más adelante (`DUN`, `JUN`, `AUN`): la cantidad
 * escrita o tildada con birome que el lector pegó a la unidad. Devuelve la unidad.
 */
function unidadSucia(tok: string): string | null {
  const t = tok.replace(/\.$/, '').toUpperCase();
  if (!/^[A-ZÑ]{3,5}$/.test(t)) return null;
  const u = t.slice(1);
  return u.length >= 2 && UNIDADES.has(u) ? u : null;
}

/** Alícuotas de IVA: una columna "TASA" nunca es el precio. */
const ALICUOTAS = new Set([2.5, 5, 10.5, 21, 27]);

/** Líneas de pie (totales, impuestos): no son renglones aunque traigan importes. */
const RE_PIE =
  /^(sub\s?-?\s?total|total(es)?\b|importe\s+(neto|total|final)|neto\s+(gravado|no\s+gravado)|exento|i\.?\s?v\.?\s?a\.?(\s|$)|percep|impuestos?\b|ing(resos)?\.?\s+brutos|ii\.?bb|bonif(icaci[oó]n)?\.?\s+(gral|general)|descuento\s+(gral|general)|son\s+pesos|transporte\b|saldo\b|vuelto\b|su\s+pago|de?s?c(uen)?tos?\.?\s*:)/i;

/**
 * ¿cantidad × UxB × precio da el importe? Tolerancia: 5 centavos, o el redondeo
 * del precio a centavos (medio centavo por unidad: en un descuento de 24
 * unidades a 27,19 el importe impreso es 652,56 y no 652,56±0,05).
 * NO hay tolerancia porcentual: 3 × 751,24 = 2.253,72 y un importe leído
 * 2.253,12 (un dígito mal) tiene que saltar, no pasar por "casi igual".
 */
function cierra(q: number, u: number, p: number, importe: number): boolean {
  const unidades = Math.abs(q * u);
  const tol = Math.max(0.05, unidades * 0.005 + 0.005);
  return Math.abs(q * u * p - importe) <= tol + 1e-9;
}

/** ¿Los dos importes difieren en UN dígito (cambiado, de más o de menos)? */
function unDigitoDeDiferencia(a: number, b: number): boolean {
  const x = Math.abs(a).toFixed(2).replace('.', '');
  const y = Math.abs(b).toFixed(2).replace('.', '');
  if (x === y) return false;
  if (x.length === y.length) {
    let dif = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) dif++;
    return dif === 1;
  }
  const [largo, corto] = x.length > y.length ? [x, y] : [y, x];
  if (largo.length - corto.length !== 1) return false;
  for (let i = 0; i < largo.length; i++) if (largo.slice(0, i) + largo.slice(i + 1) === corto) return true;
  return false;
}

interface Solucion {
  cantidad: number;
  uxb: number | null;
  /** Índice del precio dentro de la corrida de números. */
  iPrecio: number;
  /** Índices de la corrida usados como cantidad/UxB. */
  usados: number[];
  corregido: boolean;
  /** Precio corregido por el testigo (si no, el de la corrida). */
  precio?: number;
  /** Importe corregido por la cuenta (si no, el leído). */
  importe?: number;
  /** Motivo de la corrección (si no, se arma con la cantidad). */
  motivo?: string;
  /** El número que sigue al precio es una bonificación, no la tasa de IVA. */
  bonificacion?: boolean;
  /** La cantidad es la que se leyó ADELANTE de la descripción (no una columna del final). */
  deAdelante?: boolean;
}

/**
 * Margen del testigo: 2 centavos. Las facturas no siempre redondean igual el
 * neto y el precio con IVA (2.171,70 × 1,21 = 2.627,757 e imprimen 2.627,75).
 */
const TOL_TESTIGO = 0.02;

/**
 * Testigo: la columna "precio con IVA". Si después del precio vienen la tasa y
 * otro número, precio × (1 + tasa/100) tiene que dar ese número. Sirve para
 * saber CUÁL número se leyó mal cuando la cuenta no cierra.
 *   'si' = el testigo confirma el precio · 'no' = lo contradice · null = no hay testigo
 */
function testigo(corrida: Numero[], j: number, iImp: number): { ok: boolean; tasa: number; conIva: number } | null {
  const t = corrida[j + 1];
  const c = corrida[j + 2];
  if (!t || !c || j + 2 >= iImp || !ALICUOTAS.has(t.valor) || c.cortado) return null;
  const p = corrida[j]!.valor;
  if (Math.sign(c.valor) !== Math.sign(p)) return null;
  return { ok: Math.abs(p * (1 + t.valor / 100) - c.valor) <= TOL_TESTIGO, tasa: t.valor, conIva: c.valor };
}

const esEnteroDeBulto = (n: Numero): boolean => n.decimales === 0 && Number.isInteger(n.valor) && n.valor >= 2;

/**
 * Busca (cantidad, UxB, precio) que cierren contra el importe.
 * `delante` = números chicos antes de la descripción (la cantidad leída);
 * `corrida` = los números del final de la línea; `iImp` = cuál es el importe.
 * El precio es el PRIMERO de la corrida que cierra (por eso sale el neto y no
 * el precio con IVA). Orden de preferencia de la cantidad: la de adelante sola,
 * la de adelante con un UxB de la corrida, una de la corrida (columna CANT. o
 * UN./KG. pegada al precio), una de la corrida con UxB.
 */
function resolver(delante: Numero[], corrida: Numero[], iImp: number): Solucion | null {
  const importe = corrida[iImp]!.valor;
  for (let j = 0; j < iImp; j++) {
    const p = corrida[j]!.valor;
    if (p === 0 || Math.sign(p) !== Math.sign(importe)) continue;
    const previos = [...Array(j).keys()].reverse(); // desde el más cercano al precio
    for (const q of delante) {
      if (cierra(q.valor, 1, p, importe)) return { cantidad: q.valor, uxb: null, iPrecio: j, usados: [], corregido: false, deAdelante: true };
    }
    for (const q of delante) {
      for (const k of previos) {
        const u = corrida[k]!;
        if (esEnteroDeBulto(u) && cierra(q.valor, u.valor, p, importe)) {
          return { cantidad: q.valor, uxb: u.valor, iPrecio: j, usados: [k], corregido: false, deAdelante: true };
        }
      }
    }
    for (const k of previos) {
      const q = corrida[k]!;
      if (q.valor > 0 && cierra(q.valor, 1, p, importe)) {
        return { cantidad: q.valor, uxb: null, iPrecio: j, usados: [k], corregido: false };
      }
    }
    for (const k of previos) {
      const q = corrida[k]!;
      if (q.valor <= 0) continue;
      for (const k2 of previos) {
        const u = corrida[k2]!;
        if (k2 !== k && k2 > k && esEnteroDeBulto(u) && cierra(q.valor, u.valor, p, importe)) {
          return { cantidad: q.valor, uxb: u.valor, iPrecio: j, usados: [k, k2], corregido: false };
        }
      }
    }
  }
  return null;
}

/**
 * Columna de bonificación por renglón (CANT · P.UNIT · %BONIF · IMPORTE, común
 * en distribuidoras): cantidad × precio × (1 − d/100) = importe, con d = el
 * número que sigue al precio. Sólo con cantidad LEÍDA: así la cuenta no tiene
 * ninguna incógnita y no puede cerrar de casualidad. El precio del renglón es
 * el neto de la bonificación (lo que de verdad se paga por unidad).
 */
function resolverConBonificacion(leidos: Numero[], corrida: Numero[], iImp: number): Solucion | null {
  const imp = corrida[iImp]!;
  if (imp.cortado || imp.valor <= 0 || leidos.length === 0) return null;
  for (let j = 0; j + 1 < iImp; j++) {
    const pn = corrida[j]!;
    const dn = corrida[j + 1]!;
    if (pn.decimales === 0 || pn.cortado || pn.valor <= 0) continue;
    if (dn.cortado || !(dn.valor > 0 && dn.valor < 100)) continue;
    const neto = pn.valor * (1 - dn.valor / 100);
    const bultos: Array<number | null> = [null];
    for (let k = j - 1; k >= 0; k--) if (esEnteroDeBulto(corrida[k]!)) bultos.push(k);
    for (const q of leidos) {
      for (const k of bultos) {
        const u = k === null ? 1 : corrida[k]!.valor;
        if (!cierra(q.valor, u, neto, imp.valor)) continue;
        return {
          cantidad: q.valor,
          uxb: k === null ? null : u,
          iPrecio: j,
          usados: k === null ? [] : [k],
          corregido: true,
          precio: Math.round((neto + Number.EPSILON) * 10000) / 10000,
          motivo: `Bonificación ${String(dn.valor).replace('.', ',')} %: precio ${enPesos(pn.valor)} menos la bonificación = ${enPesos(neto)}`,
          bonificacion: true,
        };
      }
    }
  }
  return null;
}

/**
 * La columna de cantidad son CAJAS y el precio es por unidad, sin columna de
 * "unidades por bulto": `2 … 12 X 1 LT … 960,002 23.040,05` → 2 × 12 × 960,002.
 * El pack sale de la cuenta: importe ÷ (cantidad leída × precio) da un entero.
 * Para no confundirlo con una cantidad mal leída (2 por 12), se pide que el
 * pack figure en la descripción ("12 X 1", "6x1000") o que el total no se
 * parezca en nada a lo leído. Sólo sin unidad escrita: "2 UN" son unidades.
 */
function resolverPack(leidos: Numero[], corrida: Numero[], iImp: number, descripcion: string): Solucion | null {
  const imp = corrida[iImp]!;
  const q = leidos[0];
  if (!q || imp.cortado || imp.valor <= 0 || !Number.isInteger(q.valor) || q.valor < 1) return null;
  const hayDecimales = corrida.slice(0, iImp).some((n) => n.decimales > 0 && !ALICUOTAS.has(Math.abs(n.valor)));
  for (let j = 0; j < iImp; j++) {
    const pn = corrida[j]!;
    if (pn.valor <= 0 || pn.cortado) continue;
    if (hayDecimales && (pn.decimales === 0 || ALICUOTAS.has(pn.valor))) continue;
    if (testigo(corrida, j, iImp)?.ok === false) continue;
    const u = Math.round(imp.valor / (q.valor * pn.valor));
    if (u < 2 || u > 500 || !cierra(q.valor, u, pn.valor, imp.valor)) continue;
    // Precio tan chico que cualquier entero "cierra": no se adivina.
    if (q.valor * u * 0.005 + 0.055 >= pn.valor / 4) continue;
    const enDescripcion = new RegExp(`(^|[^\\d.,])0*${u}([^\\d.,]|$)`).test(descripcion);
    if (!enDescripcion && (u <= 3 || unDigitoEntero(q.valor * u, q.valor))) continue;
    return {
      cantidad: q.valor,
      uxb: u,
      iPrecio: j,
      usados: [],
      corregido: true,
      deAdelante: true,
      motivo: `Unidades por bulto calculadas por el importe: ${q.valor} × ${u} = ${q.valor * u} unidades`,
    };
  }
  return null;
}

/** ¿Los dos enteros difieren en UN dígito (cambiado, de más o de menos)? `12` y `2`, `3` y `8`. */
function unDigitoEntero(a: number, b: number): boolean {
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return unDigitoDeDiferencia(a / 100, b / 100);
}

/**
 * La cuenta no cerró con la cantidad leída: si importe ÷ (UxB × precio) da un
 * entero, la cantidad es ésa (el lector confunde un 3 con un 2 más fácil que
 * dos importes de seis cifras).
 *
 * `leida` = la cantidad que sí se leyó. Si la deducida no se le parece (más
 * del triple o menos de un tercio, y no por un dígito mal leído), no es un
 * error de lectura de la cantidad: se tomó como precio un número que no lo es
 * (un % de bonificación, por ejemplo). No se corrige: lo mira el usuario.
 * `esBulto` = la cantidad leída son bultos sin "unidades por bulto": ahí la
 * deducida es el total de unidades y es normal que sea mucho mayor.
 */
function corregirCantidad(corrida: Numero[], iImp: number, leida?: number, esBulto = false): Solucion | null {
  if (corrida[iImp]!.cortado) return null;
  const importe = corrida[iImp]!.valor;
  const hayDecimales = corrida.slice(0, iImp).some((n) => n.decimales > 0 && !ALICUOTAS.has(Math.abs(n.valor)));
  for (let j = 0; j < iImp; j++) {
    const pn = corrida[j]!;
    const p = pn.valor;
    if (p === 0 || Math.sign(p) !== Math.sign(importe)) continue;
    if (hayDecimales && (pn.decimales === 0 || ALICUOTAS.has(Math.abs(p)))) continue;
    // Sin cantidad leída, lo único que sostiene la cuenta es el precio: si el
    // precio con IVA lo contradice, no se deduce nada de él.
    if (pn.cortado || testigo(corrida, j, iImp)?.ok === false) continue;
    const bultos: Array<number | null> = [];
    for (let k = j - 1; k >= 0; k--) if (esEnteroDeBulto(corrida[k]!)) bultos.push(k);
    bultos.push(null);
    for (const k of bultos) {
      const u = k === null ? 1 : corrida[k]!.valor;
      const n = Math.round(importe / (u * p));
      if (n < 1 || n > 9999) continue;
      // Si el precio es tan chico que cualquier entero "cierra", no se adivina.
      if (n * u * 0.005 + 0.055 >= Math.abs(u * p) / 4) continue;
      if (leida !== undefined && leida > 0 && !esBulto) {
        const razon = Math.max(n, leida) / Math.min(n, leida);
        if (razon > 3 && !unDigitoEntero(n, leida)) continue;
      }
      if (cierra(n, u, p, importe)) {
        return { cantidad: n, uxb: k === null ? null : u, iPrecio: j, usados: k === null ? [] : [k], corregido: true };
      }
    }
  }
  return null;
}

/**
 * La cuenta no cierra ni ajustando la cantidad: se busca el número leído con UN
 * dígito mal, usando el precio con IVA como testigo.
 *  - El testigo confirma el precio y hay cantidad leída → el mal leído es el
 *    importe: vale cantidad × UxB × precio (si difiere en un dígito del leído).
 *  - El testigo contradice el precio → el precio es precio con IVA ÷ (1 + tasa);
 *    se acepta si con ése la cuenta cierra y difiere en un dígito del leído.
 * Sin testigo no se corrige nada: no hay forma de saber cuál de los dos números
 * está mal, y eso lo decide el usuario.
 */
function corregirPorTestigo(leidos: Numero[], corrida: Numero[], iImp: number): Solucion | null {
  const imp = corrida[iImp]!;
  for (let j = 0; j < iImp; j++) {
    const pn = corrida[j]!;
    if (pn.decimales === 0 || pn.valor === 0 || pn.cortado) continue;
    const tg = testigo(corrida, j, iImp);
    if (!tg) continue;
    const bultos: Array<number | null> = [];
    for (let k = j - 1; k >= 0; k--) if (esEnteroDeBulto(corrida[k]!)) bultos.push(k);
    bultos.push(null);

    if (tg.ok) {
      // Precio confirmado: con la cantidad leída, el importe sale de la cuenta.
      const q = leidos[0];
      if (!q) return null;
      for (const k of bultos) {
        const u = k === null ? 1 : corrida[k]!.valor;
        const calculado = r2(q.valor * u * pn.valor);
        const leido = Math.abs(imp.valor) * Math.sign(calculado);
        if (unDigitoDeDiferencia(calculado, leido)) {
          return {
            cantidad: q.valor,
            uxb: k === null ? null : u,
            iPrecio: j,
            usados: k === null ? [] : [k],
            corregido: true,
            importe: calculado,
            motivo: `Importe leído ${imp.cortado ? imp.texto : enPesos(imp.valor)}; por la cuenta es ${enPesos(calculado)}`,
          };
        }
      }
      return null;
    }

    // Precio contradicho por el testigo: se recalcula desde el precio con IVA.
    if (imp.cortado) return null;
    const base = r2(tg.conIva / (1 + tg.tasa / 100));
    const candidatos = [base, r2(base - 0.01), r2(base + 0.01)].filter(
      (p) => Math.abs(p * (1 + tg.tasa / 100) - tg.conIva) <= TOL_TESTIGO && unDigitoDeDiferencia(p, pn.valor),
    );
    const q = leidos[0]?.valor;
    const hallados: Solucion[] = [];
    for (const p of candidatos) {
      for (const k of bultos) {
        const u = k === null ? 1 : corrida[k]!.valor;
        const n = Math.round(imp.valor / (u * p));
        if (n < 1 || n > 9999 || !cierra(n, u, p, imp.valor)) continue;
        if (q !== undefined && q !== n) continue; // dos números mal en el mismo renglón: lo mira el usuario
        hallados.push({
          cantidad: n,
          uxb: k === null ? null : u,
          iPrecio: j,
          usados: k === null ? [] : [k],
          corregido: true,
          precio: p,
          motivo:
            `Precio leído ${enPesos(pn.valor)}; por el precio con IVA y el importe es ${enPesos(p)}` +
            (q === undefined ? ` (cantidad calculada: ${n})` : ''),
        });
        break;
      }
    }
    // Más de un precio posible: no se elige a ciegas.
    return hallados.length === 1 ? hallados[0]! : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Una línea → un renglón
// ---------------------------------------------------------------------------

interface LineaPartida {
  codigo: string | null;
  /** Números antes de la descripción (cantidad leída). */
  delante: Numero[];
  /** Unidad de la cantidad (`UN`, `BTO`…), si se leyó. */
  unidad: string | null;
  /** Tokens de la descripción. */
  desc: string[];
  /** Números del final. */
  corrida: Numero[];
  /** El último número de la línea (el importe) se leyó con un signo de más (`2:122,32`) y no se pudo interpretar. */
  ilegible: string | null;
}

/**
 * Un número que el lector rompió: trae dígitos pero no es un número. Un signo de
 * más en el medio (`2:122,32`), los decimales perdidos (`958,`, `-1124,`,
 * `4.958.`) o letras en lugar de dígitos (`n6,2A`, `6B`, `-14B,`). Sólo se
 * usa sobre la COLA de la línea, detrás del último número: ahí es el importe
 * que no se pudo leer (en la descripción, `x60gr` también calzaría).
 */
const RE_DANADO = /^(?=.*\d)-?[\dA-Za-z.,:;'`´%]{1,12}$/;
/** Cantidad leída sin la parte entera (`.00` por `7.00`): hubo una cantidad, pero vale cero. */
const RE_CANTIDAD_ROTA = /^[.,]\d{1,2}$/;

/** Marca de columna al final del renglón (`OF`, `PR`, `OB`…): no corta la corrida de números. */
const RE_MARCA = /^[A-Za-z*]{1,3}$/;
/**
 * Marca de birome leída como texto ENTRE dos números de la corrida (`x`, `X`,
 * `×`, `>`, `<`, `*`, `K`, `уx`): hasta 2 caracteres, sin dígitos.
 */
const RE_BIROME = /^[^\d\s]{1,2}$/;
/** Código de artículo: 5+ dígitos seguidos. Si la foto cortó el borde llega con basura adelante (`.76278`). */
const RE_CODIGO = /^[.,·'`]?(\d{5,})$/;
/** Código entre paréntesis (`(1047)`), al lado de la cantidad. */
const RE_CODIGO_PARENTESIS = /^\((\d{1,8})\)$/;
/** Viñetas y marcas sueltas al principio del renglón o de la descripción. */
const RE_VINETA = /^[•·▪■●○◦►▶»>*+_~^|¬°]+$/;
/** Marca de lista delante de la cantidad (`L5`, `A1`, leída a veces `Ł5`): letras y un número corto. */
const RE_MARCA_DE_LISTA = /^[A-Za-zÀ-ɏ]{1,2}\d{1,2}$/;
/** La misma marca de lista partida en dos cajas por el lector (`L` + `5`). */
const RE_LETRAS_DE_LISTA = /^[A-Za-zÀ-ɏ]{1,2}$/;
/** Palabra suelta que el lector agregó DESPUÉS del importe (`11280.01  NETFLIX`: un cartel del fondo de la foto). */
const RE_PALABRA_SUELTA = /^[A-Za-zÁÉÍÓÚÑáéíóúñ]{4,}$/;

/**
 * Saca lo que viene ANTES de la cantidad y no es del renglón: viñetas ("• 4.00
 * CERVEZA…") y marcas de lista ("L5 2 (1047) RON…", o la misma marca mal leída:
 * "Ls (2051) GIN…", "Ł5 (2051)…"). Sólo si lo que sigue es un número o un
 * código entre paréntesis: una palabra suelta no se toca.
 */
function sinPrefijo(linea: string, formato: FormatoNumeros): string {
  const toks = linea.split(' ');
  let k = 0;
  while (k < 2 && k + 2 < toks.length) {
    if (RE_VINETA.test(toks[k]!) || RE_MARCA_DE_LISTA.test(toks[k]!)) {
      k++;
      continue;
    }
    // "L 5 1 (1400) GASTOS…": la marca de lista llegó en dos cajas (letra y
    // número corto) y detrás viene la cantidad o el código.
    if (k + 3 < toks.length && RE_LETRAS_DE_LISTA.test(toks[k]!) && /^\d{1,2}$/.test(toks[k + 1]!)) {
      k += 2;
      continue;
    }
    // "Ls (2051) GIN…": una o dos letras sueltas (la marca de lista con el
    // número leído como letra) pegadas al código entre paréntesis.
    if (RE_LETRAS_DE_LISTA.test(toks[k]!) && RE_CODIGO_PARENTESIS.test(toks[k + 1]!)) {
      k++;
      continue;
    }
    break;
  }
  if (k === 0) return linea;
  const sig = toks[k]!;
  const n = aNumero(sig, formato);
  if (!(n && n.valor >= 0) && !RE_CODIGO_PARENTESIS.test(sig)) return linea;
  return toks.slice(k).join(' ');
}

/** Marca de birome suelta al frente de la descripción (`*`, `\`, `*.`, `-`, `+`): hasta 2 signos y un punto. */
const RE_MARCA_ADELANTE = /^[•·▪■●○◦►▶»>*+_~^|¬°\\-]{1,2}\.?$/;

/** Descripción sin las marcas de birome/viñetas que el lector dejó adelante ("* FANTA", "_AGUA", "\ COCA"). */
function limpiarDescripcion(toks: string[]): string {
  const t = [...toks];
  while (t.length > 1 && (RE_VINETA.test(t[0]!) || RE_MARCA_ADELANTE.test(t[0]!))) t.shift();
  if (t.length > 0) t[0] = t[0]!.replace(/^[_•·*]+(?=[A-Za-zÁÉÍÓÚÑáéíóúñ])/, '');
  return t.join(' ');
}

function partir(tokens: string[], formato: FormatoNumeros): LineaPartida {
  // El código va al principio (antes puede venir el n.º de renglón): la corrida no lo pisa.
  let iCodigo = -1;
  for (let i = 0; i < Math.min(3, tokens.length); i++) {
    if (RE_CODIGO.test(tokens[i]!)) {
      iCodigo = i;
      break;
    }
    if (!/^\d{1,4}$/.test(tokens[i]!)) break; // sólo se saltean números de renglón
  }

  // Cola de la línea: lo que viene detrás del último número. Se saltean hasta 4
  // tokens que son marcas de columna (`OF`, `PR`), una palabra suelta pegada
  // detrás de un importe con decimales (`NETFLIX`), signos sueltos (`O?`, `A.`)
  // o restos de un número roto (`2:122,32`, `958, 6B`, `1.090,`). Los restos
  // con dígitos son el importe que no se pudo leer: quedan como `ilegible`.
  let fin = tokens.length;
  const cola: string[] = [];
  while (fin > 0 && cola.length < 4 && !numeroDeToken(tokens[fin - 1]!, formato)) {
    const tok = tokens[fin - 1]!;
    const previo = fin >= 2 ? numeroDeToken(tokens[fin - 2]!, formato) : null;
    const esMarca = RE_MARCA.test(tok) || (RE_PALABRA_SUELTA.test(tok) && previo !== null && previo.decimales >= 2);
    if (!esMarca && !RE_DANADO.test(tok) && !RE_BIROME.test(tok)) break;
    cola.unshift(tok);
    fin--;
  }
  let ini = fin;
  const corrida: Numero[] = [];
  while (ini > iCodigo + 1) {
    const tok = tokens[ini - 1]!;
    const n = numeroDeToken(tok, formato);
    if (n) {
      corrida.unshift(n);
      ini--;
      continue;
    }
    // Marca de birome entre dos importes (`2599,00 x 6.443,79`): se saltea.
    const previo = ini - 2 > iCodigo ? numeroDeToken(tokens[ini - 2]!, formato) : null;
    const esLetraDeUnidad = tok.length > 1 && esUnidad(tok);
    if (corrida.length > 0 && RE_BIROME.test(tok) && !esLetraDeUnidad && previo && previo.decimales > 0) {
      ini--;
      continue;
    }
    break;
  }
  let ilegible: string | null = null;
  if (corrida.length === 0) {
    // Sin números: la cola era el final de la descripción.
    ini = tokens.length;
  } else {
    const conDigitos = cola.map((t, k) => (/\d/.test(t) ? k : -1)).filter((k) => k >= 0);
    if (conDigitos.length > 0) ilegible = cola.slice(conDigitos[0]!, conDigitos[conDigitos.length - 1]! + 1).join(' ');
  }
  const cabeza = tokens.slice(0, ini);

  let codigo: string | null = null;
  let desde = 0;
  if (iCodigo >= 0 && iCodigo < cabeza.length) {
    codigo = RE_CODIGO.exec(cabeza[iCodigo]!)![1]!;
    desde = iCodigo + 1;
  }

  // Cantidad leída: números chicos antes de la descripción, y su unidad.
  const delante: Numero[] = [];
  let unidad: string | null = null;
  let i = desde;
  const codigoEntreParentesis = (): void => {
    const m = codigo === null && i < cabeza.length ? RE_CODIGO_PARENTESIS.exec(cabeza[i]!) : null;
    if (m) {
      codigo = m[1]!;
      i++;
    }
  };
  codigoEntreParentesis();
  while (i < cabeza.length && delante.length < 3) {
    const tok = cabeza[i]!;
    // `.00` por `7.00`: la parte entera se perdió. Cuenta como cantidad leída (cero).
    const n = aNumero(tok, formato) ?? (RE_CANTIDAD_ROTA.test(tok) ? { valor: 0, decimales: tok.length - 1, texto: tok, cortado: true } : null);
    if (!n || n.valor < 0) break;
    delante.push(n);
    i++;
  }
  codigoEntreParentesis(); // "2 (1047) RON…": la cantidad va antes del código
  const anclado = delante.length > 0 || codigo !== null;
  if (i < cabeza.length && anclado) {
    const tok = cabeza[i]!;
    // Cantidad pegada a la unidad (`3UN`, `1BTO`).
    const pegada = /^(\d{1,4})([A-Za-z]{1,5})\.?$/.exec(tok);
    const hayMas = i < cabeza.length - 1 || codigo !== null;
    if (pegada && esUnidad(pegada[2]!) && delante.length === 0 && codigo !== null) {
      delante.push(aNumero(pegada[1]!, formato)!);
      unidad = pegada[2]!.toUpperCase();
      i++;
    } else if (esUnidad(tok) && hayMas) {
      unidad = tok.replace(/\.$/, '').toUpperCase();
      i++;
    } else if (codigo !== null && delante.length === 0 && unidadSucia(tok)) {
      unidad = unidadSucia(tok);
      i++;
    }
  }
  // Línea que es sólo números: los de adelante son parte de la corrida.
  return { codigo, delante, unidad, desc: cabeza.slice(i), corrida, ilegible };
}

const tieneLetras = (toks: string[]): boolean => toks.some((t) => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(t));
const esDinero = (n: Numero): boolean => n.decimales > 0 && !ALICUOTAS.has(Math.abs(n.valor));

/**
 * Datos internos de un renglón que no van en RenglonLeido:
 *  - `codigoCorto`: el número de adelante que no fue la cantidad (posible código
 *    de 2–6 cifras en la primera columna); se confirma con toda la factura;
 *  - `flojo`: renglón sin código y con un solo importe.
 */
interface Interno {
  codigoCorto?: string;
  /** La cantidad que muestra el renglón ES ese número de adelante (no hubo otra). */
  codigoComoCantidad?: boolean;
  flojo?: boolean;
}
const internos = new WeakMap<RenglonLeido, Interno>();

const MOTIVO_SIN_DESCRIPCION = 'Sin descripción: léala de la foto';
export const MOTIVO_PEGADO = 'Posible renglón pegado: dos productos en una línea';
export const MOTIVO_ILEGIBLE = 'Renglón ilegible: léalo de la foto';
export const MOTIVO_SIGNO_DESCUENTO = 'Signo recuperado: renglón de descuento';
const MOTIVO_SIGNO_SUELTO = 'Signo menos suelto delante de un importe: se tomó como una marca, no como descuento';
/**
 * Viñeta o asterisco en el MEDIO de la descripción seguido de otra palabra en
 * mayúsculas y algo más ("SPEED CON CAFE 24X24 • POWERADE MOUNTAIN BLAST"):
 * el lector pegó dos productos en una línea.
 */
const RE_PEGADO = /\S\s+[•·▪■●○◦►▶»*+_~^|¬]\s*[A-ZÁÉÍÓÚÑ]{3,}(?:\s+\S+)+/;

/** El motivo, anteponiendo el aviso de descripción faltante cuando corresponde. */
function conAvisoDeDescripcion(r: RenglonLeido, motivo: string | null): string | null {
  if (r.esDescuento || r.descripcion.trim() !== '' || motivo === MOTIVO_ILEGIBLE) return motivo;
  if (!motivo || motivo === MOTIVO_SIN_DESCRIPCION) return MOTIVO_SIN_DESCRIPCION;
  return motivo.startsWith(MOTIVO_SIN_DESCRIPCION) ? motivo : `${MOTIVO_SIN_DESCRIPCION}. ${motivo}`;
}

/** Importe o precio: número con al menos dos decimales que no es una alícuota ni cero. */
const esImporte = (n: Numero | null): n is Numero => n !== null && n.decimales >= 2 && n.valor !== 0 && !ALICUOTAS.has(Math.abs(n.valor));
/** Rótulos de pie en cualquier parte de la línea (no sólo al principio, como RE_PIE). */
const RE_PIE_ADENTRO =
  /(^|\s)(sub\s?-?\s?total|total(es)?|neto\s+gravado|i\.?\s?v\.?\s?a\.?|percep\w*|impuestos?|ing(resos)?\.?\s+brutos|ii\.?bb|bonif\w*|descuentos?|de?s?ctos?\.?|saldo|vuelto|cupones|son\s+pesos)(\s|:|$)/i;

/**
 * Dentro de la tabla, lo que no se entendió pero tiene pinta de renglón (un
 * importe con decimales; o la tasa de IVA con decimales y un número roto al
 * lado: `- 929, 21,00 -1124, as`) sale como renglón vacío en `revisar`, en su
 * lugar entre los demás, para que el usuario lo lea de la foto. Nunca se
 * inventa un número: sólo se llevan el código y las palabras de adelante.
 */
function renglonIlegible(cruda: string, formato: FormatoNumeros, hoja: number): RenglonLeido | null {
  if (RE_PIE.test(cruda) || RE_PIE_ADENTRO.test(cruda)) return null;
  const tokens = tokenizar(sinPrefijo(cruda, formato), formato);
  const numeros = tokens.map((t) => numeroDeToken(t, formato));
  const conDigitos = tokens.filter((t) => /\d/.test(t)).length;
  const hayImporte = numeros.some(esImporte);
  const hayTasa = numeros.some((n) => n !== null && n.decimales >= 2 && ALICUOTAS.has(Math.abs(n.valor)));
  const hayRoto = tokens.some((t, k) => numeros[k] === null && RE_DANADO.test(t));
  if (conDigitos < 2 || !(hayImporte || (hayTasa && hayRoto))) return null;
  let desde = 0;
  let codigo: string | null = null;
  for (let k = 0; k < Math.min(3, tokens.length); k++) {
    const m = RE_CODIGO.exec(tokens[k]!);
    if (m) {
      codigo = m[1]!;
      desde = k + 1;
      break;
    }
  }
  const palabras: string[] = [];
  for (let k = desde; k < tokens.length && !/\d/.test(tokens[k]!); k++) palabras.push(tokens[k]!);
  return {
    codigo,
    descripcion: tieneLetras(palabras) ? limpiarDescripcion(palabras) : '',
    cantidad: null,
    unidadesPorBulto: null,
    precioUnitario: null,
    importe: null,
    esDescuento: false,
    estado: 'revisar',
    motivo: MOTIVO_ILEGIBLE,
    original: cruda,
    hoja,
  };
}

/**
 * Encabezado de una sección de descuentos de la hoja ("****** PROMOCIONES
 * ******", "BONIFICACIONES", "Detalle de descuentos"): la palabra sola, con
 * adornos y sin ningún dígito. Una nota con la palabra adentro ("precios sin
 * descuento") no abre nada: tiene que ser el rótulo.
 */
const RE_ENCABEZADO_DESCUENTOS =
  /^[\W_]*(?:detalle\s+de\s+)?(?:promoci[oó]n(?:es)?|promos?|bonificaci[oó]n(?:es)?|descuentos?)(?:\s+aplicad[oa]s?)?[\W_]*$/i;

/**
 * Sección de descuentos, línea por línea: se abre con el encabezado y se cierra
 * con el pie ("Total Ahorro", subtotal, total…) o el final de la hoja.
 */
function seccionDeDescuentos(lineas: string[]): boolean[] {
  let adentro = false;
  return lineas.map((l) => {
    if (RE_ENCABEZADO_DESCUENTOS.test(l)) adentro = true;
    else if (adentro && (RE_PIE.test(l) || RE_PIE_ADENTRO.test(l))) adentro = false;
    return adentro;
  });
}

/** ¿Hay en la línea un importe negativo con el signo PEGADO (`-135,90`, `135,90-`)? El suelto (`- 135,90`) puede ser una marca. */
function hayNegativoPegado(linea: string, formato: FormatoNumeros): boolean {
  return tokenizar(linea, formato).some((t) => {
    const n = numeroDeToken(t, formato);
    return n !== null && !n.signoSuelto && n.valor < 0 && esDinero(n);
  });
}

/** ¿La línea termina con la marca de promoción "PR" (en la cola, detrás del último número)? */
function terminaEnPR(linea: string, formato: FormatoNumeros): boolean {
  const toks = linea.split(' ').filter(Boolean);
  for (let k = toks.length - 1, vistos = 0; k >= 0 && vistos < 4; k--, vistos++) {
    const tok = toks[k]!;
    if (numeroDeToken(tok, formato)) return false;
    if (tok.replace(/[.:]$/, '') === 'PR') return true;
  }
  return false;
}

/**
 * Un renglón de descuento al que el lector le perdió el signo menos del
 * importe o del precio ("… 112,31 21,00 -135,90 673,88 PR": el "-" sólo quedó
 * en el precio con IVA) saldría como una compra en positivo y en `ok`. Se lo
 * reconoce por tres señas, de la más firme a la más floja:
 *  - un número negativo con el signo pegado en la misma línea (el precio con
 *    IVA, el precio o el importe);
 *  - la marca "PR" (promoción) al final del renglón;
 *  - la línea está dentro de una sección de descuentos de la hoja.
 * Con cualquiera de las tres, importe y precio pasan a negativo, `esDescuento`
 * y el renglón nunca queda en `ok`: sale `corregido` con el motivo, o sigue en
 * `revisar` si ya estaba. Sin ninguna, se deja como está: la duda la resuelve
 * el usuario, no el parser.
 */
function recuperarSignoDeDescuento(r: RenglonLeido, linea: string, formato: FormatoNumeros, enDescuentos: boolean): void {
  const importePositivo = r.importe !== null && r.importe > 0;
  const precioPositivo = r.precioUnitario !== null && r.precioUnitario > 0;
  if (!importePositivo && !precioPositivo) return;
  if (!hayNegativoPegado(linea, formato) && !enDescuentos && !terminaEnPR(linea, formato)) return;
  if (r.importe !== null) r.importe = -Math.abs(r.importe);
  if (r.precioUnitario !== null) r.precioUnitario = -Math.abs(r.precioUnitario);
  r.esDescuento = true;
  if (r.estado === 'ok') r.estado = 'corregido';
  r.motivo = r.motivo === null || r.motivo === MOTIVO_SIGNO_SUELTO ? MOTIVO_SIGNO_DESCUENTO : `${MOTIVO_SIGNO_DESCUENTO}. ${r.motivo}`;
}

/**
 * `enTabla`: la línea está en la zona de renglones de la hoja. Ahí una línea con
 * pinta de renglón NUNCA se descarta: si no se entiende sale en `revisar`.
 * `enDescuentos`: la línea está dentro de una sección de descuentos de la hoja
 * (ver recuperarSignoDeDescuento).
 *
 * Lo que sale NUNCA queda en ok/corregido si le falta la descripción (la
 * birome la tapó: hay que leerla de la foto) ni si parece traer dos productos
 * pegados: en los dos casos va a `revisar` con el motivo. Y un renglón de
 * descuento nunca queda en `ok` con el importe en positivo.
 */
function renglonDeLinea(cruda: string, formato: FormatoNumeros, hoja: number, enTabla = false, enDescuentos = false): RenglonLeido | null {
  const r = renglonCrudo(cruda, formato, hoja, enTabla) ?? (enTabla ? renglonIlegible(cruda, formato, hoja) : null);
  if (!r) return null;
  recuperarSignoDeDescuento(r, cruda, formato, enDescuentos);
  if (!r.esDescuento && r.descripcion.trim() === '') {
    r.estado = 'revisar';
    r.motivo = conAvisoDeDescripcion(r, r.motivo);
  } else if (RE_PEGADO.test(r.descripcion)) {
    r.estado = 'revisar';
    r.motivo = MOTIVO_PEGADO;
  }
  return r;
}

function renglonCrudo(cruda: string, formato: FormatoNumeros, hoja: number, enTabla: boolean): RenglonLeido | null {
  if (/\*{4,}/.test(cruda)) return null;
  const original = cruda;
  // "( 704)" → "(704)": el código entre paréntesis es un solo token.
  let linea = cruda.replace(/\(\s*(\d{1,8})\s*\)/g, '($1)');
  if (!RE_PIE.test(linea)) linea = sinPrefijo(linea, formato);
  const tokens = tokenizar(linea, formato);
  const partida = partir(tokens, formato);
  const { codigo: codigoLeido, unidad, desc, ilegible } = partida;
  let { delante, corrida } = partida;

  // El importe se leyó con un signo de más ("… 453,72  21,00  549,00  2:122,32"):
  // el renglón no se pierde, sale en revisar con lo que sí se leyó. Si el
  // precio con IVA confirma el precio y hay cantidad, se propone el importe de
  // la cuenta (igual en revisar: lo confirma el usuario con la foto). Si la
  // cuenta cierra sin ese token, era una marca más y sigue el camino normal.
  if (ilegible !== null && corrida.length >= 1 && tieneLetras(desc) && (codigoLeido !== null || delante.some((n) => n.valor > 0) || enTabla)) {
    const leidos = delante.filter((n) => n.valor > 0);
    let iUltimo = corrida.length - 1;
    for (let k = corrida.length - 1; k >= 1; k--) if (corrida[k]!.decimales > 0) { iUltimo = k; break; }
    const cierraIgual = corrida.length >= 2 && resolver(leidos, corrida, iUltimo) !== null;
    if (!cierraIgual) {
      const iPrecio = corrida.findIndex(esDinero);
      let precio = iPrecio >= 0 ? corrida[iPrecio]!.valor : null;
      // El primer importe viene justo detrás de la tasa de IVA y antes no hay
      // ninguno: es el precio CON IVA (el neto también se rompió: "4.958.").
      // El neto se reconstruye desde ahí; igual queda en revisar.
      const tasaPrevia = iPrecio >= 1 ? corrida[iPrecio - 1]! : null;
      const reconstruido = precio !== null && tasaPrevia !== null && tasaPrevia.decimales > 0 && ALICUOTAS.has(tasaPrevia.valor) && !corrida.slice(0, iPrecio - 1).some(esDinero);
      if (reconstruido) precio = r2(precio! / (1 + tasaPrevia!.valor / 100));
      const q = leidos[0]?.valor ?? null;
      const tg = iPrecio >= 0 && !reconstruido ? testigo(corrida, iPrecio, corrida.length) : null;
      const porCuenta = q !== null && precio !== null && tg?.ok ? r2(q * precio) : null;
      return {
        codigo: codigoLeido,
        descripcion: limpiarDescripcion(desc),
        cantidad: q,
        unidadesPorBulto: null,
        precioUnitario: precio,
        importe: porCuenta,
        esDescuento: precio !== null && precio < 0,
        estado: 'revisar',
        motivo:
          (porCuenta !== null ? `Importe ilegible (${ilegible}); por la cuenta sería ${enPesos(porCuenta)}: confírmelo con la foto` : `Importe ilegible (${ilegible}): léalo de la foto`) +
          (reconstruido ? ` (precio calculado desde el precio con IVA: ${enPesos(precio!)})` : ''),
        original,
        hoja,
        ...(tg?.ok ? { tasaIva: tg.tasa } : reconstruido ? { tasaIva: tasaPrevia!.valor } : {}),
      };
    }
  }
  // Línea que es sólo números ("968  3,00  24,00  102,16  2.451,85"): la
  // birome tapó la descripción. El primer número es el código corto (o la
  // cantidad) y el resto, la corrida. Sólo se acepta si la cuenta cierra o si
  // está entre renglones reconocidos: un pie sin rótulo no tiene esa forma.
  let soloNumeros = false;
  const n0 = corrida[0];
  if (
    codigoLeido === null && desc.length === 0 && delante.length === 0 && corrida.length >= 4 &&
    n0 && n0.decimales === 0 && !n0.cortado && !n0.signoSuelto && /^\d{1,6}$/.test(n0.texto) &&
    corrida[corrida.length - 1]!.decimales > 0
  ) {
    delante = [n0];
    corrida = corrida.slice(1);
    soloNumeros = true;
  }
  // Con código adelante el renglón existe aunque no se haya leído la descripción.
  if (!tieneLetras(desc) && codigoLeido === null && !soloNumeros) return null;
  if (corrida.length < 2) {
    // Un renglón con un solo importe no se pierde: lo completa el usuario. Sin
    // código tiene que empezar con la cantidad (o estar entre renglones).
    const unico = corrida[0];
    if (!unico || unico.decimales === 0) return null;
    if (codigoLeido === null && unico.valor === 0) return null; // casillero en cero
    const cantidad = delante.find((n) => n.valor > 0)?.valor ?? null;
    if (codigoLeido === null) {
      if (cantidad === null && !enTabla) return null;
      if (RE_PIE.test(linea) || RE_PIE.test(desc.join(' '))) return null;
    }
    const flojo: RenglonLeido = {
      codigo: null,
      descripcion: limpiarDescripcion(desc),
      cantidad,
      unidadesPorBulto: null,
      precioUnitario: null,
      importe: unico.cortado ? null : r2(unico.valor),
      esDescuento: unico.valor < 0,
      estado: 'revisar',
      motivo: 'Faltan datos: se leyó un solo importe',
      original,
      hoja,
    };
    if (codigoLeido === null) {
      internos.set(flojo, { flojo: true });
      return flojo;
    }
    return {
      codigo: codigoLeido,
      descripcion: desc.join(' '),
      cantidad,
      unidadesPorBulto: null,
      precioUnitario: null,
      importe: unico.cortado ? null : r2(unico.valor),
      esDescuento: unico.valor < 0,
      estado: 'revisar',
      motivo: 'Faltan datos: se leyó un solo importe',
      original,
      hoja,
    };
  }

  // Signo menos suelto delante de un número, cuando los demás importes del
  // renglón son positivos y ninguno trae el menos pegado: es una marca de birome.
  const firmes = corrida.filter((n) => !n.signoSuelto && esDinero(n));
  let signoQuitado = false;
  if (firmes.length > 0 && firmes.every((n) => n.valor > 0)) {
    for (const n of corrida) {
      if (n.signoSuelto && n.valor < 0) {
        n.valor = -n.valor;
        signoQuitado = true;
      }
    }
  }

  // Importe: el último número con decimales (si ninguno tiene, el último).
  let iImp = corrida.length - 1;
  for (let k = corrida.length - 1; k >= 1; k--) {
    if (corrida[k]!.decimales > 0) {
      iImp = k;
      break;
    }
  }
  const imp = corrida[iImp]!;
  const leidos = delante.filter((n) => n.valor > 0);
  // Dentro de la tabla, una cantidad leída como cero (`.00`, `00`: se perdió la
  // parte entera) o una descripción también sostienen la cuenta: si importe ÷
  // precio da un entero, ésa es la cantidad. Fuera de la tabla hace falta el
  // código o una cantidad de verdad (un pie suelto no se vuelve renglón).
  const anclado =
    codigoLeido !== null ||
    leidos.length > 0 ||
    (enTabla && (delante.length > 0 || tieneLetras(desc)) && !RE_PIE_ADENTRO.test(desc.join(' ')));
  if (!anclado && RE_PIE.test(desc.join(' '))) return null;

  let codigo = codigoLeido;
  // Un importe cortado por el borde de la foto no entra en ninguna cuenta: sólo se reconstruye.
  let sol = imp.cortado ? null : resolver(leidos, corrida, iImp);
  // Sin código ni cantidad adelante, "precio = importe" solo no alcanza para ser renglón.
  if (sol && !anclado && sol.usados.length === 0) sol = null;
  const esBulto = unidad !== null && BULTOS.has(unidad);
  if (!sol && anclado) sol = resolverConBonificacion(leidos, corrida, iImp);
  if (!sol && anclado && unidad === null) sol = resolverPack(leidos, corrida, iImp, desc.join(' '));
  if (!sol && anclado) sol = corregirCantidad(corrida, iImp, leidos[0]?.valor, esBulto);
  if (!sol && anclado) sol = corregirPorTestigo(leidos, corrida, iImp);
  // Sin código ni cantidad y sin cuenta: fuera de la tabla no es un renglón;
  // entre renglones, sí (y sale en revisar).
  if (!sol && !anclado && !(enTabla && imp.decimales > 0 && !RE_PIE.test(linea))) return null;

  // Un solo número entero adelante, sin unidad: puede ser un código corto en la
  // primera columna (se decide mirando toda la factura, ver confirmarCodigosCortos).
  const d0 = delante[0];
  const posibleCodigo =
    codigoLeido === null && unidad === null && delante.length === 1 && d0!.decimales === 0 && d0!.valor > 0 && /^\d{2,6}$/.test(d0!.texto)
      ? d0!.texto
      : null;

  const importe = r2(imp.valor);
  const base = { esDescuento: importe < 0, original, hoja };

  // Sólo números y la cuenta no cierra: fuera de la tabla puede ser cualquier cosa.
  if (!sol && soloNumeros && !enTabla) return null;

  if (!sol) {
    // No cierra: se muestra lo leído para que lo corrija el usuario.
    const iPrecio = corrida.findIndex((n, k) => k < iImp && esDinero(n));
    const precio = iPrecio >= 0 ? corrida[iPrecio]!.valor : null;
    const uxb = corrida.slice(0, Math.max(iPrecio, 0)).find(esEnteroDeBulto)?.valor ?? null;
    const cantidad = leidos[0]?.valor ?? null;
    const tg = iPrecio >= 0 ? testigo(corrida, iPrecio, iImp) : null;
    let motivo = cantidad === null ? 'Falta la cantidad' : 'La cuenta no cierra: cantidad × precio ≠ importe';
    if (imp.cortado) motivo = `Importe cortado en la foto (${imp.texto})`;
    else if (tg && !tg.ok) motivo = 'El precio no coincide con el precio con IVA: revise precio y cantidad';
    const malo: RenglonLeido = {
      codigo,
      descripcion: limpiarDescripcion(desc),
      cantidad,
      unidadesPorBulto: cantidad !== null ? uxb : null,
      precioUnitario: precio,
      importe: imp.cortado ? null : importe,
      ...base,
      esDescuento: importe < 0 || (precio ?? 0) < 0,
      estado: 'revisar',
      motivo,
    };
    if (posibleCodigo !== null) internos.set(malo, { codigoCorto: posibleCodigo, codigoComoCantidad: true });
    return malo;
  }

  // Números de adelante que no fueron la cantidad: si hay dos y no hay código,
  // el primero es un código corto (proveedores con códigos de 3–4 cifras).
  if (!codigo && delante.length >= 2 && delante[0]!.decimales === 0 && /^\d{3,}$/.test(delante[0]!.texto)) {
    const usadaAdelante = !sol.corregido && sol.usados.length === 0 ? sol.cantidad : null;
    if (usadaAdelante === null || delante[0]!.valor !== usadaAdelante || delante[1]!.valor === usadaAdelante) {
      codigo = delante[0]!.texto;
    }
  }
  // Enteros al principio de la corrida que no entraron en la cuenta: eran el
  // final de la descripción ("… IQF X KG 10"), no una columna.
  const descripcion = [...desc];
  for (let k = 0; k < sol.iPrecio; k++) {
    if (sol.usados.includes(k) || corrida[k]!.decimales > 0) break;
    descripcion.push(corrida[k]!.texto);
  }

  let cantidad = sol.cantidad;
  let uxb = sol.uxb;
  let motivo: string | null = sol.motivo ?? null;
  let deducido = sol.corregido;
  if (!sol.corregido && esBulto && leidos.length === 0 && uxb === null && sol.usados.length === 1) {
    // "BTO … 10 1.230,58 … 12.305,80" sin cantidad leída: el entero pegado al
    // precio son las unidades por bulto, y la cuenta dice que es UN bulto.
    const n = corrida[sol.usados[0]!]!;
    if (esEnteroDeBulto(n)) {
      cantidad = 1;
      uxb = n.valor;
      deducido = true;
      motivo = `Cantidad calculada por el importe: 1 (bulto de ${uxb})`;
    }
  }
  if (sol.corregido && !sol.motivo) {
    const leida = leidos[0]?.valor;
    if (uxb === null && esBulto && cantidad > 1) {
      // Bulto sin "unidades por bulto" leídas: la cuenta sólo da el total de unidades.
      const total = cantidad;
      cantidad = leida !== undefined && Number.isInteger(leida) && total % leida === 0 && leida < total ? leida : 1;
      uxb = total / cantidad;
      motivo = `No se leyeron las unidades por bulto; por el importe son ${total} unidades en total (${cantidad} × ${uxb})`;
    } else {
      motivo =
        leida === undefined
          ? `Cantidad calculada por el importe: ${cantidad}`
          : `Cantidad leída ${leida}; por el importe corresponde ${cantidad}`;
    }
  }
  const final = sol.importe ?? importe;
  // Tasa de IVA del renglón: sólo si el precio con IVA la confirma (o si el
  // precio se reconstruyó justamente desde el precio con IVA).
  const tg = sol.bonificacion ? null : testigo(corrida, sol.iPrecio, iImp);
  const tasaIva = tg && (tg.ok || sol.precio !== undefined) ? tg.tasa : null;
  // La cantidad ya está en unidades: otro número de la línea (los bultos) por
  // el pack que dice la descripción da la cantidad ("12X500  6,00  72,00").
  // Así la pantalla no propone "× 12" sobre una cantidad que ya es de unidades.
  let packResuelto = false;
  let bultos: number | null = null;
  if (uxb === null && cantidad > 0) {
    const pack = packEnDescripcion(desc.join(' '));
    if (pack !== null && pack > 1) {
      const iCantidad = sol.deAdelante ? -1 : (sol.usados[0] ?? -1);
      const candidatos = [
        ...leidos.filter((n) => n.texto !== posibleCodigo && !(sol!.deAdelante && n.valor === cantidad)),
        ...corrida.slice(0, sol.iPrecio).filter((_, k) => k !== iCantidad),
      ];
      const q2 = candidatos.find((n) => n.valor > 0 && Math.abs(n.valor * pack - cantidad) <= 0.01);
      if (q2) {
        packResuelto = true;
        bultos = q2.valor;
      }
    }
  }
  const bueno: RenglonLeido = {
    codigo,
    descripcion: limpiarDescripcion(descripcion),
    cantidad,
    unidadesPorBulto: uxb,
    precioUnitario: sol.precio ?? corrida[sol.iPrecio]!.valor,
    importe: final,
    ...base,
    esDescuento: final < 0,
    estado: deducido || signoQuitado ? 'corregido' : 'ok',
    motivo: motivo ?? (signoQuitado ? MOTIVO_SIGNO_SUELTO : null),
    tasaIva,
    ...(packResuelto ? { packResuelto: true, bultos } : {}),
  };
  if (posibleCodigo !== null && codigo === null) {
    if (!sol.deAdelante && !sol.corregido) internos.set(bueno, { codigoCorto: posibleCodigo });
    else if (sol.corregido && !sol.bonificacion && !sol.deAdelante) internos.set(bueno, { codigoCorto: posibleCodigo, codigoComoCantidad: true });
  }
  return bueno;
}

/**
 * Código corto en la primera columna ("1023 AGUA … 6,00 72,00 37,03 2.665,87").
 * Un número suelto adelante puede ser el código o la cantidad: es el código
 * cuando la cantidad salió de otra columna, y sólo se acepta si la factura lo
 * muestra en varios renglones (2 o más, y al menos la mitad de los que no
 * traen otro código). Con el patrón confirmado, en los renglones donde ese
 * número se había tomado por cantidad leída también pasa a ser el código.
 */
function confirmarCodigosCortos(renglones: RenglonLeido[]): void {
  const firmes = renglones.filter((r) => {
    const x = internos.get(r);
    return x?.codigoCorto !== undefined && !x.codigoComoCantidad;
  });
  const sinCodigo = renglones.filter((r) => r.codigo === null && !r.esDescuento && !internos.get(r)?.flojo);
  if (firmes.length < 2 || firmes.length * 2 < sinCodigo.length) return;
  for (const r of renglones) {
    const x = internos.get(r);
    if (x?.codigoCorto === undefined || r.codigo !== null) continue;
    r.codigo = x.codigoCorto;
    if (!x.codigoComoCantidad) continue;
    if (r.estado === 'revisar') {
      r.cantidad = null;
      r.unidadesPorBulto = null;
      r.motivo = conAvisoDeDescripcion(r, 'Falta la cantidad');
    } else if (r.cantidad !== null) {
      r.motivo = conAvisoDeDescripcion(r, `Cantidad calculada por el importe: ${r.cantidad}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Documentos sin importe por renglón (listas de precios, pedidos)
// ---------------------------------------------------------------------------

/**
 * Mejor esfuerzo para documentos donde no hay cuenta que controlar:
 *  - "cantidad [unidad] descripción" y el precio solo en una de las 2 líneas siguientes;
 *  - "descripción precio" en la misma línea.
 * Todo sale en `revisar`: sin importe no hay forma de confirmar lo leído.
 */
function renglonesSinImporte(lineas: string[], formato: FormatoNumeros, hoja: number): RenglonLeido[] {
  const out: RenglonLeido[] = [];
  const soloNumero = (l: string): Numero | null => {
    const t = tokenizar(l, formato);
    return t.length === 1 ? numeroDeToken(t[0]!, formato) : null;
  };
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]!;
    if (/\*{4,}/.test(linea)) continue;
    const tokens = tokenizar(linea, formato).map((t) => (t.startsWith(SUELTO) ? `-${t.slice(1)}` : t));
    if (tokens.length < 2) continue;

    // Código al principio, si lo hay.
    let k = 0;
    let codigo: string | null = null;
    if (/^\d{5,}$/.test(tokens[0]!)) {
      codigo = tokens[0]!;
      k = 1;
    }
    const q = k < tokens.length ? aNumero(tokens[k]!, formato) : null;
    let resto = tokens.slice(k);
    if (q && q.valor > 0) {
      resto = tokens.slice(k + 1);
      if (resto.length > 1 && esUnidad(resto[0]!)) resto = resto.slice(1);
      else if (resto.length === 1 && esUnidad(resto[0]!)) resto = [];
    }
    if (!tieneLetras(resto)) continue;
    if (!codigo && RE_PIE.test(resto.join(' '))) continue;

    // Precio en la misma línea (último token, con decimales).
    const ultimo = aNumero(resto[resto.length - 1]!, formato);
    let precio: number | null = null;
    let desc = resto;
    let original = linea;
    if (ultimo && ultimo.decimales > 0 && ultimo.valor > 0 && tieneLetras(resto.slice(0, -1))) {
      precio = ultimo.valor;
      desc = resto.slice(0, -1);
    } else if (q && q.valor > 0) {
      // Precio solo, una o dos líneas más abajo (en el medio puede venir la marca).
      for (let d = 1; d <= 2 && i + d < lineas.length; d++) {
        const n = soloNumero(lineas[i + d]!);
        if (n && n.valor > 0) {
          precio = n.valor;
          original = lineas.slice(i, i + d + 1).join(' | ');
          i += d;
          break;
        }
        if (/^\d/.test(lineas[i + d]!)) break; // ya empezó el renglón siguiente
      }
    }
    if (precio === null) continue;
    const cantidad = q && q.valor > 0 ? q.valor : null;
    out.push({
      codigo,
      descripcion: desc.join(' '),
      cantidad,
      unidadesPorBulto: null,
      precioUnitario: precio,
      importe: null,
      esDescuento: false,
      estado: 'revisar',
      motivo: cantidad === null ? 'Falta la cantidad' : 'Sin importe para controlar',
      original,
      hoja,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Un código SOLO en una línea (5 dígitos o más, nada más) no se tira, pero
 * tampoco se le cree a ciegas. ¿De qué renglón es?
 *  - La hoja tiene columna de código (otros renglones lo traen en su línea):
 *    la inclinación de la foto lo separó de su renglón. Va al renglón
 *    SIGUIENTE sin código. Si el anterior también quedó sin código, no se sabe
 *    de cuál es: se pega igual, pero marcado `codigoSuelto`.
 *  - La hoja NO tiene columna de código: el proveedor imprime el código en una
 *    línea aparte, encima o debajo de cada producto (el código de barras
 *    debajo de la descripción es lo típico). Si la hoja arranca con un renglón
 *    y recién después viene el código, están debajo: cada código va al
 *    renglón ANTERIOR; si no, al siguiente. Siempre `codigoSuelto`: pegado al
 *    renglón equivocado vincularía TODA la factura corrida en uno (y como los
 *    EAN son válidos, sin aviso).
 * Nunca se pisa un código ni un posible código corto que el renglón ya tenía.
 */
function pegarCodigosSueltos(
  lineas: string[],
  porLinea: Array<RenglonLeido | null>,
  esCodigoSuelto: (l: string) => RegExpExecArray | null,
): void {
  const sueltos: number[] = [];
  const filas: number[] = [];
  let conColumna = 0;
  for (let n = 0; n < lineas.length; n++) {
    if (esCodigoSuelto(lineas[n]!)) sueltos.push(n);
    else if (porLinea[n]) {
      filas.push(n);
      if (porLinea[n]!.codigo !== null) conColumna++;
    }
  }
  if (sueltos.length === 0 || filas.length === 0) return;
  const admite = (r: RenglonLeido | null | undefined): r is RenglonLeido =>
    !!r && r.codigo === null && !r.esDescuento && internos.get(r)?.codigoCorto === undefined;
  const debajo = conColumna === 0 && sueltos.length >= 2 && filas[0]! < sueltos[0]!;
  for (const n of sueltos) {
    const codigo = esCodigoSuelto(lineas[n]!)![1]!;
    const siguiente = filas.find((i) => i > n);
    const anterior = [...filas].reverse().find((i) => i < n);
    // Entre el código y el renglón al que va no puede haber otro código suelto.
    const limpio = (desde: number, hasta: number): boolean => !sueltos.some((s) => s > desde && s < hasta);
    const destino = debajo
      ? anterior !== undefined && limpio(anterior, n) ? porLinea[anterior] : null
      : siguiente !== undefined && limpio(n, siguiente) ? porLinea[siguiente] : null;
    if (!admite(destino)) continue;
    destino.codigo = codigo;
    // Con columna de código y el renglón anterior también sin código, no se
    // sabe de cuál de los dos es.
    const ambiguo = conColumna > 0 && anterior !== undefined && admite(porLinea[anterior]) && porLinea[anterior] !== destino;
    if (conColumna === 0 || ambiguo) destino.codigoSuelto = true;
  }
}

/** Renglones de una hoja, sin confirmar todavía los códigos cortos. */
function parsearHoja(texto: string, opciones: OpcionesParser): RenglonLeido[] {
  const hoja = opciones.hoja ?? 1;
  if (typeof texto !== 'string' || !texto.trim()) return [];
  try {
    const formato = opciones.formato ?? detectarFormato(texto);
    const lineas = aLineas(texto);
    const porLinea: Array<RenglonLeido | null> = lineas.map(() => null);
    const enDescuentos = seccionDeDescuentos(lineas);
    const esCodigoSuelto = (l: string): RegExpExecArray | null => /^[.,·'`]?(\d{5,})$/.exec(l);
    for (let n = 0; n < lineas.length; n++) {
      if (!esCodigoSuelto(lineas[n]!)) porLinea[n] = renglonDeLinea(lineas[n]!, formato, hoja, false, enDescuentos[n]);
    }
    // Segunda pasada: las líneas que quedaron ENTRE renglones reconocidos y
    // tienen pinta de renglón no se pierden en silencio (salen en revisar).
    const esFirme = (r: RenglonLeido | null): boolean => r !== null && !internos.get(r)?.flojo;
    const primero = porLinea.findIndex(esFirme);
    let ultimo = -1;
    for (let n = porLinea.length - 1; n >= 0 && ultimo < 0; n--) if (esFirme(porLinea[n]!)) ultimo = n;
    for (let n = primero + 1; primero >= 0 && n < ultimo; n++) {
      if (porLinea[n] === null && !esCodigoSuelto(lineas[n]!)) porLinea[n] = renglonDeLinea(lineas[n]!, formato, hoja, true, enDescuentos[n]);
    }
    // Tercera pasada: la tabla no empieza en el primer renglón reconocido ni
    // termina en el último. Hacia arriba y hacia abajo, cada línea contigua con
    // un importe con decimales (y sin rótulo de pie) es también de la tabla
    // (".00 CERVEZA IMPERIAL … 1620.00 11340.00" arriba del primer renglón que
    // cerró); la primera que no lo parece la cierra.
    const pareceDeLaTabla = (l: string): boolean =>
      !RE_PIE.test(l) && !RE_PIE_ADENTRO.test(l) && tokenizar(l, formato).some((t) => esImporte(numeroDeToken(t, formato)));
    const extender = (desde: number, paso: 1 | -1): void => {
      for (let n = desde; n >= 0 && n < lineas.length; n += paso) {
        if (porLinea[n] !== null || esCodigoSuelto(lineas[n]!)) continue;
        if (!pareceDeLaTabla(lineas[n]!)) break;
        const r = renglonDeLinea(lineas[n]!, formato, hoja, true, enDescuentos[n]);
        if (!r) break;
        porLinea[n] = r;
      }
    };
    if (primero >= 0) {
      extender(primero - 1, -1);
      extender(ultimo + 1, 1);
    }
    const renglones: RenglonLeido[] = [];
    for (let n = 0; n < lineas.length; n++) if (porLinea[n]) renglones.push(porLinea[n]!);
    pegarCodigosSueltos(lineas, porLinea, esCodigoSuelto);
    // Sólo renglones flojos (sin código y con un único número): es un documento
    // sin importe por renglón (lista de precios, pedido).
    if (primero < 0) {
      const sinImporte = renglonesSinImporte(lineas, formato, hoja);
      if (sinImporte.length > 0 || renglones.length === 0) return sinImporte;
    }
    return renglones;
  } catch {
    return [];
  }
}

/** Renglones de UNA hoja. Nunca tira: un texto ilegible devuelve `[]`. */
export function parsearTexto(texto: string, opciones: OpcionesParser = {}): RenglonLeido[] {
  const renglones = parsearHoja(texto, opciones);
  confirmarCodigosCortos(renglones);
  return renglones;
}

/** Cuántos renglones del borde de cada hoja se comparan con la hoja vecina. */
const BORDE_DE_HOJA = 3;
export const MOTIVO_REPETIDO = 'Posible renglón repetido entre hojas: revise que no esté cargado dos veces';

function mismoRenglon(a: RenglonLeido, b: RenglonLeido): boolean {
  if (a.esDescuento || b.esDescuento) return false;
  if (a.importe === null || a.cantidad === null) return false;
  if (a.cantidad !== b.cantidad || a.precioUnitario !== b.precioUnitario || a.importe !== b.importe) return false;
  if (a.codigo !== null || b.codigo !== null) return a.codigo === b.codigo;
  return a.descripcion.trim() !== '' && a.descripcion === b.descripcion;
}

/**
 * Renglones de una factura de varias hojas, en orden. El formato de números se
 * decide con TODAS las hojas juntas (una hoja con dos renglones no alcanza para
 * votar). No se quitan repetidos: dos renglones iguales son legítimos
 * (promociones). Pero cuando dos fotos se solapan, el renglón del borde sale
 * en las dos hojas: si uno de los primeros de una hoja es idéntico (código,
 * cantidad, precio e importe) a uno de los últimos de la anterior, el segundo
 * queda en `revisar`. No se borra: decide el usuario.
 */
export function unirHojas(textos: string[]): RenglonLeido[] {
  const validos = textos.map((t) => (typeof t === 'string' ? t : ''));
  const formato = detectarFormato(validos.join('\n'));
  const hojas = validos.map((t, i) => parsearHoja(t, { hoja: i + 1, formato }));
  // El patrón de código corto se decide con todas las hojas (una hoja puede traer un solo renglón).
  confirmarCodigosCortos(hojas.flat());
  for (let h = 1; h < hojas.length; h++) {
    // La hoja anterior con renglones (puede haber una hoja sin nada en el medio).
    let previa: RenglonLeido[] = [];
    for (let k = h - 1; k >= 0 && previa.length === 0; k--) previa = hojas[k]!;
    const cola = previa.slice(-BORDE_DE_HOJA);
    for (const r of hojas[h]!.slice(0, BORDE_DE_HOJA)) {
      if (cola.some((p) => mismoRenglon(p, r))) {
        r.estado = 'revisar';
        r.motivo = MOTIVO_REPETIDO;
      }
    }
  }
  return hojas.flat();
}

// ---------------------------------------------------------------------------
// Totales del pie
// ---------------------------------------------------------------------------

export interface TotalesLeidos {
  total: number | null;
  subtotal: number | null;
}

const RE_ROTULO_TOTAL =
  /(sub\s?-?\s?total|(?:importe\s+)?total(?:\s+(?:a\s+pagar|final|general|factura|comprobante|pesos))?)\s*[:.]?\s*/gi;

/**
 * Total y subtotal impresos en el pie ("TOTAL: 48122.16", "Importe Total: $
 * 27070.", "Subtotal: $ 49.519,40 … Total: $ 49.519,40"). Sirve para controlar
 * la suma de los renglones. Toma el número que sigue al rótulo (si hay varios
 * seguidos, el último con decimales: "TOTAL 1 1.998,00"), tolera el total
 * cortado ("27070.") y, si el rótulo aparece más de una vez, se queda con el
 * último que trae decimales. "Total Ahorro", "Total IVA" y similares no cuentan:
 * después del rótulo tiene que venir el número.
 */
export function totalesDelTexto(texto: string, formato?: FormatoNumeros): TotalesLeidos {
  const out: TotalesLeidos = { total: null, subtotal: null };
  if (typeof texto !== 'string' || !texto.trim()) return out;
  try {
    const fmt = formato ?? detectarFormato(texto);
    const firme = { total: false, subtotal: false };
    for (const linea of aLineas(texto)) {
      RE_ROTULO_TOTAL.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RE_ROTULO_TOTAL.exec(linea)) !== null) {
        const antes = linea.slice(0, m.index);
        if (/[A-Za-zÁÉÍÓÚÑáéíóúñ]$/.test(antes)) continue; // "Subtot", "Subtotal" ya contado, "Pretotal"
        const clave = /^sub/i.test(m[1]!) ? 'subtotal' : 'total';
        let elegido: Numero | null = null;
        for (const tok of linea.slice(m.index + m[0].length).split(' ')) {
          if (tok === '' || tok === '$') continue;
          const n = aNumero(tok.replace(/^\$/, '').replace(/[.,]-?$/, ''), fmt);
          if (!n || n.valor < 0) break;
          if (!elegido || n.decimales > 0 || elegido.decimales === 0) elegido = n;
        }
        if (!elegido) continue;
        const conDecimales = elegido.decimales > 0;
        if (out[clave] !== null && firme[clave] && !conDecimales) continue;
        out[clave] = r2(elegido.valor);
        firme[clave] = conDecimales;
      }
    }
  } catch {
    /* un pie ilegible no rompe nada */
  }
  return out;
}
