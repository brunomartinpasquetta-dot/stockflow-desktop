import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Printer, History } from 'lucide-react'

import { api } from '@/lib/api'
import { useHistoricalCashRegisters, useHistoricalCashReport, useCompany, useUsers } from '@/lib/hooks'
import { useAuth, usePermission } from '@/contexts/AuthContext'
import { usePrintHistoricalCashReport, usePrintCashCloseReport } from '@/lib/usePrint'
import { formatCurrency, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { HistoricalCashRegisterDTO, HistoricalCashMovementDTO } from '@/types/api'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}
function dayEnd(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

function StatusBadge({ r }: { r: HistoricalCashRegisterDTO }) {
  if (r.status === 'open') return <Badge variant="outline" className="bg-blue-100 text-blue-700">ABIERTA</Badge>
  const diff = Number(r.difference ?? '0')
  if (diff > 0.005) return <Badge variant="outline" className="bg-amber-100 text-amber-800">Sobrante {formatCurrency(diff)}</Badge>
  if (diff < -0.005) return <Badge variant="destructive">Faltante {formatCurrency(Math.abs(diff))}</Badge>
  return <Badge variant="success">Cerrada</Badge>
}

function movementKindLabel(m: HistoricalCashMovementDTO): string {
  if (m.relatedSaleId) {
    const n = m.saleNumber != null ? ` N° ${m.saleNumber}` : ''
    return m.type === 'income' ? `Venta${n}` : `Anulación venta${n}`
  }
  if (m.relatedPurchaseId) {
    const n = m.purchaseNumber != null ? ` N° ${m.purchaseNumber}` : ''
    return `Compra${n}`
  }
  if (m.description.toLowerCase().startsWith('cobranza')) return 'Cobro'
  return m.type === 'income' ? 'Ingreso' : 'Egreso'
}

function HistoricalCashReportDialog({
  cashRegisterId,
  closedByName,
  onClose,
}: {
  cashRegisterId: string
  closedByName: string
  onClose: () => void
}) {
  const reportQuery = useHistoricalCashReport(cashRegisterId)
  const companyQuery = useCompany()
  const printCashClose = usePrintCashCloseReport()
  const printerConfigQuery = useQuery({
    queryKey: ['hardwarePrinterConfig'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })

  const r = reportQuery.data

  async function handlePrint(): Promise<void> {
    if (!r || !companyQuery.data) return
    const printerCfg = printerConfigQuery.data ?? null
    if (printerCfg) {
      try {
        const breakdownArr = r.byPaymentMethod ?? []
        await api.hardware.printer.printCashClose({
          company: { name: companyQuery.data.name },
          registerNumber: r.register.number,
          openDate: r.register.openDate,
          closeDate: r.register.closeDate ?? Date.now(),
          openingAmount: r.openingAmount,
          salesCount: r.salesCount,
          salesTotal: r.salesTotal,
          paymentBreakdown: breakdownArr.map((b) => ({ method: b.name, amount: b.net })),
          incomeMovements: r.incomeTotal,
          expenseMovements: r.expenseTotal,
          expectedClosing: r.expectedCash,
          declaredClosing: r.closingAmount ?? '0',
          difference: r.difference ?? '0',
        })
        return
      } catch {
        toast.warning('Impresora térmica no disponible — usando impresión desde pantalla')
      }
    }
    printCashClose({ company: companyQuery.data, report: r, closedBy: closedByName })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {r ? `Caja #${r.register.number} — ${formatDateTime(r.register.openDate)}` : 'Detalle de caja'}
          </DialogTitle>
        </DialogHeader>
        {reportQuery.isLoading || !r ? (
          <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 md:grid-cols-3">
              <div><span className="text-muted-foreground">Apertura: </span>{formatDateTime(r.register.openDate)}</div>
              <div><span className="text-muted-foreground">Cierre: </span>{r.register.closeDate ? formatDateTime(r.register.closeDate) : '—'}</div>
              <div><span className="text-muted-foreground">Cajero: </span>{closedByName}</div>
              <div><span className="text-muted-foreground">Apertura: </span><span className="tabular-nums">{formatCurrency(r.openingAmount)}</span></div>
              <div><span className="text-muted-foreground">Ingresos: </span><span className="tabular-nums">{formatCurrency(r.incomeTotal)}</span></div>
              <div><span className="text-muted-foreground">Egresos: </span><span className="tabular-nums">{formatCurrency(r.expenseTotal)}</span></div>
              <div><span className="text-muted-foreground">Esperado: </span><span className="tabular-nums">{formatCurrency(r.expectedCash)}</span></div>
              <div><span className="text-muted-foreground">Declarado: </span><span className="tabular-nums">{r.closingAmount ? formatCurrency(r.closingAmount) : '—'}</span></div>
              <div><span className="text-muted-foreground">Diferencia: </span><span className="tabular-nums">{r.difference ? formatCurrency(r.difference) : '—'}</span></div>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Desglose por medio de pago</h3>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Medio</TableHead>
                      <TableHead className="text-right">Ingresos</TableHead>
                      <TableHead className="text-right">Egresos</TableHead>
                      <TableHead className="text-right">Neto</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.byPaymentMethod.length === 0 ? (
                      <TableRow><TableCell colSpan={4} className="py-3 text-center text-muted-foreground">Sin movimientos</TableCell></TableRow>
                    ) : r.byPaymentMethod.map((b) => (
                      <TableRow key={b.paymentMethodId ?? '__none__'}>
                        <TableCell>{b.name}{b.isPhysicalCash ? ' (efectivo)' : ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(b.incomeTotal)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(b.expenseTotal)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{formatCurrency(b.net)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Movimientos ({r.movementsDetail.length})</h3>
              <div className="max-h-60 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Hora</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Concepto</TableHead>
                      <TableHead>Medio</TableHead>
                      <TableHead className="text-right">Ingreso</TableHead>
                      <TableHead className="text-right">Egreso</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.movementsDetail.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="py-4 text-center text-muted-foreground">Sin movimientos</TableCell></TableRow>
                    ) : r.movementsDetail.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(m.date)}</TableCell>
                        <TableCell className="text-xs">{movementKindLabel(m)}</TableCell>
                        <TableCell className="text-xs">{m.description}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{m.paymentMethodName ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.type === 'income' ? formatCurrency(m.amount) : ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.type === 'expense' ? formatCurrency(m.amount) : ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cerrar</Button>
          <Button onClick={() => void handlePrint()} disabled={!r}>
            <Printer className="h-4 w-4" />
            Imprimir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function HistorialCajas() {
  const { currentUser } = useAuth()
  const canView = usePermission('view_reports')
  const isAdmin = currentUser?.role === 'admin'

  const [fromIso, setFromIso] = useState(() => isoDaysAgo(30))
  const [toIso, setToIso] = useState(() => todayIso())
  const [userId, setUserId] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [appliedRange, setAppliedRange] = useState({
    from: dayStart(isoDaysAgo(30)),
    to: dayEnd(todayIso()),
    userId: '' as string | undefined,
  })

  const usersQuery = useUsers()
  const companyQuery = useCompany()
  const listQuery = useHistoricalCashRegisters({
    from: appliedRange.from,
    to: appliedRange.to,
    userId: appliedRange.userId || undefined,
  })
  const reportQuery = useHistoricalCashReport(selectedId ?? undefined)
  const printRange = usePrintHistoricalCashReport()

  const userNameById = useMemo(
    () => new Map((usersQuery.data ?? []).map((u) => [u.id, u.fullName])),
    [usersQuery.data],
  )

  const totals = useMemo(() => {
    const list = listQuery.data ?? []
    const income = list.reduce((a, r) => a + Number(r.totalIncome), 0)
    const expense = list.reduce((a, r) => a + Number(r.totalExpense), 0)
    return { income, expense, net: income - expense }
  }, [listQuery.data])

  function calcular(): void {
    setAppliedRange({ from: dayStart(fromIso), to: dayEnd(toIso), userId: userId || undefined })
    setSelectedId(null)
  }

  function imprimirRango(): void {
    if (!companyQuery.data) return
    printRange({
      company: companyQuery.data,
      from: appliedRange.from,
      to: appliedRange.to,
      userName: appliedRange.userId ? userNameById.get(appliedRange.userId) : undefined,
      registers: listQuery.data ?? [],
    })
  }

  if (!canView) return <Navigate to="/" replace />

  const list = listQuery.data ?? []
  const selected = list.find((r) => r.id === selectedId) ?? null

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <History className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Historial de cajas</h1>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 items-end gap-3 pt-4 md:grid-cols-5">
          <div className="flex flex-col gap-1">
            <Label>Desde</Label>
            <Input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Hasta</Label>
            <Input type="date" value={toIso} onChange={(e) => setToIso(e.target.value)} />
          </div>
          {isAdmin && (
            <div className="flex flex-col gap-1">
              <Label>Cajero</Label>
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Todos</option>
                {(usersQuery.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </Select>
            </div>
          )}
          <Button onClick={calcular}>Calcular</Button>
          <Button variant="outline" onClick={imprimirRango} disabled={list.length === 0}>
            <Printer className="h-4 w-4" />
            Imprimir rango
          </Button>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha apertura</TableHead>
                  <TableHead>Cajero</TableHead>
                  <TableHead className="text-right">Apertura</TableHead>
                  <TableHead className="text-right">Ingresos</TableHead>
                  <TableHead className="text-right">Egresos</TableHead>
                  <TableHead className="text-right">Esperado</TableHead>
                  <TableHead className="text-right">Cierre</TableHead>
                  <TableHead className="text-right">Diferencia</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQuery.isLoading ? (
                  <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">Cargando…</TableCell></TableRow>
                ) : list.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="py-10 text-center text-muted-foreground">No hay cajas en el rango seleccionado.</TableCell></TableRow>
                ) : (
                  list.map((r) => (
                    <TableRow
                      key={r.id}
                      className={cn('cursor-pointer', selectedId === r.id && 'bg-primary/10')}
                      onClick={() => setSelectedId(r.id)}
                      onDoubleClick={() => setDetailId(r.id)}
                    >
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.openDate)}</TableCell>
                      <TableCell className="text-xs">{r.userName}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.openingAmount)}</TableCell>
                      <TableCell className="text-right tabular-nums text-success">{formatCurrency(r.totalIncome)}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">{formatCurrency(r.totalExpense)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.expectedAmount ? formatCurrency(r.expectedAmount) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.closingAmount ? formatCurrency(r.closingAmount) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.difference ? formatCurrency(r.difference) : '—'}</TableCell>
                      <TableCell><StatusBadge r={r} /></TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{list.length} caja(s)</span>
            <span className="tabular-nums">
              Ingresos: <span className="font-medium text-success">{formatCurrency(totals.income)}</span>
              {' · '}Egresos: <span className="font-medium text-destructive">{formatCurrency(totals.expense)}</span>
              {' · '}Saldo neto: <span className="font-semibold">{formatCurrency(totals.net)}</span>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="flex shrink-0 items-center justify-between border-b bg-muted/20 px-3 py-2 text-sm">
            <span className="font-medium">
              {selected
                ? `Detalle — Caja #${selected.number} (${selected.userName})`
                : 'Detalle de movimientos'}
            </span>
            {selected && (
              <Button variant="outline" size="sm" onClick={() => setDetailId(selected.id)}>
                Ver reporte completo
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!selected ? (
              <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                Seleccioná una caja para ver el detalle.
              </div>
            ) : reportQuery.isLoading || !reportQuery.data ? (
              <div className="flex h-full items-center justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hora</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Concepto</TableHead>
                    <TableHead>Medio de pago</TableHead>
                    <TableHead className="text-right">Ingreso</TableHead>
                    <TableHead className="text-right">Egreso</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reportQuery.data.movementsDetail.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">Sin movimientos.</TableCell></TableRow>
                  ) : reportQuery.data.movementsDetail.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(m.date)}</TableCell>
                      <TableCell className="text-xs">{movementKindLabel(m)}</TableCell>
                      <TableCell className="text-xs">{m.description}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{m.paymentMethodName ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-success">{m.type === 'income' ? formatCurrency(m.amount) : ''}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">{m.type === 'expense' ? formatCurrency(m.amount) : ''}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {detailId && (
        <HistoricalCashReportDialog
          cashRegisterId={detailId}
          closedByName={list.find((r) => r.id === detailId)?.userName ?? '—'}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
