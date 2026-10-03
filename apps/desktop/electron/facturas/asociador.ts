/**
 * Facturas por teléfono — asociación automática renglón de factura → artículo del sistema.
 *
 * TypeScript puro (sin Electron ni base): recibe el catálogo ya leído y propone, para cada
 * renglón, el artículo que le corresponde. Port endurecido de tools/ocr-facturas/asociar.py.
 *
 * Prioridad absoluta: CERO vínculos equivocados. Sólo se pre-vincula cuando
 *   · todas las palabras de marca/variedad del renglón están en el artículo,
 *   · al artículo no le sobra ninguna palabra (LAGER vs GOLDEN, ZERO, 0.0 / SIN ALCOHOL, SIN GAS / CON GAS, sabores…),
 *   · los dos lados tienen tamaño y es el mismo,
 *   · no se contradicen el envase (LATA/VIDRIO…), el retorno (RET/DESC) ni el rubro,
 *   · y hay un único artículo así (o uno con ventaja clara sobre el resto).
 * El rubro ("AGUA", "CERVEZA", "VINO"…) se compara pero no es palabra de variedad: vale adelante
 * ("AGUA VILLAVICENCIO") y también en el medio del nombre ("VILLAVICENCIO AGUA 1.5L").
 * Ante la duda queda en blanco y se devuelven hasta 3 candidatos para que el usuario elija.
 * Proveedor y costo son pistas secundarias: desempatan y ordenan, nunca habilitan solas.
 */

export interface ArticuloParaAsociar {
  id: string;
  descripcion: string;
  marca?: string | null;
  proveedorId?: string | null;
  costo?: number | null;
  activo?: boolean;
}

export interface PropuestaAsociacion {
  /** Artículo propuesto con confianza suficiente para pre-vincular (se muestra como "Sugerido"); null = no hay un candidato claro. */
  articuloId: string | null;
  /** Hasta 3 candidatos ordenados, para mostrar como sugerencias. */
  candidatos: Array<{ articuloId: string; puntaje: number }>;
  /** Por qué se propuso o por qué no (corto). */
  motivo: string | null;
}

export interface TamanoUnidad {
  valor: number;
  unidad: 'ml' | 'g' | 'u';
}

/** Tamaño con la marca interna de si la unidad estaba escrita ("500CC") o se dedujo ("12X500"). */
interface Tamano extends TamanoUnidad {
  explicita: boolean;
}

interface TextoAnalizado {
  tamano: Tamano | null;
  /** Palabras de marca/variedad (las que tienen que coincidir). */
  significativas: string[];
  /** Rubro: sólo si encabeza la descripción ("Fideos …", "CERVEZA …"). */
  rubro: string | null;
  envases: string[];
  retorno: string[];
}

interface ArticuloIndexado extends TextoAnalizado {
  id: string;
  /** Palabras de la marca cargada aparte: cubren palabras del renglón pero no cuentan como sobrantes. */
  opcionales: Set<string>;
  conjunto: Set<string>;
  proveedorId: string | null;
  costo: number | null;
}

/** Índice reutilizable: se arma una vez por factura (o por sesión) y sirve para todos los renglones. */
export interface CatalogoPreparado {
  readonly articulos: ArticuloIndexado[];
  /** Índice invertido palabra → posiciones en `articulos`. */
  readonly porPalabra: Map<string, number[]>;
  /** Abreviaturas ya resueltas contra el vocabulario de este catálogo. */
  readonly abreviaturas: Map<string, string | null>;
}

// ───────────────────────── normalización ─────────────────────────

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

/** Plural simple: FIDEOS→FIDEO, VERDURAS→VERDURA. Se aplica igual a los dos lados. */
function raiz(palabra: string): string {
  return palabra.length >= 5 && palabra.endsWith('S') && !palabra.endsWith('SS') ? palabra.slice(0, -1) : palabra;
}

const conjunto = (palabras: string): Set<string> => new Set(palabras.split(/\s+/).filter(Boolean).map(raiz));

/** Sinónimos de frase: se aplican sobre el texto normalizado, antes de separar en palabras. */
const SINONIMOS: Array<[RegExp, string]> = [
  [/\bSIN\s+TACC\b/g, ' '],
  [/\bABRE\s+FACIL\b/g, ' '],
  [/\bCOCA\s*-\s*COLA\b/g, 'COCA COLA'],
  [/\bS\/\s*AZUC(?:AR(?:ES)?)?\b\.?/g, ' ZERO '],
  [/\bSIN\s+AZUCAR(?:ES)?\b/g, ' ZERO '],
  [/\bNO\s+RETOR(?:NABLE)?\b\.?/g, ' DESC '],
  [/\bN\/R\b/g, ' DESC '],
  [/\bRETOR(?:NABLE)?\b\.?/g, ' RET '],
  [/\bDESCARTABLE\b/g, ' DESC '],
  [/\bF\.\s?TROP(?:ICAL(?:ES)?)?\b\.?/g, ' FTROP '],
  [/\bFRUTAS?\s+TROPICAL(?:ES)?\b/g, ' FTROP '],
  [/\bT[./]\s?BRIK\b/g, ' TETRA '],
  [/\bTETRA\s?(?:BRIK|PACK|PAK)\b/g, ' TETRA '],
  [/\bBRIK\b/g, ' TETRA '],
  [/\bD\/P\b/g, ' DOYPACK '],
  [/\bDOY\s?PACK\b/g, ' DOYPACK '],
  [/\bROLL[- ]ON\b/g, ' ROLLON '],
  // Rasgos de variedad que se escriben de varias formas: quedan en UNA palabra significativa, así pesan
  // como LAGER o ZERO (si está en un lado y no en el otro, no es el mismo producto).
  // SGAS/CGAS y no SINGAS/CONGAS: `raiz` les sacaría la S final.
  [/\b0[.,]0(?!\d)\s*%?/g, ' SINALCOHOL '], // cerveza sin alcohol: "0.0", "0,0", "0.0%"
  [/\b(?:SIN|S\/?)\s*ALC(?:OHOL)?\b\.?/g, ' SINALCOHOL '],
  [/\b(?:SIN|S\/?)\s*GAS\b/g, ' SGAS '], // "SIN GAS", "S/GAS", "S GAS"
  [/\b(?:CON|C\/?)\s*GAS\b/g, ' CGAS '], // "CON GAS", "C/GAS", "C GAS"
  [/\bGAS(?:IFICADA)?\b/g, ' CGAS '], // "VILLAVICENCIO GAS 500" es con gas
  [/\bS\/\s*/g, ' SIN '],
  [/\bC\/\s*/g, ' CON '],
];

/** Abreviaturas seguras (valen siempre, en los dos lados). */
const ABREVIATURAS: Record<string, string> = {
  DET: 'DETERGENTE',
  DETERG: 'DETERGENTE',
  LAVAND: 'LAVANDINA',
  MAYO: 'MAYONESA',
  GALLET: 'GALLETITAS',
  GALLETAS: 'GALLETITAS',
  GALLETITA: 'GALLETITAS',
  LIQ: 'LIQUIDO',
  ACOND: 'ACONDICIONADOR',
  ANTITR: 'ANTITRANSPIRANTE',
  DESOD: 'DESODORANTE',
  JGO: 'JUGO',
  DZNO: 'DURAZNO',
  DURAZ: 'DURAZNO',
  NJA: 'NARANJA',
  MZNA: 'MANZANA',
  BCO: 'BLANCO',
  TTO: 'TINTO',
  SPAGUETTI: 'SPAGHETTI',
  ESPAGUETI: 'SPAGHETTI',
  SPAGHETTIS: 'SPAGHETTI',
  DIET: 'LIGHT',
  ORIG: 'ORIGINAL',
};

/**
 * Abreviaturas que sólo valen si desambiguan en ESTE catálogo: la forma corta no es una palabra
 * del catálogo y la larga es la única que empieza así (IMP → IMPERIAL, salvo que exista IMPORTADA).
 */
const ABREVIATURAS_SI_DESAMBIGUA: Record<string, string> = {
  IMP: 'IMPERIAL',
  IMPER: 'IMPERIAL',
  QUIL: 'QUILMES',
  HEIN: 'HEINEKEN',
  SCHW: 'SCHWEPPES',
  POWER: 'POWERADE',
  AQUA: 'AQUARIUS',
};

const RUIDO = conjunto(
  'X DE DEL LA EL LOS LAS EN AL A Y E O CON PARA POR UN UNA LTS LT L LI CC ML G GR GRS KG KGS U UNI UNID UNIDAD ' +
    'COMUN ORIGINAL CLASICO CLASICA TRADICIONAL REGULAR NUEVO NUEVA OFERTA PROMO TACC DESHIDRATADO PACK ENVASE',
);

/** Envase: no cuenta como palabra de variedad, pero no puede contradecirse (LATA vs VIDRIO). */
const ENVASES = conjunto('LATA VIDRIO PET BOTELLA TETRA SACHET DOYPACK FRASCO POTE BOLSA SOBRE AEROSOL ROLLON BARRIL SIFON');
const RETORNO = conjunto('RET DESC');
const BOTELLA_ES = new Set(['VIDRIO', 'PET']);

/** Rubros: sólo cuentan cuando encabezan la descripción; si los dos lados lo dicen y difiere, no es el mismo producto. */
const RUBROS = conjunto(
  'CERVEZA GASEOSA AGUA SODA VINO GIN RON VODKA WHISKY FERNET APERITIVO JUGO ENERGIZANTE ' +
    'FIDEOS GALLETITAS YERBA CALDO SOPA MAYONESA KETCHUP MOSTAZA ARROZ ATUN CABALLA SARDINA ACEITE VINAGRE SAL AZUCAR HARINA ' +
    'TE CAFE LECHE YOGUR PURE SALSA MERMELADA DULCE ALFAJOR CHOCOLATE CARAMELO CHICLE LEVADURA PREMEZCLA MANI TOSTADAS ' +
    'PIMENTON PROVENZAL CHIMICHURRI CONDIMENTO MAGDALENA RAPIDITAS CAPELETTINI CHOCLO ARVEJAS LENTEJAS JARDINERA PALMITO ' +
    'DETERGENTE LAVANDINA JABON SHAMPOO ACONDICIONADOR LIMPIADOR SUAVIZANTE DESODORANTE ANTITRANSPIRANTE PAPEL SERVILLETA ' +
    'ESPONJA TRAPO REJILLA REPELENTE ESPIRALES LAMPARA CEPILLO CREMA TOALLA',
);

/**
 * Rubros que en el medio del nombre siguen nombrando la categoría ("VILLAVICENCIO AGUA 1.5L", "TORO VINO TINTO",
 * "GALLO ARROZ 1KG"): se toman como rubro y no cuentan como palabra sobrante. Afuera quedan los que también son
 * sabor o ingrediente (CAFE, LECHE, CREMA, DULCE, CHOCOLATE, SAL, ACEITE, MAYONESA, PIMENTON…):
 * "SPEED CAFE" no es un Speed cualquiera y "ATUN LA CAMPAGNOLA ACEITE" no es el que está al agua.
 */
const RUBROS_SOLO_CATEGORIA = conjunto(
  'CERVEZA GASEOSA AGUA SODA VINO JUGO ENERGIZANTE APERITIVO FIDEOS GALLETITAS YERBA ARROZ HARINA CALDO SOPA ' +
    'LEVADURA PREMEZCLA MAGDALENA RAPIDITAS CAPELETTINI TOSTADAS ALFAJOR CHICLE ' +
    'DETERGENTE LAVANDINA JABON SHAMPOO ACONDICIONADOR LIMPIADOR SUAVIZANTE DESODORANTE ANTITRANSPIRANTE PAPEL SERVILLETA ' +
    'ESPONJA TRAPO REJILLA REPELENTE ESPIRALES LAMPARA CEPILLO TOALLA',
);
/** Si una de esas palabras viene después de esto, es ingrediente y no categoría ("ATUN AL AGUA", "GALLETAS DE ARROZ"). */
const PRECEDE_INGREDIENTE = new Set(['A', 'AL', 'EN', 'DE', 'DEL', 'CON', 'SIN', 'SABOR']);

// ───────────────────────── tamaño de la unidad ─────────────────────────

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const U_LITRO = 'LITROS?|LTS?|LI|L';
const U_ML = 'CC|ML|CM3';
const U_KILO = 'KGS?|KILOS?';
const U_GRAMO = 'GRAMOS|GRS?|G';
const U_UNIDAD = 'UNIDADES|UNID|UNI|UN|U|SQ|SAQUITOS?|SAQ';

const RE_FRACCION = new RegExp(String.raw`(?<![\d/.,])(?:([123])\s?)?1/([245])(?![\d/])(?:\s*(${U_KILO}|${U_LITRO})\b)?`);
const RE_EXPLICITO = new RegExp(String.raw`(?<![\d.,/])(?:(\d{2,4})/)?(${NUM})\s*(${U_LITRO}|${U_ML}|${U_KILO}|${U_GRAMO})\b`);
const RE_BULTO = new RegExp(String.raw`(?<![\d.,/])\d{1,2}\s*X+\s*(${NUM})(?![\d/.,]|\s*(?:CM|MM|MTS?|W|${U_UNIDAD})\b)`, 'g');
const RE_X_NUMERO = /X\s*(\d{3,4})(?![\d/.,]|\s*(?:CM|MM|MTS?|W)\b)/;
const RE_TAMANO_X_BULTO = /(?<![\d.,/])(\d{3,4})\s*X+\s*(\d{1,2})(?![\d/.,]|\s*(?:CM|MM|MTS?|W)\b)/;
const RE_UNIDADES = new RegExp(String.raw`(?<![\d.,/])(\d{1,3})\s*(?:${U_UNIDAD})\b`);
const RE_X_UNIDADES = /X\s*(\d{1,2})(?![\d/.,]|\s*X)/;
const RE_NUMERO_SUELTO = /(?<![\w.,/])(\d{3,4})(?![\w.,/%])/;

const aNumero = (s: string): number => Number(s.replace(',', '.'));
const redondear = (n: number): number => Math.round(n * 1000) / 1000;

function leerTamano(textoNormalizado: string): Tamano | null {
  const t = textoNormalizado;

  // 1) Fracciones de litro: "6X 1/2", "8X1 1/4", "6X21/4" y "6X11/5" (el 5 es un 2 mal leído).
  const f = RE_FRACCION.exec(t);
  if (f) {
    const entero = f[1] ? Number(f[1]) : 0;
    const den = f[2] === '4' ? 4 : 2;
    if (f[2] !== '5' || entero > 0) {
      const esKilo = !!f[3] && /^K/.test(f[3]);
      return { valor: entero * 1000 + 1000 / den, unidad: esKilo ? 'g' : 'ml', explicita: !!f[3] };
    }
  }

  // 2) Número con unidad escrita: "1.5L", "473CC", "x170gr", "x1kg", "8X2 LTS", "x250/262grs".
  const e = RE_EXPLICITO.exec(t);
  if (e) {
    const valor = aNumero(e[1] ?? e[2]!);
    const u = e[3]!;
    if (/^(?:LITRO|LT|LI|L)/.test(u)) return { valor: redondear(valor * 1000), unidad: 'ml', explicita: true };
    if (/^(?:CC|ML|CM3)/.test(u)) return { valor, unidad: 'ml', explicita: true };
    if (/^K/.test(u)) return { valor: redondear(valor * 1000), unidad: 'g', explicita: true };
    return { valor, unidad: 'g', explicita: true };
  }

  // 3) Bulto × tamaño sin unidad: "12X500", "6X1500", "12X1", "6X1,75". Un "45x60" o "24X24" no es tamaño.
  RE_BULTO.lastIndex = 0;
  for (let b = RE_BULTO.exec(t); b; b = RE_BULTO.exec(t)) {
    const crudo = b[1]!;
    const valor = aNumero(crudo);
    if (/[.,]/.test(crudo) || valor <= 5) return { valor: redondear(valor * 1000), unidad: 'ml', explicita: false };
    if (valor >= 100) return { valor, unidad: 'ml', explicita: false };
  }

  // 4) "X 500 X 12", "X 473 X 6", "X 250".
  const x = RE_X_NUMERO.exec(t);
  if (x) return { valor: Number(x[1]), unidad: 'ml', explicita: false };

  // 4b) Tamaño × bulto sin unidad ni X adelante: "330 X 24", "710 X 12", "118 X 36". Con un número con pinta
  //     de tamaño y un bulto chico (≤ 48) el tamaño es el grande, no "24 unidades" como leería el paso 6.
  const tb = RE_TAMANO_X_BULTO.exec(t);
  if (tb) {
    const valor = Number(tb[1]);
    if (valor >= 100 && valor <= 5000 && Number(tb[2]) <= 48) return { valor, unidad: 'ml', explicita: false };
  }

  // 5) Unidades: "x12u", "x6u", "x25sq".
  const u = RE_UNIDADES.exec(t);
  if (u) return { valor: Number(u[1]), unidad: 'u', explicita: true };

  // 6) "X12" a secas (caldos, espirales): unidades, sin certeza.
  const xu = RE_X_UNIDADES.exec(t);
  if (xu && Number(xu[1]) >= 6) return { valor: Number(xu[1]), unidad: 'u', explicita: false };

  // 7) Número suelto con pinta de tamaño: "FERNET BRANCA 750".
  const n = RE_NUMERO_SUELTO.exec(t);
  if (n) {
    const valor = Number(n[1]);
    if (valor >= 100 && valor <= 5000) return { valor, unidad: 'ml', explicita: false };
  }
  return null;
}

/**
 * Tamaño de UNA unidad (no del bulto), en ml, g o unidades.
 * Entiende "12X500", "6X11/5", "6X1 1/2", "8X2 LTS", "1.5L", "473CC", "X 1L X 12", "x170gr", "x1kg", "x12u"…
 * Cuando la unidad no está escrita ("12X500") se informa 'ml'.
 */
export function tamanoDeUnidad(texto: string): TamanoUnidad | null {
  const t = leerTamano(normalizar(texto));
  return t ? { valor: t.valor, unidad: t.unidad } : null;
}

/**
 * ¿Las dos descripciones indican tamaños DISTINTOS ("x170gr" contra "x380gr")?
 * false si alguna no trae tamaño o no se pueden comparar. Lo usa el servicio
 * para no confiar en un código aprendido cuyo renglón cambió de tamaño.
 */
export function tamanosDistintos(a: string, b: string): boolean {
  return compararTamano(leerTamano(normalizar(a)), leerTamano(normalizar(b))) === 'distinto';
}

type RelacionTamano = 'igual' | 'distinto' | 'dudoso' | 'falta';

function compararTamano(a: Tamano | null, b: Tamano | null): RelacionTamano {
  if (!a || !b) return 'falta';
  const mismoValor = Math.abs(a.valor - b.valor) < 0.0001;
  if (a.explicita && b.explicita && a.unidad !== b.unidad) {
    // "X 12U x 7.5 G" contra "X12U": son medidas distintas de lo mismo, no se puede decidir.
    if (a.unidad === 'u' || b.unidad === 'u') return 'dudoso';
    // 250 ml contra 250 g: el comerciante pudo anotar cualquiera de las dos; no alcanza para vincular.
    return mismoValor ? 'dudoso' : 'distinto';
  }
  return mismoValor ? 'igual' : 'distinto';
}

// ───────────────────────── palabras ─────────────────────────

const RE_QUITAR_UNIDAD = new RegExp(
  String.raw`${NUM}\s*(?:${U_LITRO}|${U_ML}|${U_KILO}|${U_GRAMO}|${U_UNIDAD})\b`,
  'g',
);

function analizar(texto: string): TextoAnalizado {
  const base = normalizar(texto);
  const tamano = leerTamano(base);

  let t = base;
  for (const [re, por] of SINONIMOS) t = t.replace(re, por);
  t = t
    .replace(/([A-Z])X+(?=\d)/g, '$1 ') // "BEBEX4LT", "BX2 LTS": la X pegada es el "por"
    .replace(/(?<![A-Z])X+(?=\s*\d)/g, ' ')
    .replace(/(?<=\d)\s*X+(?![A-Z])/g, ' ')
    .replace(/(?<![\d/.,])(?:[123]\s?)?1\/[245](?![\d/])/g, ' ')
    .replace(RE_QUITAR_UNIDAD, ' ')
    .replace(/&/g, 'Y')
    .replace(/[^A-Z0-9]+/g, ' ');

  const significativas: string[] = [];
  const envases: string[] = [];
  const retorno: string[] = [];
  let rubro: string | null = null;
  const partes = t.split(' ').filter(Boolean);
  for (let i = 0; i < partes.length; i++) {
    const crudo = partes[i]!;
    if (crudo.length < 2 || !/[A-Z]/.test(crudo)) continue;
    // Restos de medidas pegadas a letras ("12W", "3XL", "20SQ"): no son marca ni variedad.
    if (/^\d/.test(crudo) && crudo.replace(/\d/g, '').length <= 2 && crudo !== '7UP') continue;
    const palabra = raiz(ABREVIATURAS[crudo] ?? crudo);
    if (RUIDO.has(palabra)) continue;
    // Rubro: adelante de todo ("CERVEZA QUILMES"), o en el medio si sólo puede ser la categoría
    // ("QUILMES CERVEZA 1L", pero no "ATUN AL AGUA" ni "SPEED CAFE").
    const esRubro =
      rubro === null &&
      RUBROS.has(palabra) &&
      (significativas.length === 0 ||
        (RUBROS_SOLO_CATEGORIA.has(palabra) && !PRECEDE_INGREDIENTE.has(partes[i - 1] ?? '')));
    if (ENVASES.has(palabra)) {
      if (!envases.includes(palabra)) envases.push(palabra);
    } else if (RETORNO.has(palabra)) {
      if (!retorno.includes(palabra)) retorno.push(palabra);
    } else if (esRubro) {
      rubro = palabra;
    } else if (!significativas.includes(palabra)) {
      significativas.push(palabra);
    }
  }
  return { tamano, significativas, rubro, envases, retorno };
}

// ───────────────────────── catálogo ─────────────────────────

export function prepararCatalogo(articulos: ArticuloParaAsociar[]): CatalogoPreparado {
  const indexados: ArticuloIndexado[] = [];
  const porPalabra = new Map<string, number[]>();
  for (const a of articulos) {
    if (a.activo === false) continue; // los dados de baja no se proponen
    const an = analizar(a.descripcion);
    const propias = new Set(an.significativas);
    const opcionales = new Set<string>();
    if (a.marca) for (const p of analizar(a.marca).significativas) if (!propias.has(p)) opcionales.add(p);
    if (propias.size === 0 && opcionales.size === 0) continue;
    const pos = indexados.length;
    indexados.push({
      ...an,
      id: a.id,
      opcionales,
      conjunto: propias,
      proveedorId: a.proveedorId ?? null,
      costo: typeof a.costo === 'number' && a.costo > 0 ? a.costo : null,
    });
    for (const p of [...propias, ...opcionales]) {
      const lista = porPalabra.get(p);
      if (lista) lista.push(pos);
      else porPalabra.set(p, [pos]);
    }
  }
  return { articulos: indexados, porPalabra, abreviaturas: new Map() };
}

/** IMP → IMPERIAL sólo si en este catálogo no hay otra palabra que empiece igual. */
function resolverAbreviatura(palabra: string, catalogo: CatalogoPreparado): string | null {
  if (catalogo.porPalabra.has(palabra)) return null;
  const larga = ABREVIATURAS_SI_DESAMBIGUA[palabra];
  if (!larga) return null;
  const ya = catalogo.abreviaturas.get(palabra);
  if (ya !== undefined) return ya;
  const destino = raiz(larga);
  let resultado: string | null = catalogo.porPalabra.has(destino) ? destino : null;
  if (resultado) {
    for (const p of catalogo.porPalabra.keys()) {
      if (p !== destino && p.startsWith(palabra)) {
        resultado = null;
        break;
      }
    }
  }
  catalogo.abreviaturas.set(palabra, resultado);
  return resultado;
}

// ───────────────────────── propuesta ─────────────────────────

function seContradicen(a: string[], b: string[], compatibles?: (x: string, y: string) => boolean): boolean {
  if (a.length === 0 || b.length === 0) return false;
  for (const x of a) for (const y of b) if (x === y || compatibles?.(x, y)) return false;
  return true;
}

const envasesCompatibles = (x: string, y: string): boolean =>
  (x === 'BOTELLA' && BOTELLA_ES.has(y)) || (y === 'BOTELLA' && BOTELLA_ES.has(x));

const coinciden = (a: string[], b: string[]): boolean => a.some((x) => b.includes(x));

interface Evaluado {
  art: ArticuloIndexado;
  puntaje: number;
  exacto: boolean;
  cubreRenglon: boolean;
  sobran: boolean;
  aproximado: boolean;
  tamano: RelacionTamano;
  contradice: boolean;
}

const MARGEN = 0.05;
const PUNTAJE_MINIMO = 0.4;

export function proponerArticulo(
  renglon: { descripcion: string; precioUnitario?: number | null; unidadesPorBulto?: number | null },
  catalogo: CatalogoPreparado,
  opciones?: { proveedorId?: string | null },
): PropuestaAsociacion {
  const precio = renglon.precioUnitario ?? null;
  if (precio !== null && precio < 0) return { articuloId: null, candidatos: [], motivo: 'Renglón de descuento' };

  const r = analizar(renglon.descripcion);
  const palabras = r.significativas.map((p) => resolverAbreviatura(p, catalogo) ?? p);
  if (palabras.length === 0) return { articuloId: null, candidatos: [], motivo: 'Sin marca ni variedad legibles' };

  const posibles = new Set<number>();
  for (const p of palabras) for (const pos of catalogo.porPalabra.get(p) ?? []) posibles.add(pos);

  const uxb = renglon.unidadesPorBulto ?? null;
  const precios: number[] = [];
  if (precio !== null && precio > 0) {
    precios.push(precio);
    if (uxb !== null && uxb > 1) precios.push(precio / uxb);
  }
  const proveedorId = opciones?.proveedorId ?? null;

  const evaluados: Evaluado[] = [];
  for (const pos of posibles) {
    const art = catalogo.articulos[pos]!;
    const tamano = compararTamano(r.tamano, art.tamano);
    if (tamano === 'distinto') continue; // otro tamaño: no es el mismo producto
    if (r.rubro && art.rubro && r.rubro !== art.rubro) continue; // mayonesa ≠ ketchup de la misma marca

    // Palabras del renglón cubiertas y palabras del artículo que sobran. El rubro de un lado cubre la misma
    // palabra escrita en el medio del otro ("Mayonesa NATURA x250" ↔ "NATURA MAYONESA 250G").
    const faltan = palabras.filter((p) => !art.conjunto.has(p) && !art.opcionales.has(p) && p !== art.rubro);
    let sobrantes = art.significativas.filter((p) => !palabras.includes(p) && p !== r.rubro);
    const cubiertasArt = art.significativas.length - sobrantes.length;
    // Abreviaturas no tabuladas (DESM ↔ DESMENUZADO): suman para sugerir, no para vincular.
    let aproximadas = 0;
    for (const p of faltan) {
      const i = sobrantes.findIndex(
        (s) => Math.min(s.length, p.length) >= 3 && (s.startsWith(p) || p.startsWith(s)),
      );
      if (i >= 0) {
        sobrantes = sobrantes.filter((_, j) => j !== i);
        aproximadas++;
      }
    }
    const cubreRenglon = (palabras.length - faltan.length + aproximadas) / palabras.length;
    const cubreArticulo =
      art.significativas.length === 0 ? 1 : (cubiertasArt + aproximadas) / art.significativas.length;

    const contradice =
      seContradicen(r.envases, art.envases, envasesCompatibles) || seContradicen(r.retorno, art.retorno);

    let puntaje = 0.6 * cubreRenglon + 0.4 * cubreArticulo;
    if (tamano === 'igual') puntaje += 0.05;
    if (r.rubro && r.rubro === art.rubro) puntaje += 0.02;
    if (contradice) puntaje -= 0.3;
    else {
      if (coinciden(r.envases, art.envases)) puntaje += 0.05;
      if (coinciden(r.retorno, art.retorno)) puntaje += 0.05;
    }
    // Pistas secundarias: mismo proveedor y costo parecido al precio leído (±15 %).
    if (proveedorId && art.proveedorId === proveedorId) puntaje += 0.05;
    if (art.costo !== null && precios.some((p) => Math.abs(art.costo! - p) / p <= 0.15)) puntaje += 0.05;

    if (puntaje < PUNTAJE_MINIMO) continue;
    const completo = faltan.length === 0 && sobrantes.length === 0 && aproximadas === 0;
    evaluados.push({
      art,
      puntaje,
      exacto: completo && tamano === 'igual' && !contradice,
      cubreRenglon: faltan.length === 0 || faltan.length === aproximadas,
      sobran: sobrantes.length > 0,
      aproximado: aproximadas > 0,
      tamano,
      contradice,
    });
  }

  if (evaluados.length === 0) return { articuloId: null, candidatos: [], motivo: 'Sin artículos parecidos' };

  evaluados.sort(
    (a, b) => Number(b.exacto) - Number(a.exacto) || b.puntaje - a.puntaje || a.art.id.localeCompare(b.art.id),
  );
  const candidatos = evaluados.slice(0, 3).map((e) => ({ articuloId: e.art.id, puntaje: redondear(e.puntaje) }));
  const mejor = evaluados[0]!;
  const segundo = evaluados[1];

  if (mejor.exacto) {
    if (!segundo?.exacto || mejor.puntaje - segundo.puntaje >= MARGEN - 1e-9) {
      return { articuloId: mejor.art.id, candidatos, motivo: 'Coinciden marca, variedad y tamaño' };
    }
    return { articuloId: null, candidatos, motivo: 'Hay más de un artículo que coincide' };
  }

  let motivo: string;
  if (!mejor.cubreRenglon) motivo = 'Ningún artículo tiene todas las palabras del renglón';
  else if (mejor.sobran) motivo = 'El artículo parecido es de otra variedad';
  else if (mejor.aproximado) motivo = 'Coincide sólo por abreviatura';
  else if (mejor.contradice) motivo = 'El envase no coincide';
  else if (!r.tamano) motivo = 'El renglón no indica tamaño';
  else if (!mejor.art.tamano) motivo = 'El artículo no indica tamaño';
  else motivo = 'El tamaño no se puede comparar';
  return { articuloId: null, candidatos, motivo };
}
