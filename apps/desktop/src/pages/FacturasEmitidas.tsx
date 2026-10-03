/**
 * P-CONTABLE: Facturas emitidas.
 * Todos los comprobantes de venta de un período (facturas A, B y C con CAE,
 * comprobantes X y notas de crédito/débito — no sólo los que van al Libro IVA),
 * agrupados por cliente y ordenados por fecha, con neto, IVA, total y estado.
 * Pedido del dueño: la misma vista que "Facturas de compra", del lado de Ventas.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileSpreadsheet, Receipt } from 'lucide-react'

import { api } from '@/lib/api'
import { useCompany, useCustomers } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { formatCurrency, formatDate } from '@/lib/format'
import { PERIOD_PRESETS, dayEnd, dayStart, toIso } from '@/lib/periodPresets'
import { exportFacturasEmitidasToExcel } from '@/lib/excelExport'
import {
  agruparPorCliente,
  armarFilas,
  etiquetaTipo,
  filtrarFilas,
  nombreCliente,
  ordenarPorFecha,
  sumarFilas,
  type FacturaEmitidaFila,
  type GrupoCliente,
} from '@/lib/facturasEmitidas'
import { cn } from '@/lib/utils'
import { SaleDetailDialog } from '@/components/SaleDetailDialog'
import { SinPermiso } from '@/components/SinPermiso'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { VoucherType } from '@/types/api'

type Vista = 'cliente' | 'fecha'

function firstOfMonthIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/** Las notas de crédito van en negativo: "-$1.000,00" en vez de "$-1.000,00". */
function importe(v: string): string {
  const n = Number(v)
  return n < 0 ? `-${formatCurrency(-n)}` : formatCurrency(v)
}

function EstadoBadge({ fila }: { fila: FacturaEmitidaFila }) {
  if (fila.status === 'voided') return <Badge variant="destructive">Anulada</Badge>
  if (fila.status === 'pending') {
    return (
      <span title={fila.sinCae ? 'Sin CAE de ARCA' : undefined}>
        <Badge variant="outline">Pendiente</Badge>
      </span>
    )
  }
  return <Badge variant="success">Registrada</Badge>
}

/** Número fiscal (punto de venta-número) si tiene CAE; si no, el interno. */
function NumeroCell({ fila }: { fila: FacturaEmitidaFila }) {
  if (fila.numeroFiscal) return <span className="tabular-nums">{fila.numeroFiscal}</span>
  if (fila.sinCae) {
    return (
      <span className="text-muted-foreground tabular-nums" title="Sin número fiscal (todavía no tiene CAE); se muestra el número interno">
        Int. {fila.number}
      </span>
    )
  }
  return <span className="tabular-nums">{fila.number}</span>
}

export function FacturasEmitidas() {
  const canView = usePermission('view_accounting')
  const canWrite = useCanWrite()
  const canVoid = usePermission('void_sale') && canWrite
  const companyQuery = useCompany()
  const customersQuery = useCustomers()

  const [fromIso, setFromIso] = useState(() => firstOfMonthIso())
  const [toIsoVal, setToIsoVal] = useState(() => toIso(new Date()))
  const [applied, setApplied] = useState(() => ({
    from: dayStart(firstOfMonthIso()),
    to: dayEnd(toIso(new Date())),
  }))
  const [customerId, setCustomerId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | VoucherType>('all')
  const [vista, setVista] = useState<Vista>('cliente')
  const [incluirAnuladas, setIncluirAnuladas] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Misma raíz de clave que Historial de Ventas ('salesHistory'): anular desde
  // el detalle invalida ese prefijo y esta pantalla se refresca sola. Fiscal:
  // por la fecha del comprobante, no por día de caja (igual que el Libro IVA).
  const salesQuery = useQuery({
    queryKey: ['salesHistory', applied.from, applied.to],
    queryFn: () => api.sales.listByDateRange(applied.from, applied.to),
  })
  // El comprobante lleva la fecha en que ARCA lo autorizó, que puede ser
  // posterior a la venta ("facturar después"): se piden hasta hoy para no
  // mostrar como pendiente una venta del período facturada días más tarde.
  const vouchersQuery = useQuery({
    queryKey: ['fiscal', 'vouchers', applied.from, applied.to],
    queryFn: () => api.fiscal.listVouchers({ from: applied.from, to: Math.max(applied.to, Date.now()) }),
  })
  const fiscalCfgQuery = useQuery({
    queryKey: ['fiscal', 'configPublic'],
    queryFn: () => api.fiscal.getConfigPublic(),
    staleTime: 60_000,
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

  const clientesOrdenados = useMemo(
    () =>
      (customersQuery.data ?? [])
        .map((c) => ({ id: c.id, nombre: nombreCliente(c) }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    [customersQuery.data],
  )

  const filas = useMemo(
    () =>
      filtrarFilas(
        armarFilas(salesQuery.data ?? [], vouchersQuery.data ?? [], customersQuery.data ?? [], {
          from: applied.from,
          to: applied.to,
          fiscalHabilitada: fiscalCfgQuery.data?.enabled === true,
        }),
        { customerId, type: typeFilter, incluirAnuladas },
      ),
    [salesQuery.data, vouchersQuery.data, customersQuery.data, fiscalCfgQuery.data, applied, customerId, typeFilter, incluirAnuladas],
  )
  const grupos = useMemo(() => (vista === 'cliente' ? agruparPorCliente(filas) : []), [filas, vista])
  const planas = useMemo(() => (vista === 'fecha' ? ordenarPorFecha(filas) : []), [filas, vista])
  const totales = useMemo(() => sumarFilas(filas), [filas])
  const cantidadClientes = useMemo(() => new Set(filas.map((r) => r.customerId)).size, [filas])

  if (!canView) return <SinPermiso area="Facturas emitidas" />

  const detalle = detailId ? filas.find((r) => r.saleId === detailId) : undefined
  const cargando = salesQuery.isLoading || vouchersQuery.isLoading

  function onExcel(): void {
    if (filas.length === 0) return
    // Mismo orden que la pantalla: agrupado (cliente → fecha) o plano por fecha.
    const enOrden = vista === 'cliente' ? grupos.flatMap((g) => g.filas) : planas
    exportFacturasEmitidasToExcel(enOrden, applied, companyQuery.data?.name ?? 'Empresa')
  }

  const columnas = vista === 'cliente' ? 8 : 9

  function filaFactura(r: FacturaEmitidaFila, conCliente: boolean) {
    const voided = r.status === 'voided'
    return (
      <TableRow
        key={r.id}
        className={cn(r.saleId && 'cursor-pointer', voided && 'line-through opacity-60')}
        onDoubleClick={() => { if (r.saleId) setDetailId(r.saleId) }}
      >
        <TableCell>{formatDate(r.date)}</TableCell>
        <TableCell><Badge variant="outline">{etiquetaTipo(r)}</Badge></TableCell>
        <TableCell><NumeroCell fila={r} /></TableCell>
        {conCliente && <TableCell>{r.customerName}</TableCell>}
        <TableCell className="text-right tabular-nums">{importe(r.net)}</TableCell>
        <TableCell className="text-right tabular-nums">{importe(r.vat)}</TableCell>
        <TableCell className="text-right font-medium tabular-nums">{importe(r.total)}</TableCell>
        <TableCell><EstadoBadge fila={r} /></TableCell>
        <TableCell className="text-right">
          {r.saleId && (
            <Button variant="ghost" size="sm" onClick={() => setDetailId(r.saleId)}>Ver</Button>
          )}
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Receipt className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Facturas emitidas</h1>
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
              <Label>Cliente</Label>
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Todos</option>
                {clientesOrdenados.map((c) => (
                  <option key={c.id} value={c.id}>{c.nombre}</option>
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
                <option value="cliente">Agrupar por cliente</option>
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
                  {vista === 'fecha' && <TableHead>Cliente</TableHead>}
                  <TableHead className="text-right">Neto</TableHead>
                  <TableHead className="text-right">IVA</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cargando ? (
                  <TableRow>
                    <TableCell colSpan={columnas} className="py-10 text-center text-muted-foreground">Cargando…</TableCell>
                  </TableRow>
                ) : filas.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columnas} className="py-10 text-center text-muted-foreground">
                      Sin comprobantes en el rango seleccionado.
                    </TableCell>
                  </TableRow>
                ) : vista === 'cliente' ? (
                  grupos.map((g) => (
                    <GrupoRows key={g.customerId} grupo={g} render={filaFactura} />
                  ))
                ) : (
                  planas.map((r) => filaFactura(r, true))
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
                <span className="text-muted-foreground">Clientes: </span>
                <span className="font-medium tabular-nums">{cantidadClientes}</span>
              </div>
              <div className="text-right tabular-nums">Neto: <span className="font-semibold">{importe(totales.net)}</span></div>
              <div className="text-right tabular-nums">IVA: <span className="font-semibold">{importe(totales.vat)}</span></div>
              <div className="text-right tabular-nums">Total: <span className="font-semibold">{importe(totales.total)}</span></div>
            </div>
          )}
        </CardContent>
      </Card>

      {detailId && (
        <SaleDetailDialog
          // Estado propio por venta: el documento tipeado para una no puede
          // quedar pegado a la siguiente.
          key={detailId}
          saleId={detailId}
          customerName={detalle?.customerName ?? '—'}
          canVoid={canVoid}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}

/** Encabezado del grupo (cliente + subtotales alineados a las columnas) y sus comprobantes. */
function GrupoRows({
  grupo,
  render,
}: {
  grupo: GrupoCliente
  render: (r: FacturaEmitidaFila, conCliente: boolean) => ReactNode
}) {
  return (
    <>
      <TableRow className="bg-muted/40 hover:bg-muted/40">
        <TableCell colSpan={3} className="py-2">
          <span className="font-semibold">{grupo.customerName}</span>
          {grupo.customerDoc && <span className="ml-2 text-xs text-muted-foreground">{grupo.customerDoc}</span>}
        </TableCell>
        <TableCell className="py-2 text-right font-semibold tabular-nums">{importe(grupo.net)}</TableCell>
        <TableCell className="py-2 text-right font-semibold tabular-nums">{importe(grupo.vat)}</TableCell>
        <TableCell className="py-2 text-right font-semibold tabular-nums">{importe(grupo.total)}</TableCell>
        <TableCell colSpan={2} className="py-2 text-xs text-muted-foreground">
          {grupo.cantidad} {grupo.cantidad === 1 ? 'comprobante' : 'comprobantes'}
          {grupo.anuladas > 0 ? ` · ${grupo.anuladas} ${grupo.anuladas === 1 ? 'anulada' : 'anuladas'}` : ''}
        </TableCell>
      </TableRow>
      {grupo.filas.map((r) => render(r, false))}
    </>
  )
}
