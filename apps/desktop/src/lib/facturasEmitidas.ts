/**
 * Facturas emitidas (Contabilidad): arma las filas a partir de las ventas del
 * período, los comprobantes fiscales con CAE y los clientes; las filtra y las
 * agrupa por cliente. Funciones puras, sin React, compartidas por la pantalla
 * y la exportación a Excel.
 *
 * A diferencia del Libro IVA Ventas, acá entran TODOS los comprobantes de
 * venta (A, B, C y X, con o sin CAE) más las notas de crédito/débito emitidas:
 * la pantalla sirve para controlar qué se le facturó a cada cliente.
 *
 * Dos fuentes, unidas por venta y sin duplicar:
 *  - `sales` manda: una fila por venta del período, tenga o no CAE.
 *  - `fiscal_vouchers` decora: si la venta tiene factura aprobada, la fila
 *    toma la letra, el punto de venta, el número fiscal y el CAE (la verdad
 *    ante ARCA). Las notas de crédito/débito no nacen de una venta: son filas
 *    propias (NC/ND), con importe negativo las de crédito.
 */
import type { CustomerDTO, FiscalVoucherDTO, SaleDTO, VoucherType } from '@/types/api'

type EstadoFactura = 'completed' | 'voided' | 'pending'
type ClaseComprobante = FiscalVoucherDTO['kind']

export interface FacturaEmitidaFila {
  /** Clave única de la fila: id de la venta, o `nota:<id>` para NC/ND. */
  id: string
  /** Venta de origen (para abrir el detalle). Las notas heredan la de su factura. */
  saleId: string | null
  date: number
  kind: ClaseComprobante
  /** Letra del comprobante: la fiscal si tiene CAE; si no, la de la venta. */
  type: VoucherType
  /** Número interno de StockFlow (correlativo por tipo). 0 en las notas. */
  number: number
  /** Punto de venta y número fiscal (00004-00001234) cuando hay CAE. */
  numeroFiscal: string | null
  cae: string | null
  customerId: string
  customerName: string
  /** Documento de la ficha del cliente ("CUIT 30-…", "DNI …"), o null. */
  customerDoc: string | null
  /** Importes con signo: negativos en las notas de crédito. 4 decimales. */
  net: string
  vat: string
  total: string
  status: EstadoFactura
  /** true si el "Pendiente" es por falta de CAE (factura A/B/C con ARCA activo). */
  sinCae: boolean
}

interface TotalesFacturas {
  /** Comprobantes que suman (no anulados). */
  cantidad: number
  anuladas: number
  net: string
  vat: string
  total: string
}

export interface GrupoCliente extends TotalesFacturas {
  customerId: string
  customerName: string
  customerDoc: string | null
  /** Ordenadas por fecha ascendente. */
  filas: FacturaEmitidaFila[]
}

interface FiltrosFacturas {
  /** Vacío = todos. */
  customerId?: string
  type?: VoucherType | 'all'
  incluirAnuladas?: boolean
}

interface OpcionesArmado {
  from: number
  to: number
  /** Facturación electrónica activa: una A/B/C sin CAE queda "Pendiente". */
  fiscalHabilitada: boolean
}

const CONSUMIDOR_FINAL = 'Consumidor final'

/** Códigos de documento de ARCA que identifican al receptor (99 = sin identificar). */
const DOC_ARCA: Record<number, string> = { 80: 'CUIT', 86: 'CUIL', 96: 'DNI', 94: 'Pasaporte' }

function fix4(n: number): string {
  return n.toFixed(4)
}

/** La ficha genérica del mostrador: ventas sin cliente asignado. */
function esConsumidorFinal(c: Pick<CustomerDTO, 'lastName'>): boolean {
  return c.lastName.trim().toUpperCase() === 'CONSUMIDOR FINAL'
}

export function nombreCliente(c: CustomerDTO | undefined, alternativo = '—'): string {
  if (!c) return alternativo
  if (esConsumidorFinal(c)) return CONSUMIDOR_FINAL
  return c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName
}

function documentoCliente(c: CustomerDTO | undefined): string | null {
  if (!c || !c.docType || c.docType === 'CF') return null
  const nro = c.docNumber?.trim()
  if (!nro) return null
  return `${c.docType === 'PASS' ? 'Pasaporte' : c.docType} ${nro}`
}

function documentoVoucher(
  v: Pick<FiscalVoucherDTO, 'customerDocType' | 'customerDocNumber'>,
): string | null {
  const etiqueta = DOC_ARCA[v.customerDocType]
  const nro = v.customerDocNumber.trim()
  return etiqueta && nro ? `${etiqueta} ${nro}` : null
}

/** Numeración de ARCA: punto de venta a 5 dígitos y número a 8. */
function numeroFiscal(salePoint: number, number: number): string {
  return `${String(salePoint).padStart(5, '0')}-${String(number).padStart(8, '0')}`
}

/** "A", "NC B", "ND A": lo que se muestra en la columna Tipo y en el Excel. */
export function etiquetaTipo(fila: Pick<FacturaEmitidaFila, 'kind' | 'type'>): string {
  if (fila.kind === 'credit_note') return `NC ${fila.type}`
  if (fila.kind === 'debit_note') return `ND ${fila.type}`
  return fila.type
}

export function armarFilas(
  ventas: SaleDTO[],
  vouchers: FiscalVoucherDTO[],
  clientes: CustomerDTO[],
  op: OpcionesArmado,
): FacturaEmitidaFila[] {
  const porId = new Map(clientes.map((c) => [c.id, c]))

  // Factura aprobada de cada venta (`listVouchers` ya trae sólo las aprobadas).
  const facturaPorVenta = new Map<string, FiscalVoucherDTO>()
  for (const v of vouchers) {
    if (v.kind === 'invoice' && v.saleId && v.cae) facturaPorVenta.set(v.saleId, v)
  }

  const filas: FacturaEmitidaFila[] = ventas.map((s) => {
    const c = porId.get(s.customerId)
    const v = facturaPorVenta.get(s.id)
    const cae = v?.cae ?? s.afipCAE ?? null
    const type: VoucherType = v?.letter ?? s.type
    const sinCae = s.status === 'completed' && op.fiscalHabilitada && type !== 'X' && !cae
    const status: EstadoFactura =
      s.status === 'voided' ? 'voided' : s.status === 'pending' || sinCae ? 'pending' : 'completed'
    return {
      id: s.id,
      saleId: s.id,
      date: s.date,
      kind: 'invoice',
      type,
      number: s.number,
      numeroFiscal: v ? numeroFiscal(v.salePoint, v.number) : null,
      cae,
      customerId: s.customerId,
      customerName: nombreCliente(c, v?.customerName ?? '—'),
      // El documento es el de la ficha: el tipeado en el mostrador (DNI de un
      // consumidor final) queda en el comprobante, no en el grupo del cliente.
      customerDoc: documentoCliente(c) ?? (c || !v ? null : documentoVoucher(v)),
      net: fix4(Number(s.total) - Number(s.vatAmount)),
      vat: s.vatAmount,
      total: s.total,
      status,
      sinCae,
    }
  })

  // Notas de crédito/débito del período: filas propias, con el signo de la nota.
  for (const v of vouchers) {
    if (v.kind === 'invoice' || v.date < op.from || v.date > op.to) continue
    const signo = v.kind === 'credit_note' ? -1 : 1
    const c = porId.get(v.customerId)
    filas.push({
      id: `nota:${v.id}`,
      saleId: v.saleId,
      date: v.date,
      kind: v.kind,
      type: v.letter,
      number: 0,
      numeroFiscal: numeroFiscal(v.salePoint, v.number),
      cae: v.cae,
      customerId: v.customerId,
      customerName: nombreCliente(c, v.customerName),
      customerDoc: documentoCliente(c) ?? (c ? null : documentoVoucher(v)),
      net: fix4(signo * Number(v.netAmount)),
      vat: fix4(signo * Number(v.vatAmount)),
      total: fix4(signo * Number(v.total)),
      status: 'completed',
      sinCae: false,
    })
  }

  return filas
}

export function filtrarFilas(filas: FacturaEmitidaFila[], f: FiltrosFacturas): FacturaEmitidaFila[] {
  return filas.filter((r) => {
    if (f.customerId && r.customerId !== f.customerId) return false
    if (f.type && f.type !== 'all' && r.type !== f.type) return false
    if (!f.incluirAnuladas && r.status === 'voided') return false
    return true
  })
}

function cmpFecha(a: FacturaEmitidaFila, b: FacturaEmitidaFila): number {
  if (a.date !== b.date) return a.date - b.date
  if (a.type !== b.type) return a.type.localeCompare(b.type)
  const porFiscal = (a.numeroFiscal ?? '').localeCompare(b.numeroFiscal ?? '')
  if (porFiscal !== 0) return porFiscal
  return a.number - b.number
}

/** Orden plano: fecha ascendente; a igual fecha, cliente y número. */
export function ordenarPorFecha(filas: FacturaEmitidaFila[]): FacturaEmitidaFila[] {
  return [...filas].sort((a, b) => {
    if (a.date !== b.date) return a.date - b.date
    const porNombre = a.customerName.localeCompare(b.customerName, 'es')
    if (porNombre !== 0) return porNombre
    return cmpFecha(a, b)
  })
}

/**
 * Plano, de la más nueva a la más vieja. La lista abre con TODAS y se carga por
 * páginas (las más nuevas primero): "Mostrar más" agrega abajo las anteriores.
 */
export function ordenarRecientesPrimero(filas: FacturaEmitidaFila[]): FacturaEmitidaFila[] {
  return [...filas].sort((a, b) => {
    if (a.date !== b.date) return b.date - a.date
    const porFiscal = (b.numeroFiscal ?? '').localeCompare(a.numeroFiscal ?? '')
    if (porFiscal !== 0) return porFiscal
    return b.number - a.number
  })
}

export function sumarFilas(filas: FacturaEmitidaFila[]): TotalesFacturas {
  let net = 0
  let vat = 0
  let total = 0
  let cantidad = 0
  let anuladas = 0
  for (const r of filas) {
    if (r.status === 'voided') {
      anuladas++
      continue
    }
    cantidad++
    net += Number(r.net)
    vat += Number(r.vat)
    total += Number(r.total)
  }
  return { cantidad, anuladas, net: fix4(net), vat: fix4(vat), total: fix4(total) }
}

/** Grupos por cliente ordenados por nombre; dentro de cada uno, por fecha. */
export function agruparPorCliente(filas: FacturaEmitidaFila[]): GrupoCliente[] {
  const grupos = new Map<string, FacturaEmitidaFila[]>()
  for (const r of filas) {
    const lista = grupos.get(r.customerId)
    if (lista) lista.push(r)
    else grupos.set(r.customerId, [r])
  }
  const salida: GrupoCliente[] = []
  for (const [customerId, lista] of grupos) {
    const ordenadas = [...lista].sort(cmpFecha)
    const primera = ordenadas[0]
    if (!primera) continue
    salida.push({
      customerId,
      customerName: primera.customerName,
      customerDoc: ordenadas.find((r) => r.customerDoc)?.customerDoc ?? null,
      filas: ordenadas,
      ...sumarFilas(ordenadas),
    })
  }
  salida.sort((a, b) => a.customerName.localeCompare(b.customerName, 'es'))
  return salida
}
