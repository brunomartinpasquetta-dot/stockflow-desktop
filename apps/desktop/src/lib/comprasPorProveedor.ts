/**
 * Compras por proveedor (Contabilidad): arma las filas a partir de las compras
 * del período y los proveedores, las filtra y las agrupa. Funciones puras, sin
 * React, compartidas por la pantalla y la exportación a Excel.
 *
 * A diferencia del Libro IVA Compras, acá entran TODAS las compras cargadas
 * (A, B, C y X): la pantalla sirve para controlar lo que se le compró a cada
 * proveedor, no sólo el crédito fiscal.
 */
import type { PurchaseDTO, SupplierDTO, VoucherType } from '@/types/api'

type EstadoCompra = PurchaseDTO['status']

export interface CompraProveedorFila {
  purchaseId: string
  date: number
  type: VoucherType
  /** Número interno de StockFlow (correlativo por tipo). */
  number: number
  /** Número del comprobante del proveedor, tal como se cargó (p. ej. 0001-00012345). */
  supplierInvoiceNumber: string | null
  supplierId: string
  supplierCode: string
  supplierName: string
  supplierCuit: string | null
  /** Neto = total − IVA, con 4 decimales como el resto de los importes. */
  net: string
  vat: string
  total: string
  status: EstadoCompra
}

interface TotalesCompras {
  /** Comprobantes que suman (no anulados). */
  cantidad: number
  anuladas: number
  net: string
  vat: string
  total: string
}

export interface GrupoProveedor extends TotalesCompras {
  supplierId: string
  supplierCode: string
  supplierName: string
  supplierCuit: string | null
  /** Ordenadas por fecha ascendente. */
  filas: CompraProveedorFila[]
}

interface FiltrosCompras {
  /** Vacío = todos. */
  supplierId?: string
  type?: VoucherType | 'all'
  incluirAnuladas?: boolean
}

function fix4(n: number): string {
  return n.toFixed(4)
}

export function armarFilas(compras: PurchaseDTO[], proveedores: SupplierDTO[]): CompraProveedorFila[] {
  const porId = new Map(proveedores.map((s) => [s.id, s]))
  return compras.map((p) => {
    const sup = porId.get(p.supplierId)
    return {
      purchaseId: p.id,
      date: p.date,
      type: p.type,
      number: p.number,
      supplierInvoiceNumber: p.supplierInvoiceNumber,
      supplierId: p.supplierId,
      supplierCode: sup?.code ?? '',
      supplierName: sup?.name ?? '—',
      supplierCuit: sup?.cuit ?? null,
      net: fix4(Number(p.total) - Number(p.vatAmount)),
      vat: p.vatAmount,
      total: p.total,
      status: p.status,
    }
  })
}

export function filtrarFilas(filas: CompraProveedorFila[], f: FiltrosCompras): CompraProveedorFila[] {
  return filas.filter((r) => {
    if (f.supplierId && r.supplierId !== f.supplierId) return false
    if (f.type && f.type !== 'all' && r.type !== f.type) return false
    if (!f.incluirAnuladas && r.status === 'voided') return false
    return true
  })
}

function cmpFecha(a: CompraProveedorFila, b: CompraProveedorFila): number {
  if (a.date !== b.date) return a.date - b.date
  if (a.type !== b.type) return a.type.localeCompare(b.type)
  return a.number - b.number
}

/** Orden plano: fecha ascendente; a igual fecha, proveedor y número. */
export function ordenarPorFecha(filas: CompraProveedorFila[]): CompraProveedorFila[] {
  return [...filas].sort((a, b) => {
    if (a.date !== b.date) return a.date - b.date
    const porNombre = a.supplierName.localeCompare(b.supplierName, 'es')
    if (porNombre !== 0) return porNombre
    return cmpFecha(a, b)
  })
}

export function sumarFilas(filas: CompraProveedorFila[]): TotalesCompras {
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

/** Grupos por proveedor ordenados por nombre; dentro de cada uno, por fecha. */
export function agruparPorProveedor(filas: CompraProveedorFila[]): GrupoProveedor[] {
  const grupos = new Map<string, CompraProveedorFila[]>()
  for (const r of filas) {
    const lista = grupos.get(r.supplierId)
    if (lista) lista.push(r)
    else grupos.set(r.supplierId, [r])
  }
  const salida: GrupoProveedor[] = []
  for (const [supplierId, lista] of grupos) {
    const ordenadas = [...lista].sort(cmpFecha)
    const primera = ordenadas[0]
    if (!primera) continue
    salida.push({
      supplierId,
      supplierCode: primera.supplierCode,
      supplierName: primera.supplierName,
      supplierCuit: primera.supplierCuit,
      filas: ordenadas,
      ...sumarFilas(ordenadas),
    })
  }
  salida.sort((a, b) => a.supplierName.localeCompare(b.supplierName, 'es'))
  return salida
}
