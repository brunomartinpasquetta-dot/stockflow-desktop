/**
 * Facturas de compra por teléfono — encabezado leído del TEXTO de la factura.
 *
 * Cuando la foto no trae el QR fiscal (o no se pudo leer), los datos del
 * comprobante igual están impresos: CUIT del emisor, razón social, número,
 * fecha, letra, total y CAE. Acá se sacan del texto que devolvió el lector,
 * sin otra IA y sin nombres de proveedores: sólo rótulos y formatos.
 *
 * Es mejor esfuerzo: lo que no se puede leer con seguridad queda en `null`
 * (nunca se inventa). El CUIT se valida con su dígito verificador, así que un
 * CUIT leído con un dígito mal no sale.
 *
 * Sin Electron ni base de datos: se prueba con tsx (facturas-reales.smoke.ts).
 */
import { detectarFormato, totalesDelTexto } from './parser';

export interface EncabezadoLeido {
  /** CUIT del EMISOR (el proveedor), sólo dígitos. */
  cuit: string | null;
  razonSocial: string | null;
  /** `0011-00030638` (punto de venta y número). */
  numero: string | null;
  /** Fecha de emisión, `YYYY-MM-DD`. */
  fecha: string | null;
  letra: 'A' | 'B' | 'C' | null;
  total: number | null;
  cae: string | null;
  /**
   * Otros nombres del emisor que trae la hoja (nombre de fantasía, "Razón
   * Social:", "de X S.A."), para buscar al proveedor si el CUIT no alcanza.
   */
  otrosNombres: string[];
}

export interface OpcionesEncabezado {
  /** CUIT del negocio que usa StockFlow: nunca es el del proveedor. */
  cuitPropio?: string | null;
  /**
   * Otros CUIT que tampoco pueden ser el del emisor: los que ya aparecieron
   * como "emisor" en facturas de proveedores distintos (son del que compra).
   */
  cuitsDescartados?: readonly string[];
}

interface Linea {
  texto: string;
  /** Columnas de la línea (el lector separa las columnas con 2+ espacios). */
  partes: string[];
  hoja: number;
  /** Posición dentro de todas las hojas. */
  n: number;
}

const soloDigitos = (s: string): string => s.replace(/\D/g, '');

const PREFIJOS_CUIT = new Set(['20', '23', '24', '25', '26', '27', '30', '33', '34']);

/** CUIT bien formado: 11 dígitos, prefijo que existe y dígito verificador (módulo 11). */
export function cuitValido(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit) || !PREFIJOS_CUIT.has(cuit.slice(0, 2))) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let suma = 0;
  for (let i = 0; i < 10; i++) suma += Number(cuit[i]) * pesos[i]!;
  const resto = 11 - (suma % 11);
  const dv = resto === 11 ? 0 : resto === 10 ? -1 : resto;
  return dv === Number(cuit[10]);
}

function aLineas(textos: string[]): Linea[] {
  const out: Linea[] = [];
  textos.forEach((t, hoja) => {
    if (typeof t !== 'string') return;
    for (const cruda of t.replace(/\r\n?/g, '\n').split('\n')) {
      const texto = cruda.replace(/[\t ]/g, ' ').trim();
      if (!texto) continue;
      out.push({ texto, partes: texto.split(/ {2,}/).map((p) => p.trim()).filter(Boolean), hoja: hoja + 1, n: out.length });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Bloque del cliente
// ---------------------------------------------------------------------------

/** Donde empiezan los datos del cliente (de ahí en más, un CUIT es del que compra). */
const RE_INICIO_CLIENTE = /^(cliente\b|se[ñn]or(es)?\b|sr(es)?\.?\s*:|apellido y nombre|nombre\s*\/\s*raz[oó]n)/i;
/** Palabras que, en la misma línea que un CUIT, dicen que es el del cliente. */
const RE_ES_CLIENTE = /cliente|monotribut|consumidor\s+final|se[ñn]or(es)?\b|\bsr(es)?\.|apellido y nombre/i;
/**
 * Lo que rodea al CUIT del que COMPRA cuando la hoja no trae (o no se leyó)
 * la palabra "cliente": su condición de IVA en la línea de arriba, y abajo la
 * condición de venta o la dirección de entrega.
 */
const RE_CERCA_DE_CLIENTE = /cliente|se[ñn]or(es)?\b|\bsr(es)?\.|consumidor\s+final|apellido y nombre|condici[oó]n\s+de\s+venta|direcci[oó]n\s+de\s+(env[ií]o|entrega)|domicilio\s+de\s+entrega|lugar\s+de\s+entrega/i;
const RE_CONDICION_IVA_ARRIBA = /monotribut|consumidor\s+final|condici[oó]n\s+(frente\s+al\s+)?i\.?\s?v\.?\s?a/i;
/** Lo que acompaña al CUIT del EMISOR: ingresos brutos e inicio de actividades. */
const RE_CERCA_DE_EMISOR = /ing(resos)?\.?\s*brutos|\bi\.?\s?i\.?\s?b\.?\s?b\b|inicio\s+(de\s+)?act/i;
/** Cuántas líneas dura el bloque del cliente desde su comienzo. */
const LINEAS_DE_CLIENTE = 8;

function inicioDeCliente(lineas: Linea[]): number {
  const i = lineas.findIndex((l) => RE_INICIO_CLIENTE.test(l.texto));
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

// ---------------------------------------------------------------------------
// CUIT
// ---------------------------------------------------------------------------

/** Rótulo de CUIT, con los errores comunes de lectura ("CUTT:", "C.U.I.T.:", "CUlT"). */
const RE_ROTULO_CUIT = /c\.?\s?u\.?\s?[il1t]\.?\s?t\.?/i;
/**
 * CUIT del emisor. Un CUIT válido en la hoja puede ser el del que compra: sólo
 * sale el que tiene alguna señal de ser del emisor (está arriba del bloque del
 * cliente, o al lado de ingresos brutos / inicio de actividades, o debajo del
 * nombre destacado del emisor) y ninguna de ser del cliente. Ante la duda,
 * null: un CUIT equivocado crearía un proveedor con el CUIT del propio comercio.
 */
function leerCuit(lineas: Linea[], cliente: number, descartados: ReadonlySet<string>, hayNombre: boolean): string | null {
  interface Candidato {
    cuit: string;
    puntos: number;
    n: number;
  }
  const candidatos: Candidato[] = [];
  for (const l of lineas) {
    const re = /(?<![\d-])(\d{2})[-\s.]?(\d{8})[-\s.]?(\d)(?![\d])(?!-\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.texto)) !== null) {
      const cuit = `${m[1]}${m[2]}${m[3]}`;
      if (!cuitValido(cuit) || descartados.has(cuit)) continue;
      const antes = l.texto.slice(0, m.index);
      // El rótulo pegado al número (hasta 12 caracteres antes: "CUIT N°: ").
      const rotulado = RE_ROTULO_CUIT.test(antes.slice(-22));
      const enBloqueCliente = l.n >= cliente && l.n < cliente + LINEAS_DE_CLIENTE;
      const esCliente = enBloqueCliente || RE_ES_CLIENTE.test(l.texto);
      if (esCliente) continue;
      const vecinas = (desde: number, hasta: number): string =>
        lineas
          .filter((x) => x.hoja === l.hoja && x.n !== l.n && x.n >= l.n + desde && x.n <= l.n + hasta)
          .map((x) => x.texto)
          .join('\n');
      const deEmisor = RE_CERCA_DE_EMISOR.test(l.texto) || RE_CERCA_DE_EMISOR.test(vecinas(-2, 3));
      const hayCliente = Number.isFinite(cliente);
      if (!deEmisor) {
        // Rodeado de datos del que compra (y sin nada del emisor): es del cliente.
        if (RE_CERCA_DE_CLIENTE.test(vecinas(-2, 2)) && !(hayCliente && l.n < cliente)) continue;
        if (RE_CONDICION_IVA_ARRIBA.test(vecinas(-2, -1)) && !(hayCliente && l.n < cliente)) continue;
        // Sin ninguna señal de emisor (ni nombre destacado arriba, ni bloque
        // del cliente más abajo): no se puede saber de quién es.
        if (!hayNombre && !(hayCliente && l.n < cliente)) continue;
      }
      // Arriba del bloque del cliente y con rótulo es lo más firme.
      const puntos = (l.n < cliente ? 2 : 0) + (deEmisor ? 2 : 0) + (rotulado ? 1 : 0) + (l.hoja === 1 ? 1 : 0);
      candidatos.push({ cuit, puntos, n: l.n });
    }
  }
  candidatos.sort((a, b) => b.puntos - a.puntos || a.n - b.n);
  return candidatos[0]?.cuit ?? null;
}

// ---------------------------------------------------------------------------
// Número, fecha, letra, CAE
// ---------------------------------------------------------------------------

const relleno = (s: string, largo: number): string => (s.length >= largo ? s : '0'.repeat(largo - s.length) + s);

function leerNumero(lineas: Linea[]): string | null {
  // "Punto de Venta: 0001  Comp. Nro: 00017141"
  for (const l of lineas) {
    const m = /p(?:unto|to)\.?\s*(?:de\s*)?v(?:enta|ta)\.?\s*:?\s*(\d{1,5})\b.{0,40}?\b(?:comp\w*\.?|n[uú]mero|nro\.?|n[°º])\s*(?:n(?:ro|[°ºo])?\.?)?\s*:?\s*(\d{1,8})\b/i.exec(l.texto);
    if (m) return `${relleno(m[1]!, 4)}-${relleno(m[2]!, 8)}`;
  }
  // "0011-00030638", "N°: 0004-00019142" (no el n.º de remito ni el de pedido).
  for (const l of lineas) {
    const re = /(?<![\d-])(\d{4,5})\s?-\s?(\d{8})(?![\d-])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.texto)) !== null) {
      const numero = `${m[1]}-${m[2]}`;
      const antes = l.texto.slice(0, m.index);
      if (/^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) continue; // casillero vacío
      if (/(remito|pedido|orden(\s+de\s+compra)?|recibo|asociado)\s*(n(ro|[°ºo])?\.?)?\s*:?\s*$/i.test(antes) && !/factura/i.test(antes)) continue;
      return numero;
    }
  }
  return null;
}

/** Lo que hay antes de una fecha y dice que NO es la de emisión. */
const RE_NO_ES_EMISION = /inici|activ|actt|vto|venc|c\.?\s?a\.?\s?e\b|pago|entrega|impres/i;

function leerFecha(lineas: Linea[]): string | null {
  let sinRotulo: string | null = null;
  for (const l of lineas) {
    const re = /(?<![\d/.-])(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?![\d/])/g;
    let desde = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.texto)) !== null) {
      // El rótulo es lo que está entre la fecha anterior (o el principio) y ésta.
      const antes = l.texto.slice(desde, m.index).slice(-45);
      desde = m.index + m[0].length;
      const dia = Number(m[1]);
      const mes = Number(m[2]);
      const anio = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      if (dia < 1 || dia > 31 || mes < 1 || mes > 12 || anio < 2000 || anio > 2100) continue;
      if (RE_NO_ES_EMISION.test(antes)) continue;
      const fecha = `${anio}-${relleno(String(mes), 2)}-${relleno(String(dia), 2)}`;
      if (/fecha/i.test(antes)) return fecha;
      sinRotulo ??= fecha;
    }
  }
  return sinRotulo;
}

/** Código de comprobante de ARCA → letra. */
const LETRA_POR_CODIGO: Record<string, 'A' | 'B' | 'C'> = {
  '1': 'A', '2': 'A', '3': 'A', '6': 'B', '7': 'B', '8': 'B', '11': 'C', '12': 'C', '13': 'C',
};

function leerLetra(lineas: Linea[], cliente: number): 'A' | 'B' | 'C' | null {
  const arriba = lineas.filter((l) => l.n < Math.min(cliente, 14));
  for (const l of arriba) {
    const m = /\bfactura\s+["'«]?([ABC])["'»]?(?![\w°º])/i.exec(l.texto) ?? /(?:^|\s)["'«]?([ABC])["'»]?\s+factura\b/i.exec(l.texto);
    if (m) return m[1]!.toUpperCase() as 'A' | 'B' | 'C';
  }
  // La letra sola en su recuadro.
  for (const l of arriba) {
    const sola = l.partes.find((p) => /^[ABC]$/.test(p));
    if (sola) return sola as 'A' | 'B' | 'C';
  }
  // "COD. 06", "CODIGO N° 06" (a veces el número queda en la línea de abajo).
  for (let i = 0; i < arriba.length; i++) {
    const l = arriba[i]!;
    const m = /\bc[oó]d(?:igo)?\.?\s*(?:n[°ºo]\.?)?\s*:?\s*0*(\d{1,2})\b(?!\s?-\s?\d)/i.exec(l.texto);
    if (m && LETRA_POR_CODIGO[m[1]!]) return LETRA_POR_CODIGO[m[1]!]!;
    if (/\bc[oó]d(?:igo)?\b/i.test(l.texto) && arriba[i + 1]) {
      for (const p of arriba[i + 1]!.partes) {
        const c = /^(?:n[°ºo]\.?\s*:?\s*)?0(\d{1,2})$/i.exec(p);
        if (c && LETRA_POR_CODIGO[String(Number(c[1]))]) return LETRA_POR_CODIGO[String(Number(c[1]))]!;
      }
    }
  }
  return null;
}

function leerCae(lineas: Linea[]): string | null {
  for (const l of lineas) {
    const m = /c\.?\s?a\.?\s?e\.?\s*(?:n(?:ro|[°ºo])?\.?)?\s*:?\s*(\d{14})(?!\d)/i.exec(l.texto);
    if (m) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Razón social
// ---------------------------------------------------------------------------

/** Palabras del comprobante que aparecen destacadas arriba y no son el nombre. */
const PALABRAS_DE_COMPROBANTE = new Set([
  'FACTURA', 'REMITO', 'ORIGINAL', 'DUPLICADO', 'TRIPLICADO', 'CODIGO', 'CÓDIGO', 'COD', 'PRESUPUESTO', 'NOTA',
  'CREDITO', 'CRÉDITO', 'DEBITO', 'DÉBITO', 'RECIBO', 'TICKET', 'COMPROBANTE', 'A', 'B', 'C', 'X', 'DE', 'IVA',
  'RESPONSABLE', 'INSCRIPTO', 'FECHA', 'HOJA', 'PAGINA', 'PÁGINA', 'CUIT', 'NO', 'VALIDO', 'VÁLIDO', 'COMO',
  'DOCUMENTO', 'FISCAL', 'PEDIDO', 'ELECTRONICA', 'ELECTRÓNICA', 'N',
]);
const RE_SOCIEDAD = /\b(S\.?\s?R\.?\s?L|S\.?\s?A(\.?\s?S|\.?\s?C\.?\s?I\.?\s?F\.?\s?I?\.?\s?A?)?|S\.?\s?H|S\.?\s?C\.?\s?S|S\.?\s?C|S\.?\s?A\.?\s?U|LTDA|HNOS|E\s+HIJOS)\.?$/i;

const esDelComprobante = (p: string): boolean =>
  p.split(/[-/.]/).filter(Boolean).every((x) => PALABRAS_DE_COMPROBANTE.has(x));
/** Una línea que sólo trae palabras del comprobante ("B", "ORIGINAL", "FACTURA A"): no dice nada del nombre. */
const soloDelComprobante = (l: Linea): boolean => l.partes.every((p) => p.split(/\s+/).filter(Boolean).every(esDelComprobante));

/** Una columna que puede ser un nombre destacado: sólo mayúsculas, sin números ni rótulos. */
function nombreDestacado(parte: string): string | null {
  if (/[\d:@$%*#=|]/.test(parte)) return null;
  // El encabezado de la tabla de renglones también viene en mayúsculas.
  if (/\b(DESCRIPCI[OÓ]N|CANT(IDAD)?|IMPORTE|PRECIO|TOTAL|UNITARIO|DETALLE|ART[IÍ]CULO)\b/.test(parte)) return null;
  if (parte !== parte.toUpperCase()) return null;
  // Las palabras del comprobante se sacan de las puntas ("BERNARDI FACTURA").
  const palabras = parte.split(/\s+/).filter(Boolean);
  while (palabras.length > 0 && esDelComprobante(palabras[0]!)) palabras.shift();
  while (palabras.length > 0 && esDelComprobante(palabras[palabras.length - 1]!)) palabras.pop();
  const nombre = palabras.join(' ').replace(/^[^A-ZÁÉÍÓÚÑ]+|[^A-ZÁÉÍÓÚÑ.]+$/g, '');
  return (nombre.match(/[A-ZÁÉÍÓÚÑ]/g) ?? []).length >= 3 ? nombre : null;
}

function leerNombres(lineas: Linea[], cliente: number): string[] {
  const arriba = lineas.filter((l) => l.n < Math.min(cliente, 12) && l.hoja === 1);
  const nombres: string[] = [];
  const agregar = (n: string | null | undefined): void => {
    const limpio = n?.replace(/\s+/g, ' ').trim();
    if (limpio && limpio.length >= 3 && !nombres.some((x) => x.toUpperCase() === limpio.toUpperCase())) nombres.push(limpio);
  };

  // 1. Línea destacada arriba. Se prefiere la primera de varias palabras (o con
  //    S.A./S.R.L.); una palabra sola puede ser un logo mal leído.
  let unaPalabra: string | null = null;
  let destacado: string | null = null;
  for (let i = 0; i < arriba.length && destacado === null; i++) {
    for (const parte of arriba[i]!.partes) {
      let nombre = nombreDestacado(parte);
      if (!nombre) continue;
      // El nombre partido en dos líneas: "BERNARDI" / "DISTRIBUCIONES S.R.L".
      // En el medio puede venir la letra sola o "ORIGINAL" (hasta 2 líneas).
      if (!RE_SOCIEDAD.test(nombre)) {
        for (let j = i + 1; j < arriba.length && j <= i + 2; j++) {
          const abajo = nombreDestacado(arriba[j]!.partes[0] ?? '');
          if (abajo) {
            if (RE_SOCIEDAD.test(abajo)) nombre = `${nombre} ${abajo}`;
            break;
          }
          if (!soloDelComprobante(arriba[j]!)) break;
        }
      }
      if (/\s/.test(nombre) || RE_SOCIEDAD.test(nombre)) {
        destacado = nombre;
        break;
      }
      unaPalabra ??= nombre;
    }
  }
  agregar(destacado ?? unaPalabra);

  // 2. "Razón Social: X" del emisor (antes del bloque del cliente).
  for (const l of lineas) {
    if (l.n >= cliente) break;
    const m = /^raz[oó]n\s+social\s*:\s*(.+)$/i.exec(l.partes[0] ?? '');
    if (m && !/consumidor\s+final/i.test(m[1]!)) agregar(m[1]);
  }
  // 3. "de X S.A." (el nombre de fantasía es "de" la sociedad).
  for (const l of arriba) {
    for (const parte of l.partes) {
      const m = /^de\s+(.{3,60}?\b(?:S\.?\s?R\.?\s?L|S\.?\s?A\.?\s?S|S\.?\s?A|S\.?\s?H|S\.?\s?C\.?\s?S)\.?)$/i.exec(parte);
      if (m) agregar(m[1]);
    }
  }
  return nombres;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Encabezado de una factura a partir del texto de sus hojas (en orden).
 * Nunca tira: lo que no se pudo leer queda en `null`.
 */
export function leerEncabezado(textos: string[], opciones: OpcionesEncabezado = {}): EncabezadoLeido {
  const vacio: EncabezadoLeido = {
    cuit: null, razonSocial: null, numero: null, fecha: null, letra: null, total: null, cae: null, otrosNombres: [],
  };
  try {
    const validos = (Array.isArray(textos) ? textos : []).map((t) => (typeof t === 'string' ? t : ''));
    const lineas = aLineas(validos);
    if (lineas.length === 0) return vacio;
    const cliente = inicioDeCliente(lineas);
    const descartados = new Set<string>();
    for (const c of [opciones.cuitPropio, ...(opciones.cuitsDescartados ?? [])]) {
      if (typeof c === 'string' && soloDigitos(c)) descartados.add(soloDigitos(c));
    }

    // El total está en la última hoja que lo trae.
    const formato = detectarFormato(validos.join('\n'));
    let total: number | null = null;
    for (let h = validos.length - 1; h >= 0 && total === null; h--) total = totalesDelTexto(validos[h]!, formato).total;

    const nombres = leerNombres(lineas, cliente);
    return {
      cuit: leerCuit(lineas, cliente, descartados, nombres.length > 0),
      razonSocial: nombres[0] ?? null,
      numero: leerNumero(lineas),
      fecha: leerFecha(lineas),
      letra: leerLetra(lineas, cliente),
      total,
      cae: leerCae(lineas),
      otrosNombres: nombres.slice(1),
    };
  } catch {
    return vacio;
  }
}
