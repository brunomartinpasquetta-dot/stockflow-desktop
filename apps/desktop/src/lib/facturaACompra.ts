/**
 * Factura escaneada → formulario de Compras (ver docs/PLAN_FACTURAS_TELEFONO.md).
 *
 * Acá está TODA la cuenta de plata del pasaje, sin React y sin imports, para
 * poder probarla sola (electron/__tests__/facturas-compra.smoke.ts).
 *
 * Qué espera Compras (Compras.tsx + purchases.service de @stockflow/core):
 *  - `costPrice` va en la base del modo de precios de la EMPRESA
 *    (`company.priceMode`): 'gross' = costo con IVA incluido; 'net' = costo
 *    neto y el IVA se suma aparte con la alícuota del renglón.
 *  - `discount` (descuento global) se resta del subtotal en ESA MISMA base y
 *    se prorratea entre los renglones antes de calcular el IVA.
 *
 * Qué trae la factura:
 *  - Factura A: precios e importes NETOS (el IVA va discriminado al pie).
 *  - Factura B, C y comprobante X: precios FINALES.
 *
 * Entonces: si la base de la factura y la de la empresa coinciden, el precio
 * pasa tal cual; si no, se convierte con la alícuota de IVA que trae el renglón
 * de la factura cuando se leyó y, si no, con la del artículo. Los
 * renglones de descuento no tienen artículo: se convierten con la alícuota que
 * trae el propio renglón de descuento; si alguno no la trae y las bases no
 * coinciden, el descuento NO se precarga (y la factura no pasa por el atajo).
 */

export type TipoComprobante = 'A' | 'B' | 'C' | 'X'
export type ModoPrecios = 'gross' | 'net'
export type BasePrecios = 'neto' | 'final'

export interface RenglonParaCuenta {
  codigo: string | null
  cantidad: number | null
  unidadesPorBulto: number | null
  precioUnitario: number | null
  importe: number | null
  esDescuento: boolean
  estado: 'ok' | 'corregido' | 'revisar'
  articleId: string | null
  /** Alícuota de IVA que trae el renglón en la factura (10.5, 21…), si se leyó. */
  tasaIva?: number | null
  descripcion?: string
  /** Flete, gastos de envío…: cuenta para el total pero no es mercadería (no lleva artículo). */
  esGasto?: boolean
  /** Las unidades por bulto de este código ya las confirmó el usuario en una factura anterior. */
  uxbConfirmado?: boolean
  /** La cantidad leída ya es de unidades (la factura trae bultos × pack = cantidad): no se propone ningún bulto. */
  packResuelto?: boolean
  /**
   * El artículo lo propuso el sistema por parecido de la descripción y el
   * usuario todavía no lo aceptó: se carga, pero NO se recuerda para el proveedor.
   */
  sugerido?: boolean
  /** El renglón salió de una hoja cortada en un borde: su código (o su descripción) no se recuerda. */
  codigoDudoso?: boolean
}

export interface LineaDeCompra {
  articleId: string
  /** Unidades: cantidad × UxB. */
  quantity: string
  /** Costo por unidad, ya en la base del modo de precios de la empresa. */
  unitPrice: string
  /** Alícuota de IVA de la factura (`10.50`), cuando se leyó y es una sola para el artículo. */
  vatRate?: string
  /** Algún renglón de este artículo tiene el artículo sugerido por el sistema (Compras lo marca para controlarlo). */
  sugerido?: boolean
}

export interface PasajeACompras {
  lineas: LineaDeCompra[]
  /**
   * Código del proveedor → artículo, para recordarlo (`facturas.marcarCargada`),
   * con las unidades por bulto con que se cargó (1 = sin bulto). Los renglones
   * sin código se recuerdan por su descripción (`claveDeVinculo`).
   */
  vinculos: { code: string; articleId: string; unitsPerPack?: number }[]
  /** Renglones de artículo que NO se cargan por no tener artículo vinculado. */
  sinArticulo: number
  /** Renglones con artículo que NO se cargan porque falta la cantidad o el precio. */
  sinDatos: number
  /** Renglones que se cargan y figuran como "Revisar" (por la cuenta o por un aviso). */
  porRevisar: number
  /** Renglones que se cargan con un artículo sugerido por el sistema (no confirmado por el usuario). */
  sugeridos: number
  /** Renglones de descuento en "Revisar" o sin importe: el descuento precargado puede estar mal. */
  descuentosPorRevisar: number
  /** Suma de los renglones de descuento, en positivo y en la base de la factura. */
  descuentos: number
  /**
   * Los mismos descuentos en la base de la empresa (convertidos con la
   * alícuota de cada renglón de descuento). null = no se pudieron convertir:
   * las bases no coinciden y algún descuento no trae alícuota.
   */
  descuentosEnBase: number | null
  /** Renglones de gasto (flete, envío…): no se cargan como mercadería. */
  gastos: number
  /** Suma de esos gastos, en la base de la factura. */
  importeGastos: number
  /** Lo que se precarga en el descuento global de Compras ('0' si no corresponde). */
  descuentoACargar: string
  /** true = la base de la factura y la de la empresa coinciden. */
  mismaBase: boolean
  baseFactura: BasePrecios
  /** Subtotal de lo que se carga, en la base de la empresa (antes del descuento). */
  subtotal: number
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
const r4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000

/** Factura A: precios netos. El resto: precios finales. */
export function baseDeLaFactura(tipo: TipoComprobante): BasePrecios {
  return tipo === 'A' ? 'neto' : 'final'
}

export function baseDeLaEmpresa(modo: ModoPrecios): BasePrecios {
  return modo === 'net' ? 'neto' : 'final'
}

/** Precio leído en la factura → costo como lo espera Compras. */
export function costoParaCompras(precio: number, alicuota: number, tipo: TipoComprobante, modo: ModoPrecios): number {
  const desde = baseDeLaFactura(tipo)
  const hacia = baseDeLaEmpresa(modo)
  const r = Number.isFinite(alicuota) && alicuota > 0 ? alicuota / 100 : 0
  if (desde === hacia || r === 0) return r4(precio)
  return r4(desde === 'neto' ? precio * (1 + r) : precio / (1 + r))
}

/**
 * ¿cantidad × UxB × precio da el importe? La misma cuenta (y la misma
 * tolerancia) que `cierra()` de electron/facturas/parser.ts: 5 centavos, o
 * medio centavo por unidad. SIN tolerancia porcentual: un importe con un
 * dígito mal leído tiene que saltar, no pasar por "casi igual".
 */
export function cuentaCierra(cantidad: number, uxb: number, precio: number, importe: number): boolean {
  const unidades = Math.abs(cantidad * uxb)
  const tol = Math.max(0.05, unidades * 0.005 + 0.005) + 1e-9
  // En los descuentos el importe es negativo y el precio puede venir con
  // cualquiera de los dos signos: se compara sin signo.
  return Math.abs(Math.abs(cantidad * uxb * precio) - Math.abs(importe)) <= tol
}

/** Estado de un renglón después de que el usuario tocó sus números. */
export function estadoDelRenglon(r: {
  cantidad: number | null
  unidadesPorBulto: number | null
  precioUnitario: number | null
  importe: number | null
}): { estado: 'ok' | 'revisar'; motivo: string | null } {
  if (r.cantidad === null) return { estado: 'revisar', motivo: 'Falta la cantidad' }
  if (r.precioUnitario === null) return { estado: 'revisar', motivo: 'Falta el precio' }
  if (r.importe === null) return { estado: 'revisar', motivo: 'Sin importe para controlar' }
  return cuentaCierra(r.cantidad, r.unidadesPorBulto ?? 1, r.precioUnitario, r.importe)
    ? { estado: 'ok', motivo: null }
    : { estado: 'revisar', motivo: 'La cuenta no cierra: cantidad × precio ≠ importe' }
}

/** `1234.5` → `1.234,50` (para los avisos). */
function enPesos(n: number): string {
  const [ent, dec] = Math.abs(n).toFixed(2).split('.') as [string, string]
  return `${n < 0 ? '-' : ''}${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}
const enPorciento = (n: number): string => String(n).replace('.', ',')

const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

/**
 * ¿La descripción dice que el producto viene en un bulto de N? ("X 1L X 12",
 * "12X500", "(6x1000cc", "12 X 25 GRS", "X 12U"). Devuelve N o null. No es
 * una medida ("X 5 L", "X 250 CC") ni un tamaño suelto ("X 473").
 */
export function packEnDescripcion(descripcion: string | null | undefined): number | null {
  const d = sinAcentos(String(descripcion ?? ''))
  // "12 x 25 grs", "12x500", "192 x 8 cc": N envases de tal tamaño.
  for (const m of d.matchAll(/(?<![\d.,])(\d{1,3})\s?x\s?\d/g)) {
    const n = Number(m[1])
    if (n >= 2 && n <= 200) return n
  }
  // "x 12", "x 12u": sin unidad de medida detrás.
  const medida = '(?:ml|cc|cm3|grs?|g|kgs?|k|lts?|l|lit\\w*|mts?|m|cm|mm|oz)'
  const re = new RegExp(`\\bx\\s?(\\d{1,3})(?![\\d.,]*\\d)(?!\\s?${medida}\\b)(?=\\s?(?:u|un|uni|unid|unidades)\\b|[^a-z0-9]|$)`, 'g')
  for (const m of d.matchAll(re)) {
    const n = Number(m[1])
    if (n >= 2 && n <= 60) return n
  }
  return null
}

/** ¿El renglón es un gasto (flete, envío, acarreo) y no mercadería? Por la descripción. */
export function esRenglonDeGasto(descripcion: string | null | undefined): boolean {
  return /\b(fletes?|acarreos?|gastos?\s+(de|por)\s+(envio|entrega|reparto|flete|transporte|administra\w*)|costo\s+de\s+envio|envio\s+a\s+domicilio|cargo\s+(de|por)\s+(envio|entrega|servicio)|servicio\s+de\s+(entrega|reparto|logistica))\b/.test(
    sinAcentos(String(descripcion ?? '')),
  )
}

/** Prefijo de la clave de un renglón SIN código: se lo recuerda por su descripción. */
export const PREFIJO_CLAVE_DESCRIPCION = 'desc:'

/**
 * Con qué clave se recuerda el vínculo de un renglón para su proveedor: el
 * código que trae la factura; si el proveedor no usa códigos, la descripción
 * tal cual (sin acentos ni signos). null = no hay con qué recordarlo.
 */
export function claveDeVinculo(r: { codigo: string | null; descripcion?: string | null }): string | null {
  const codigo = r.codigo?.trim()
  if (codigo) return codigo
  const d = sinAcentos(String(r.descripcion ?? '')).replace(/[^a-z0-9ñ]+/g, ' ').trim()
  // Muy corta no identifica a un producto.
  return d.length >= 6 && /[a-zñ]{3}/.test(d) ? `${PREFIJO_CLAVE_DESCRIPCION}${d.slice(0, 120)}` : null
}

/** Palabras que no distinguen a un proveedor de otro. */
const PALABRAS_COMUNES_DE_PROVEEDOR = new Set([
  'distribuidora', 'distribuciones', 'distribucion', 'distribuidor', 'mayorista', 'comercial', 'sociedad', 'hermanos',
  'hnos', 'hijos', 'srl', 'sas', 'sau', 'cia', 'compania', 'del', 'los', 'las', 'the', 'autoservicio', 'supermercado',
  'alimentos', 'bebidas', 'productos', 'casa', 'grupo', 'empresa', 'argentina',
])

function palabrasDeProveedor(nombre: string): string[] {
  return sinAcentos(nombre)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 3 && !PALABRAS_COMUNES_DE_PROVEEDOR.has(w))
}

/** Nombre de proveedor para comparar: sin acentos, sin tipo de sociedad ni signos. */
export function nombreDeProveedorNormalizado(nombre: string): string {
  return sinAcentos(nombre)
    .replace(/\b(s\.?\s?r\.?\s?l|s\.?\s?a\.?\s?s|s\.?\s?a\.?\s?u|s\.?\s?a|s\.?\s?h|s\.?\s?c\.?\s?s|ltda|e hijos|hnos)\b\.?/g, ' ')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim()
}

/**
 * Proveedores ya cargados que pueden ser el emisor leído: el que tiene ese
 * CUIT (primero), el que se llama igual que alguno de los nombres leídos (la
 * razón social o los otros nombres de la hoja: el de fantasía, el de "Razón
 * Social:"), y los que comparten una palabra propia de esos nombres. Es sólo
 * una SUGERENCIA para mostrarle al usuario: nunca se asocia solo por parecido.
 */
export function proveedoresParecidos<P extends { id: string; name: string; cuit?: string | null }>(
  leido: { razonSocial?: string | null; cuit?: string | null; otrosNombres?: readonly (string | null | undefined)[] | null },
  proveedores: readonly P[],
  maximo = 3,
): P[] {
  const cuit = String(leido.cuit ?? '').replace(/\D/g, '')
  const nombres = [leido.razonSocial, ...(leido.otrosNombres ?? [])].map((n) => String(n ?? '')).filter((n) => n.trim() !== '')
  const buscadas = new Set(nombres.flatMap(palabrasDeProveedor))
  const exactos = new Set(nombres.map(nombreDeProveedorNormalizado).filter((n) => n.length >= 4))
  const puntuados: { p: P; puntos: number }[] = []
  for (const p of proveedores) {
    const suyo = String(p.cuit ?? '').replace(/\D/g, '')
    let puntos = 0
    if (cuit && suyo === cuit) puntos += 100
    else if (cuit && suyo && buscadas.size > 0) {
      // Tiene OTRO CUIT cargado: por el nombre solo puede ser un homónimo; va al final.
      puntos -= 0.5
    }
    if (exactos.has(nombreDeProveedorNormalizado(p.name))) puntos += 10
    for (const w of palabrasDeProveedor(p.name)) if (buscadas.has(w)) puntos += 1
    if (puntos >= 0.5) puntuados.push({ p, puntos })
  }
  return puntuados
    .sort((a, b) => b.puntos - a.puntos || a.p.name.localeCompare(b.p.name))
    .slice(0, maximo)
    .map((x) => x.p)
}

/** Cuánto puede alejarse el costo leído del costo actual del artículo sin avisar (×2 / ÷2: la inflación no dispara). */
const SALTO_DE_COSTO = 2

/**
 * Avisos de un renglón YA VINCULADO, que la cuenta de la factura no ve:
 *  - la alícuota de IVA de la factura no es la del artículo;
 *  - el costo leído queda lejísimos del costo actual del artículo (lo típico:
 *    la factura cotiza por bulto y el artículo del comercio es la unidad, o al
 *    revés; el stock y el costo entrarían multiplicados);
 *  - el artículo NO tiene costo cargado (el aviso anterior no puede saltar),
 *    la descripción dice que viene en un bulto de N ("X 12", "12X500") y el
 *    renglón no tiene unidades por bulto: si el artículo del comercio es la
 *    unidad, entrarían N veces menos stock a N veces el costo. No se avisa si
 *    la cantidad ya es un múltiplo de N (viene en unidades) ni si el usuario
 *    ya confirmó las unidades de ese código en una factura anterior.
 * Con avisos el renglón se muestra como "Revisar" aunque la cuenta cierre.
 */
export function avisosDelRenglon(
  r: Pick<RenglonParaCuenta, 'precioUnitario' | 'tasaIva' | 'esDescuento'> &
    Partial<Pick<RenglonParaCuenta, 'descripcion' | 'cantidad' | 'unidadesPorBulto' | 'uxbConfirmado' | 'esGasto' | 'packResuelto'>>,
  articulo: { alicuota: number; costoActual: number | null },
  tipo: TipoComprobante,
  modo: ModoPrecios,
): string[] {
  if (r.esDescuento || r.esGasto) return []
  const avisos: string[] = []
  const sinCosto = articulo.costoActual === null || !(articulo.costoActual > 0)
  const pack = sinCosto && !r.uxbConfirmado ? packEnDescripcion(r.descripcion) : null
  // La factura misma dice que la cantidad es de unidades (packResuelto), o la cantidad es múltiplo del pack.
  const yaEnUnidades = r.packResuelto === true || (pack !== null && r.cantidad != null && r.cantidad >= pack && r.cantidad % pack === 0)
  if (pack !== null && !yaEnUnidades && (r.unidadesPorBulto == null || r.unidadesPorBulto === 1)) {
    avisos.push(`La descripción indica un bulto de ${pack} y el renglón no tiene unidades por bulto: revise si el artículo es la unidad`)
  }
  const tasa = r.tasaIva ?? null
  if (tasa !== null && Math.abs(tasa - articulo.alicuota) > 0.001) {
    avisos.push(`IVA de la factura ${enPorciento(tasa)} % ≠ IVA del artículo ${enPorciento(articulo.alicuota)} %`)
  }
  const actual = articulo.costoActual
  if (r.precioUnitario !== null && r.precioUnitario > 0 && actual !== null && actual > 0) {
    const costo = costoParaCompras(r.precioUnitario, tasa ?? articulo.alicuota, tipo, modo)
    if (costo > actual * SALTO_DE_COSTO || costo < actual / SALTO_DE_COSTO) {
      avisos.push(`Costo leído $ ${enPesos(costo)}; costo actual del artículo $ ${enPesos(actual)}: revise unidades por bulto`)
    }
  }
  return avisos
}

export type ClaseDeComprobante = 'factura' | 'notaCredito' | 'notaDebito'

/**
 * Qué es el comprobante según el código de ARCA del QR. Una nota de crédito
 * RESTA stock y deuda: no se puede cargar como una compra.
 */
export function claseDeComprobante(tipoCmp: number | null | undefined): ClaseDeComprobante {
  if (tipoCmp == null) return 'factura'
  if ([3, 8, 13, 53, 203, 208, 213].includes(tipoCmp)) return 'notaCredito'
  if ([2, 7, 12, 52, 202, 207, 212].includes(tipoCmp)) return 'notaDebito'
  return 'factura'
}

/**
 * Arma lo que se le pasa a Compras. `alicuotaDe` devuelve el IVA del artículo
 * (21, 10.5…) o null si el artículo ya no existe (ese renglón queda afuera).
 * `costoActualDe` (opcional) devuelve el costo actual del artículo, para los
 * avisos de `avisosDelRenglon`.
 *
 * Compras admite UN renglón por artículo: si la factura trae el mismo artículo
 * en dos renglones se suman las cantidades y el costo es el promedio ponderado.
 */
export function armarPasajeACompras(
  renglones: readonly RenglonParaCuenta[],
  tipo: TipoComprobante,
  modo: ModoPrecios,
  alicuotaDe: (articleId: string) => number | null,
  costoActualDe: (articleId: string) => number | null = () => null,
): PasajeACompras {
  const baseFactura = baseDeLaFactura(tipo)
  const mismaBase = baseFactura === baseDeLaEmpresa(modo)
  const porArticulo = new Map<string, { unidades: number; monto: number; tasas: Set<number | null>; sugerido: boolean }>()
  const vinculos = new Map<string, { articleId: string; unitsPerPack: number }>()
  let gastos = 0
  let importeGastos = 0
  /** Descuentos ya en la base de la empresa; null = alguno no se pudo convertir. */
  let descuentosEnBase: number | null = 0
  let sinArticulo = 0
  let sinDatos = 0
  let porRevisar = 0
  let sugeridos = 0
  let descuentos = 0
  let descuentosPorRevisar = 0

  for (const r of renglones) {
    if (r.esDescuento) {
      const monto = Math.abs(r.importe ?? 0)
      descuentos += monto
      if (r.estado === 'revisar' || r.importe === null) descuentosPorRevisar++
      if (monto > 0 && descuentosEnBase !== null) {
        const tasa = r.tasaIva ?? null
        if (mismaBase) descuentosEnBase += monto
        else if (tasa !== null && tasa > 0) descuentosEnBase += costoParaCompras(monto, tasa, tipo, modo)
        else descuentosEnBase = null // sin alícuota no hay cómo pasarlo a la otra base
      }
      continue
    }
    if (r.esGasto && !r.articleId) {
      gastos++
      importeGastos += r.importe ?? 0
      continue
    }
    const alicuota = r.articleId ? alicuotaDe(r.articleId) : null
    if (!r.articleId || alicuota === null) {
      sinArticulo++
      continue
    }
    const unidades = r.cantidad === null ? 0 : r.cantidad * (r.unidadesPorBulto ?? 1)
    if (!(unidades > 0) || r.precioUnitario === null || !(r.precioUnitario >= 0)) {
      sinDatos++
      continue
    }
    const avisos = avisosDelRenglon(r, { alicuota, costoActual: costoActualDe(r.articleId) }, tipo, modo)
    if (r.estado === 'revisar' || avisos.length > 0) porRevisar++
    if (r.sugerido) sugeridos++
    // La alícuota de la factura manda sobre la del artículo cuando se leyó.
    const tasa = r.tasaIva ?? null
    const costo = costoParaCompras(r.precioUnitario, tasa ?? alicuota, tipo, modo)
    const acumulado = porArticulo.get(r.articleId) ?? { unidades: 0, monto: 0, tasas: new Set<number | null>(), sugerido: false }
    acumulado.unidades += unidades
    acumulado.monto += unidades * costo
    acumulado.tasas.add(tasa)
    acumulado.sugerido ||= r.sugerido === true
    porArticulo.set(r.articleId, acumulado)
    // Se recuerda sólo lo que el usuario confirmó: un artículo sugerido por el
    // sistema que nadie aceptó, recordado, vincularía solo (y mal) las
    // próximas facturas. Tampoco lo de una hoja cortada en un borde.
    const code = r.sugerido || r.codigoDudoso ? null : claveDeVinculo(r)
    if (code && !vinculos.has(code)) vinculos.set(code, { articleId: r.articleId, unitsPerPack: r.unidadesPorBulto ?? 1 })
  }

  const lineas: LineaDeCompra[] = []
  let subtotal = 0
  for (const [articleId, a] of porArticulo) {
    const unidades = r4(a.unidades)
    const costo = r4(a.monto / a.unidades)
    const [tasa] = [...a.tasas]
    lineas.push({
      articleId,
      quantity: String(unidades),
      unitPrice: costo.toFixed(4),
      ...(a.tasas.size === 1 && tasa != null ? { vatRate: tasa.toFixed(2) } : {}),
      ...(a.sugerido ? { sugerido: true } : {}),
    })
    subtotal += unidades * costo
  }
  descuentos = r2(descuentos)
  subtotal = r2(subtotal)
  if (descuentosEnBase !== null) descuentosEnBase = r2(descuentosEnBase)
  // El descuento se precarga sólo si se lo pudo llevar a la base de los costos
  // y no se lleva puesta la compra entera (Compras no admite total en cero).
  const cargarDescuento = descuentosEnBase !== null && descuentosEnBase > 0 && descuentosEnBase < subtotal
  return {
    lineas,
    vinculos: [...vinculos].map(([code, v]) => ({ code, articleId: v.articleId, unitsPerPack: v.unitsPerPack })),
    sinArticulo,
    sinDatos,
    porRevisar,
    sugeridos,
    descuentosPorRevisar,
    descuentos,
    descuentosEnBase,
    gastos,
    importeGastos: r2(importeGastos),
    descuentoACargar: cargarDescuento ? descuentosEnBase!.toFixed(2) : '0',
    mismaBase,
    baseFactura,
    subtotal,
  }
}

export interface ControlDeTotal {
  /** Suma de los importes de los renglones tal como se leyeron (los descuentos restan). */
  suma: number
  /** La suma más el IVA de cada renglón (sólo tiene sentido en Factura A). */
  sumaConIva: number
  /** Contra qué se comparó: el total leído o, si no hay, el subtotal. null = no se leyó ninguno. */
  total: number | null
  /** null = no hay total para controlar. */
  coincide: boolean | null
  /** Lo que más se acercó menos el total (0 si coincide o no hay control). */
  diferencia: number
  /**
   * Lo que el total dice de los precios de los renglones: `final` = la suma
   * tal cual ya da el total (B, C o X); `neto` = recién da sumándole el IVA
   * (Factura A). null = no se puede saber (sin total, o dan las dos).
   */
  baseSugerida: BasePrecios | null
  /**
   * El tipo elegido contradice al total: Factura A con renglones que ya suman
   * el total (a cada costo se le sumaría un IVA que ya tiene), o B/C/X con
   * renglones netos. Hay que revisar el tipo antes de cargar.
   */
  tipoDudoso: boolean
}

/** Cuánto puede diferir la suma de los renglones del total leído. */
export const TOLERANCIA_DE_TOTAL = 1

/**
 * Control de la factura entera: ¿la suma de los renglones da el total leído
 * (del QR fiscal o impreso en el pie)? Si no da, puede faltar un renglón.
 *
 * Coincide si, con un peso de tolerancia:
 *  - la suma da el total (Factura B, C, X: precios finales), o
 *  - la suma da el subtotal impreso (Factura A: el subtotal es el neto), o
 *  - en Factura A (o sin tipo), la suma MÁS el IVA de cada renglón da el total.
 *    `alicuotaDe` devuelve el IVA del artículo vinculado; se usa el de la
 *    factura si se leyó y, si no hay ninguno, 21 %.
 * Una Factura A con percepciones o impuestos internos y sin subtotal impreso
 * NO va a coincidir: la cuenta no puede saber cuánto son.
 */
export function controlDeTotal<R extends { importe: number | null; esDescuento: boolean; tasaIva?: number | null }>(
  renglones: readonly R[],
  leido: { total: number | null; subtotal?: number | null },
  tipo: TipoComprobante | null,
  alicuotaDe: (r: R) => number | null = () => null,
): ControlDeTotal {
  let suma = 0
  let sumaConIva = 0
  for (const r of renglones) {
    if (!r || typeof r.importe !== 'number' || !Number.isFinite(r.importe)) continue
    const importe = r.esDescuento ? -Math.abs(r.importe) : r.importe
    const alicuota = r.tasaIva ?? alicuotaDe(r) ?? 21
    suma += importe
    sumaConIva += importe * (1 + (Number.isFinite(alicuota) && alicuota > 0 ? alicuota : 0) / 100)
  }
  suma = r2(suma)
  sumaConIva = r2(sumaConIva)
  const total = leido.total ?? null
  const subtotal = leido.subtotal ?? null
  if (total === null && subtotal === null) {
    return { suma, sumaConIva, total: null, coincide: null, diferencia: 0, baseSugerida: null, tipoDudoso: false }
  }
  const cerca = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCIA_DE_TOTAL + 1e-9
  const conIva = tipo === 'A' || tipo === null
  const coincide =
    (total !== null && (cerca(suma, total) || (conIva && cerca(sumaConIva, total)))) || (subtotal !== null && cerca(suma, subtotal))
  // La diferencia que se muestra es contra el total; en Factura A, la de la suma con IVA.
  const referencia = total ?? subtotal!
  const candidatas = total !== null && conIva ? [suma - referencia, sumaConIva - referencia] : [suma - referencia]
  const diferencia = coincide ? 0 : r2(candidatas.reduce((m, d) => (Math.abs(d) < Math.abs(m) ? d : m)))
  let baseSugerida: BasePrecios | null = null
  if (total !== null && suma !== 0) {
    const daFinal = cerca(suma, total)
    const daNeto = cerca(sumaConIva, total) || (subtotal !== null && cerca(suma, subtotal) && total > suma)
    if (daFinal && !cerca(sumaConIva, total)) baseSugerida = 'final'
    else if (!daFinal && daNeto) baseSugerida = 'neto'
  }
  const tipoDudoso = tipo !== null && baseSugerida !== null && baseSugerida !== baseDeLaFactura(tipo)
  return { suma, sumaConIva, total: referencia, coincide, diferencia, baseSugerida, tipoDudoso }
}

/** `0001-00012345`, como se escribe a mano en Compras. Vacío si falta el número. */
export function numeroDeFactura(ptoVta: number | null, nroCmp: number | null): string {
  if (nroCmp === null) return ''
  const numero = String(nroCmp).padStart(8, '0')
  return ptoVta === null ? numero : `${String(ptoVta).padStart(4, '0')}-${numero}`
}

/** `1790000000000` → `21/09/2026` (para los avisos). */
export function fechaCorta(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

/** El aviso de una factura que ya se cargó antes (compra registrada o factura escaneada «Cargada»). */
export function avisoYaCargada(yaCargada: { fecha: number } | null | undefined): string | null {
  return yaCargada ? `Esta factura ya fue cargada el ${fechaCorta(yaCargada.fecha)}.` : null
}

/* ──────────────────────────── códigos y CUIT ──────────────────────────── */

/**
 * ¿El código tiene forma de código de barras (EAN-8, UPC-A, EAN-13 o GTIN-14
 * con el dígito verificador bien)? El código que trae la factura es el código
 * INTERNO del proveedor; sólo si es un código de barras de verdad se puede
 * buscar tal cual en el padrón sin riesgo de caer en otro artículo (en
 * StockFlow `barcode` también guarda los códigos propios del comercio).
 */
export function esCodigoDeBarras(codigo: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(codigo)) return false
  let suma = 0
  for (let i = codigo.length - 2, peso = 3; i >= 0; i--, peso = 4 - peso) suma += Number(codigo[i]) * peso
  return (10 - (suma % 10)) % 10 === Number(codigo[codigo.length - 1])
}

/**
 * Próximo código interno libre para un artículo nuevo que no trae código de
 * barras: el mayor código numérico corto (hasta 7 dígitos; los de 8 o más son
 * de barras) + 1, con el mismo ancho si se usan ceros a la izquierda.
 */
export function proximoCodigoInterno(codigos: Iterable<string>): string {
  const usados = new Set<string>()
  let mayor = 0
  let ancho = 1
  for (const c of codigos) {
    const t = String(c ?? '').trim()
    usados.add(t)
    if (!/^\d{1,7}$/.test(t)) continue
    const n = Number(t)
    if (n > mayor || (n === mayor && t.length > ancho)) {
      mayor = n
      ancho = t.length
    }
  }
  for (let n = mayor + 1; ; n++) {
    const codigo = String(n).padStart(ancho, '0')
    if (!usados.has(codigo)) return codigo
  }
}

/** Alícuotas que acepta la ficha de un artículo. */
export const ALICUOTAS_DE_ARTICULO = ['0.00', '10.50', '21.00', '27.00'] as const

/**
 * Lo que se precarga en el alta de un artículo desde un renglón de la
 * factura: la descripción leída, el código de barras si el código leído lo es
 * (si no, vacío: lo escanea o lo genera el usuario; el código interno del
 * proveedor NO es el del comercio), el IVA del renglón (21 % si no se leyó o
 * no es una alícuota de artículo) y el costo por unidad en la base de la
 * empresa, con la misma regla neto/IVA que el pasaje a Compras.
 */
export function datosArticuloNuevo(
  r: { codigo: string | null; descripcion?: string | null; precioUnitario: number | null; tasaIva?: number | null },
  tipo: TipoComprobante | null,
  modo: ModoPrecios,
  vatRate?: string,
): { description: string; barcode: string; vatRate: string; costPrice: string } {
  const codigo = String(r.codigo ?? '').trim()
  const leida = typeof r.tasaIva === 'number' ? r.tasaIva.toFixed(2) : ''
  const iva =
    vatRate && (ALICUOTAS_DE_ARTICULO as readonly string[]).includes(vatRate)
      ? vatRate
      : (ALICUOTAS_DE_ARTICULO as readonly string[]).includes(leida)
        ? leida
        : '21.00'
  // Sin tipo elegido no se convierte: el precio se toma en la base de la empresa.
  const tipoDeCuenta: TipoComprobante = tipo ?? (modo === 'net' ? 'A' : 'B')
  const precio = r.precioUnitario
  const costo = precio !== null && Number.isFinite(precio) && precio > 0 ? costoParaCompras(precio, Number(iva), tipoDeCuenta, modo) : 0
  return {
    description: String(r.descripcion ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    barcode: esCodigoDeBarras(codigo) ? codigo : '',
    vatRate: iva,
    costPrice: costo.toFixed(4),
  }
}

/** CUIT bien formado: 11 dígitos, prefijo que existe y dígito verificador (el mismo control que electron/facturas/encabezado.ts). */
export function cuitValido(cuit: string): boolean {
  if (!/^\d{11}$/.test(cuit) || !['20', '23', '24', '25', '26', '27', '30', '33', '34'].includes(cuit.slice(0, 2))) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let suma = 0
  for (let i = 0; i < 10; i++) suma += Number(cuit[i]) * pesos[i]!
  const resto = 11 - (suma % 11)
  const dv = resto === 11 ? 0 : resto === 10 ? -1 : resto
  return dv === Number(cuit[10])
}

/** `30712492437` → `30-71249243-7` (como se escribe un CUIT). */
export function cuitConGuiones(cuit: string): string {
  const d = String(cuit ?? '').replace(/\D/g, '')
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}` : cuit
}

/**
 * El usuario eligió a mano un proveedor que no tiene CUIT y la factura trae
 * uno válido: es el CUIT que se le ofrece guardar (así la próxima factura de
 * ese proveedor se asocia sola). null = no corresponde ofrecer nada: el
 * proveedor ya tiene CUIT, el leído no es válido, u otro proveedor ya lo tiene
 * (sería un duplicado).
 */
export function cuitParaGuardar(
  proveedor: { id: string; cuit?: string | null } | null | undefined,
  cuitLeido: string | null | undefined,
  proveedores: readonly { id: string; cuit?: string | null }[],
): string | null {
  if (!proveedor) return null
  const leido = String(cuitLeido ?? '').replace(/\D/g, '')
  if (!cuitValido(leido)) return null
  if (String(proveedor.cuit ?? '').replace(/\D/g, '') !== '') return null
  if (proveedores.some((p) => p.id !== proveedor.id && String(p.cuit ?? '').replace(/\D/g, '') === leido)) return null
  return leido
}

/* ─────────────────── atajo: de la factura leída a Compras ─────────────────── */

/**
 * Tipo de comprobante con el que se hace la cuenta: el que eligió el usuario
 * (el comprobante X no tiene letra); si no eligió, la letra leída (la Factura
 * M se trata como A: precios netos). null = no se sabe.
 */
export function tipoDeEncabezado(h: { tipo?: TipoComprobante | null; letra?: string | null } | null | undefined): TipoComprobante | null {
  if (h?.tipo) return h.tipo
  if (h?.letra === 'M') return 'A'
  return h?.letra === 'A' || h?.letra === 'B' || h?.letra === 'C' ? h.letra : null
}

/** Lo que mira el atajo de una factura leída (la forma de `FacturaEscaneadaDetalleDTO`). */
export interface FacturaParaAtajo {
  supplierId: string | null
  listaParaCargar: boolean
  tipoDudoso: boolean
  repetida: boolean
  totalCoincide: boolean | null
  compraExistente?: unknown
  /** La factura ya se cargó antes (compra registrada o factura escaneada «Cargada»). */
  yaCargada?: { fecha: number } | null
  header: {
    tipo?: TipoComprobante | null
    letra?: string | null
    tipoCmp?: number | null
    ptoVta?: number | null
    nroCmp?: number | null
    fecha?: string | null
  } | null
  lineas: readonly (RenglonParaCuenta & { uxbRecordado?: number | null })[]
}

export type DecisionAtajo =
  | { directo: true; tipo: TipoComprobante; pasaje: PasajeACompras }
  | { directo: false; motivo: string }

/**
 * ¿La factura pasa sola al formulario de Compras? Sí, si salió completa:
 * proveedor, tipo de comprobante, todos los renglones con artículo (vinculado
 * o sugerido con confianza por el sistema), nada en revisar, el total
 * coincide, no se cargó antes y los descuentos se pueden precargar. Ante
 * cualquier duda, no: se abre la revisión (`motivo` dice por qué). La compra
 * la confirma siempre el usuario en Compras.
 * `articuloDe` devuelve el IVA y el costo actual del artículo ACTIVO (null si
 * ya no está o está dado de baja).
 */
export function decidirAtajo(
  f: FacturaParaAtajo,
  modo: ModoPrecios,
  articuloDe: (articleId: string) => { alicuota: number; costo: number | null } | null,
): DecisionAtajo {
  const no = (motivo: string): DecisionAtajo => ({ directo: false, motivo })
  const tipo = tipoDeEncabezado(f.header)
  if (!f.supplierId) return no('Falta elegir el proveedor.')
  if (!tipo) return no('No se leyó el tipo de comprobante (A, B, C o X).')
  if (claseDeComprobante(f.header?.tipoCmp) === 'notaCredito') return no('Es una nota de crédito: no se carga como compra.')
  const aviso = avisoYaCargada(f.yaCargada)
  if (aviso) return no(aviso)
  if (f.compraExistente) return no('Ya hay una compra registrada de este proveedor con este número de factura.')
  if (f.repetida) return no('El comprobante figura en otra factura escaneada.')
  if (f.tipoDudoso) return no('El tipo de comprobante no coincide con el total de la factura.')
  if (f.totalCoincide === null) return no('No se leyó el total de la factura.')
  if (f.totalCoincide === false) return no('La suma de los renglones no coincide con el total de la factura.')
  if (f.lineas.some((r) => r.esGasto && !r.articleId)) return no('La factura tiene gastos (flete, envío) que no son mercadería.')
  const sinArticulo = f.lineas.filter((r) => !r.esDescuento && !r.articleId).length
  if (sinArticulo > 0) return no(sinArticulo === 1 ? 'Hay 1 renglón sin artículo.' : `Hay ${sinArticulo} renglones sin artículo.`)
  if (f.lineas.some((r) => r.estado === 'revisar')) return no('Hay renglones para revisar.')
  if (!f.listaParaCargar) return no('La factura necesita una revisión.')
  const pasaje = armarPasajeACompras(
    f.lineas.map((r) => ({ ...r, uxbConfirmado: r.uxbRecordado != null })),
    tipo,
    modo,
    (id) => articuloDe(id)?.alicuota ?? null,
    (id) => articuloDe(id)?.costo ?? null,
  )
  if (pasaje.lineas.length === 0) return no('No hay artículos para cargar.')
  if (pasaje.sinArticulo > 0) return no('Hay renglones con un artículo dado de baja.')
  if (pasaje.sinDatos > 0) return no('Hay renglones sin cantidad o sin precio.')
  if (pasaje.porRevisar > 0) return no('Hay renglones para revisar (IVA o costo distinto del artículo).')
  if (pasaje.descuentosPorRevisar > 0) return no('Hay descuentos para revisar.')
  // Descuentos que no se pueden precargar (la compra quedaría por más que la
  // factura) o gastos que no son mercadería: eso se decide en la revisión.
  if (pasaje.descuentos > 0 && pasaje.descuentoACargar === '0') return no('Los descuentos de la factura no se pueden cargar solos.')
  if (pasaje.gastos > 0) return no('La factura tiene gastos (flete, envío) que no son mercadería.')
  return { directo: true, tipo, pasaje }
}

/** Lo que recibe Compras para precargar el formulario (ver `extras` en Compras.tsx). */
export interface PrefillDeFactura {
  facturaId: string
  vinculos: PasajeACompras['vinculos']
  prefilledLines: LineaDeCompra[]
  header: {
    supplierId: string | null
    voucherType: TipoComprobante
    invoiceNumber: string
    dateIso: string | null
    /** Descuento global, en la misma base que los costos. */
    discount: string
  }
  /** Avisos para mostrar arriba del formulario mientras dure esa compra ("Esta factura ya fue cargada el …"). */
  avisos: string[]
  from: 'facturaEscaneada'
  /** Distinto en cada pasaje: con la ventana ya abierta, cada factura entra una vez. */
  lote: number
}

export function prefillDeFactura(
  id: string,
  d: {
    supplierId: string | null
    tipo: TipoComprobante
    ptoVta: number | null
    nroCmp: number | null
    fecha: string | null
    yaCargada?: { fecha: number } | null
  },
  pasaje: PasajeACompras,
): PrefillDeFactura {
  const aviso = avisoYaCargada(d.yaCargada)
  return {
    facturaId: id,
    vinculos: pasaje.vinculos,
    prefilledLines: pasaje.lineas,
    header: {
      supplierId: d.supplierId,
      voucherType: d.tipo,
      invoiceNumber: numeroDeFactura(d.ptoVta, d.nroCmp),
      dateIso: d.fecha || null,
      discount: pasaje.descuentoACargar,
    },
    avisos: aviso ? [aviso] : [],
    from: 'facturaEscaneada',
    lote: Date.now(),
  }
}

/* ─────────────── Compras: «Cargar con el teléfono» ─────────────── */

/**
 * ¿Compras muestra «Cargar con el teléfono»? Sólo con la opción activa: con
 * la opción apagada Compras queda como siempre (sin botón).
 */
export function cargaTelefonoVisible(estado: { activo?: boolean } | null | undefined): boolean {
  return estado?.activo === true
}

/**
 * Cada cuánto vuelve a pedir Compras el estado de las facturas por teléfono
 * (el contador de «Facturas escaneadas»). Apagada la opción, nunca: se pide
 * una vez al abrir y no se sondea nada más.
 */
export function intervaloEstadoCompras(estado: { activo?: boolean } | null | undefined): number | false {
  return estado?.activo === true ? 15_000 : false
}

/** Lo que se muestra en Compras mientras el teléfono manda y la PC lee la factura. */
export function textoDeSeguimiento(f: {
  estado: string
  hojas: number
  hojasLeidas: number
  lento?: boolean
  error?: string | null
}): string {
  const hojas = Math.max(0, f.hojas)
  switch (f.estado) {
    case 'recibiendo':
      return hojas > 0 ? `Recibiendo hoja ${hojas}…` : 'Esperando la primera hoja…'
    case 'en_cola':
    case 'leyendo': {
      if (hojas === 0) return 'Leyendo la factura…'
      const texto = `Leyendo hoja ${Math.min(Math.max(f.hojasLeidas, 0) + 1, hojas)} de ${hojas}…`
      return f.lento ? `${texto} Puede demorar unos minutos.` : texto
    }
    case 'lista':
      return 'Factura leída.'
    case 'error':
      return f.error || 'No se pudo leer la factura.'
    case 'cargada':
      return 'La factura ya se cargó en Compras.'
    case 'descartada':
      return 'La factura se descartó.'
    default:
      return ''
  }
}
