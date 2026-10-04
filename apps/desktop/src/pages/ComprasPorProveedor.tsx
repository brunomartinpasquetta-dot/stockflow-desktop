/**
 * P-CONTABLE: Compras por proveedor.
 * Todas las compras cargadas en un período (A, B, C y X — no sólo las que van
 * al Libro IVA), agrupadas por proveedor y ordenadas por fecha, con neto, IVA,
 * total y estado. Pedido del dueño: ver qué se le compró a cada proveedor
 * aunque el comprobante no sea tipo A.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileSpreadsheet, Truck } from 'lucide-react'

import { api } from '@/lib/api'
import { useCompany, useSuppliers } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { formatCurrency, formatDate } from '@/lib/format'
import { PERIOD_PRESETS, dayEnd, dayStart, firstOfMonthIso, toIso } from '@/lib/periodPresets'
import { exportComprasPorProveedorToExcel } from '@/lib/excelExport'
import {
  agruparPorProveedor,
  armarFilas,
  filtrarFilas,
  ordenarPorFecha,
  sumarFilas,
  type CompraProveedorFila,
  type GrupoProveedor,
} from '@/lib/comprasPorProveedor'
import { cn } from '@/lib/utils'
import { PurchaseDetailDialog } from '@/components/PurchaseDetailDialog'
import { SinPermiso } from '@/components/SinPermiso'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { VoucherType } from '@/types/api'

type Vista = 'proveedor' | 'fecha'

function EstadoBadge({ status }: { status: CompraProveedorFila['status'] }) {
  if (status === 'voided') return <Badge variant="destructive">Anulada</Badge>
  if (status === 'pending') return <Badge variant="outline">Pendiente</Badge>
  return <Badge variant="success">Registrada</Badge>
}

/** Número del comprobante del proveedor; si no se cargó, el interno (en gris). */
function NumeroCell({ fila }: { fila: CompraProveedorFila }) {
  if (fila.supplierInvoiceNumber) return <span className="tabular-nums">{fila.supplierInvoiceNumber}</span>
  return (
    <span className="text-muted-foreground tabular-nums" title="Sin número del proveedor; se muestra el número interno">
      Int. {fila.number}
    </span>
  )
}

export function ComprasPorProveedor() {
  const canView = usePermission('view_accounting')
  const canWrite = useCanWrite()
  const canVoid = usePermission('manage_purchases') && canWrite
  const companyQuery = useCompany()
  const suppliersQuery = useSuppliers()

  const [fromIso, setFromIso] = useState(() => firstOfMonthIso())
  const [toIsoVal, setToIsoVal] = useState(() => toIso(new Date()))
  const [applied, setApplied] = useState(() => ({
    from: dayStart(firstOfMonthIso()),
    to: dayEnd(toIso(new Date())),
  }))
  const [supplierId, setSupplierId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | VoucherType>('all')
  const [vista, setVista] = useState<Vista>('proveedor')
  const [incluirAnuladas, setIncluirAnuladas] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Misma raíz de clave que Historial de Compras ('purchasesHistory'): anular
  // desde el detalle invalida ese prefijo y esta pantalla se refresca sola.
  const purchasesQuery = useQuery({
    queryKey: ['purchasesHistory', applied.from, applied.to],
    queryFn: () => api.purchases.listByDateRange(applied.from, applied.to),
  })

  function calcular(): void {
    setApplied({ from: dayStart(fromIso), to: dayEnd(toIsoVal) })
  }
  function aplicarPreset(key: string): void {
    const preset = PERIOD_PRESETS.find((p) => p.key === key)
    if (!preset) return
    const range = preset.range()
    setFromIso(range.fromIso)
    setToIsoVal(range.toIso)
    setApplied({ from: dayStart(range.fromIso), to: dayEnd(range.toIso) })
  }

  const filas = useMemo(
    () =>
      filtrarFilas(armarFilas(purchasesQuery.data ?? [], suppliersQuery.data ?? []), {
        supplierId,
        type: typeFilter,
        incluirAnuladas,
      }),
    [purchasesQuery.data, suppliersQuery.data, supplierId, typeFilter, incluirAnuladas],
  )
  const grupos = useMemo(() => (vista === 'proveedor' ? agruparPorProveedor(filas) : []), [filas, vista])
  const planas = useMemo(() => (vista === 'fecha' ? ordenarPorFecha(filas) : []), [filas, vista])
  const totales = useMemo(() => sumarFilas(filas), [filas])
  const cantidadProveedores = useMemo(() => new Set(filas.map((r) => r.supplierId)).size, [filas])

  if (!canView) return <SinPermiso area="Facturas de compra" />

  const detalle = detailId ? filas.find((r) => r.purchaseId === detailId) : undefined

  function onExcel(): void {
    if (filas.length === 0) return
    // Mismo orden que la pantalla: agrupado (proveedor → fecha) o plano por fecha.
    const enOrden = vista === 'proveedor' ? grupos.flatMap((g) => g.filas) : planas
    exportComprasPorProveedorToExcel(enOrden, applied, companyQuery.data?.name ?? 'Empresa')
  }

  const columnas = vista === 'proveedor' ? 8 : 9

  function filaCompra(r: CompraProveedorFila, conProveedor: boolean) {
    const voided = r.status === 'voided'
    return (
      <TableRow
        key={r.purchaseId}
        className={cn('cursor-pointer', voided && 'line-through opacity-60')}
        onDoubleClick={() => setDetailId(r.purchaseId)}
      >
        <TableCell>{formatDate(r.date)}</TableCell>
        <TableCell><Badge variant="outline">{r.type}</Badge></TableCell>
        <TableCell><NumeroCell fila={r} /></TableCell>
        {conProveedor && <TableCell>{r.supplierName}</TableCell>}
        <TableCell className="text-right tabular-nums">{formatCurrency(r.net)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatCurrency(r.vat)}</TableCell>
        <TableCell className="text-right font-medium tabular-nums">{formatCurrency(r.total)}</TableCell>
        <TableCell><EstadoBadge status={r.status} /></TableCell>
        <TableCell className="text-right">
          <Button variant="ghost" size="sm" onClick={() => setDetailId(r.purchaseId)}>Ver</Button>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Truck className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Facturas de compra</h1>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-8">
            <div className="flex flex-col gap-1">
              <Label>Desde</Label>
              <Input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Hasta</Label>
              <Input type="date" value={toIsoVal} onChange={(e) => setToIsoVal(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1 md:col-span-2">
              <Label>Proveedor</Label>
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Todos</option>
                {(suppliersQuery.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Comprobante</Label>
              <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as 'all' | VoucherType)}>
                <option value="all">Todos</option>
                <option value="A">Factura A</option>
                <option value="B">Factura B</option>
                <option value="C">Factura C</option>
                <option value="X">Comprobante X</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Orden</Label>
              <Select value={vista} onChange={(e) => setVista(e.target.value as Vista)}>
                <option value="proveedor">Agrupar por proveedor</option>
                <option value="fecha">Sólo por fecha</option>
              </Select>
            </div>
            <Button onClick={calcular}>Calcular</Button>
            <Button variant="outline" onClick={onExcel} disabled={filas.length === 0}>
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Atajos:</span>
              {PERIOD_PRESETS.map((p) => (
                <Button key={p.key} variant="ghost" size="sm" onClick={() => aplicarPreset(p.key)}>
                  {p.label}
                </Button>
              ))}
            </div>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={incluirAnuladas}
                onChange={(e) => setIncluirAnuladas(e.target.checked)}
              />
              Incluir anuladas
            </label>
          </div>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Número</TableHead>
                  {vista === 'fecha' && <TableHead>Proveedor</TableHead>}
                  <TableHead className="text-right">Neto</TableHead>
                  <TableHead className="text-right">IVA</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchasesQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={columnas} className="py-10 text-center text-muted-foreground">Cargando…</TableCell>
                  </TableRow>
                ) : filas.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columnas} className="py-10 text-center text-muted-foreground">
                      Sin compras en el rango seleccionado.
                    </TableCell>
                  </TableRow>
                ) : vista === 'proveedor' ? (
                  grupos.map((g) => (
                    <GrupoRows key={g.supplierId} grupo={g} render={filaCompra} />
                  ))
                ) : (
                  planas.map((r) => filaCompra(r, true))
                )}
              </TableBody>
            </Table>
          </div>
          {filas.length > 0 && (
            <div className="grid shrink-0 grid-cols-5 gap-2 border-t bg-muted/30 px-3 py-2 text-sm">
              <div>
                <span className="text-muted-foreground">Comprobantes: </span>
                <span className="font-medium tabular-nums">{totales.cantidad}</span>
                {totales.anuladas > 0 && (
                  <span className="text-muted-foreground"> · Anuladas: <span className="tabular-nums">{totales.anuladas}</span></span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">Proveedores: </span>
                <span className="font-medium tabular-nums">{cantidadProveedores}</span>
              </div>
              <div className="text-right tabular-nums">Neto: <span className="font-semibold">{formatCurrency(totales.net)}</span></div>
              <div className="text-right tabular-nums">IVA: <span className="font-semibold">{formatCurrency(totales.vat)}</span></div>
              <div className="text-right tabular-nums">Total: <span className="font-semibold">{formatCurrency(totales.total)}</span></div>
            </div>
          )}
        </CardContent>
      </Card>

      {detailId && (
        <PurchaseDetailDialog
          purchaseId={detailId}
          supplierName={detalle ? `${detalle.supplierCode} — ${detalle.supplierName}` : '—'}
          canVoid={canVoid}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}

/** Encabezado del grupo (proveedor + subtotales alineados a las columnas) y sus compras. */
function GrupoRows({
  grupo,
  render,
}: {
  grupo: GrupoProveedor
  render: (r: CompraProveedorFila, conProveedor: boolean) => ReactNode
}) {
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={3} className="py-2">
          <span className="font-semibold">{grupo.supplierName}</span>
          <span className="ml-2 text-xs text-muted-foreground">
            {grupo.supplierCode}
            {grupo.supplierCuit ? ` · CUIT ${grupo.supplierCuit}` : ''}
          </span>
        </TableCell>
        <TableCell className="py-2 text-right font-semibold tabular-nums">{formatCurrency(grupo.net)}</TableCell>
        <TableCell className="py-2 text-right font-semibold tabular-nums">{formatCurrency(grupo.vat)}</TableCell>
        <TableCell className="py-2 text-right font-semibold tabular-nums">{formatCurrency(grupo.total)}</TableCell>
        <TableCell colSpan={2} className="py-2 text-xs text-muted-foreground">
          {grupo.cantidad} {grupo.cantidad === 1 ? 'comprobante' : 'comprobantes'}
          {grupo.anuladas > 0 ? ` · ${grupo.anuladas} ${grupo.anuladas === 1 ? 'anulada' : 'anuladas'}` : ''}
        </TableCell>
      </TableRow>
      {grupo.filas.map((r) => render(r, false))}
    </>
  )
}
