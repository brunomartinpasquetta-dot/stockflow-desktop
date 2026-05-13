import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useArticles, useCustomers, usePaymentMethods } from '@/lib/hooks'
import { useAuth, usePermission } from '@/contexts/AuthContext'
import { formatCurrency, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SaleDTO, VoucherType } from '@/types/api'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}
function dayEnd(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}
const VOUCHER_LABELS: Record<VoucherType, string> = { A: 'Factura A', B: 'Factura B', C: 'Factura C', X: 'Comprobante X' }
const PAGE_SIZE = 50

function SaleDetailDialog({
  saleId,
  customerName,
  canVoid,
  onClose,
}: {
  saleId: string
  customerName: string
  canVoid: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const detailQuery = useQuery({ queryKey: ['sale', saleId], queryFn: () => api.sales.get(saleId) })
  const articlesQuery = useArticles()
  const methodsQuery = usePaymentMethods()
  const descById = useMemo(() => new Map((articlesQuery.data ?? []).map((a) => [a.id, a.description])), [articlesQuery.data])
  const pmNameById = useMemo(() => new Map((methodsQuery.data ?? []).map((m) => [m.id, m.name])), [methodsQuery.data])
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')

  const sale = detailQuery.data?.sale
  const voidMutation = useMutation({
    mutationFn: () => api.sales.void(saleId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['salesHistory'] })
      void qc.invalidateQueries({ queryKey: ['sale', saleId] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['customerBalances'] })
      toast.success('Venta anulada')
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo anular la venta'),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {sale ? `${VOUCHER_LABELS[sale.type]} N° ${sale.number}` : 'Detalle de la venta'}
          </DialogTitle>
        </DialogHeader>
        {detailQuery.isLoading || !sale ? (
          <div className="py-8 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-1 text-muted-foreground">
              <span>Fecha: {formatDateTime(sale.date)}</span>
              <span>Cliente: {customerName}</span>
              <span>Estado: {sale.status === 'voided' ? 'Anulada' : 'Completada'}</span>
              <span>Modalidad: {sale.isAccountSale ? 'Cuenta corriente' : 'Contado'}</span>
            </div>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Producto</TableHead>
                    <TableHead className="text-right">Cant.</TableHead>
                    <TableHead className="text-right">P. unit.</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(detailQuery.data?.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{descById.get(l.articleId) ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(l.unitPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(l.lineTotal)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{formatCurrency(sale.subtotal)}</span></div>
              {Number(sale.discount) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Descuento</span><span className="tabular-nums">-{formatCurrency(sale.discount)}</span></div>}
              <div className="flex justify-between text-xs text-muted-foreground"><span>IVA</span><span className="tabular-nums">{formatCurrency(sale.vatAmount)}</span></div>
              <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{formatCurrency(sale.total)}</span></div>
            </div>
            <div className="text-xs">
              <span className="font-medium text-muted-foreground">Pagos: </span>
              {sale.isAccountSale
                ? 'Cuenta corriente'
                : (detailQuery.data?.payments ?? []).map((p) => `${pmNameById.get(p.paymentMethodId) ?? p.paymentMethodId} ${formatCurrency(p.amount)}`).join(' · ') || '—'}
            </div>
            {canVoid && sale.status === 'completed' && !confirming && (
              <div className="flex justify-end">
                <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>Anular venta</Button>
              </div>
            )}
            {canVoid && sale.status === 'completed' && confirming && (
              <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                <p className="text-xs text-destructive">Anular esta venta revierte stock y caja. Indicá el motivo:</p>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Motivo de la anulación"
                  className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => { setConfirming(false); setReason('') }} disabled={voidMutation.isPending}>Cancelar</Button>
                  <Button variant="destructive" size="sm" disabled={reason.trim().length < 3 || voidMutation.isPending} onClick={() => voidMutation.mutate()}>
                    {voidMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    Confirmar anulación
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function HistorialVentas() {
  const { currentUser } = useAuth()
  const isAdmin = currentUser?.role === 'admin'
  const canVoid = usePermission('void_sale')
  const customersQuery = useCustomers()
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: api.users.list, enabled: isAdmin })

  const [fromIso, setFromIso] = useState(() => todayIso())
  const [toIso, setToIso] = useState(() => todayIso())
  const [customerId, setCustomerId] = useState('')
  const [sellerId, setSellerId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | VoucherType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [searchNumber, setSearchNumber] = useState('')
  const [page, setPage] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)

  const salesQuery = useQuery({
    queryKey: ['salesHistory', fromIso, toIso],
    queryFn: () => api.sales.listByDateRange(dayStart(fromIso), dayEnd(toIso)),
  })

  const customerName = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of customersQuery.data ?? []) map.set(c.id, c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName)
    return map
  }, [customersQuery.data])
  const sellerName = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of usersQuery.data ?? []) map.set(u.id, u.fullName)
    return map
  }, [usersQuery.data])

  const filtered = useMemo(() => {
    const term = searchNumber.trim()
    let rows = (salesQuery.data ?? []) as SaleDTO[]
    if (customerId) rows = rows.filter((s) => s.customerId === customerId)
    if (sellerId) rows = rows.filter((s) => s.sellerId === sellerId)
    if (typeFilter !== 'all') rows = rows.filter((s) => s.type === typeFilter)
    if (statusFilter !== 'all') rows = rows.filter((s) => s.status === statusFilter)
    if (term) rows = rows.filter((s) => String(s.number).includes(term))
    return [...rows].sort((a, b) => b.date - a.date)
  }, [salesQuery.data, customerId, sellerId, typeFilter, statusFilter, searchNumber])

  const totalAmount = useMemo(
    () => filtered.filter((s) => s.status === 'completed').reduce((acc, s) => acc + Number(s.total), 0),
    [filtered],
  )
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  function resetPage(fn: () => void): void {
    fn()
    setPage(0)
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Historial de Ventas</h1>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 pt-4 md:grid-cols-6">
          <div className="flex flex-col gap-1">
            <Label>Desde</Label>
            <Input type="date" value={fromIso} onChange={(e) => resetPage(() => setFromIso(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Hasta</Label>
            <Input type="date" value={toIso} onChange={(e) => resetPage(() => setToIso(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Cliente</Label>
            <Select value={customerId} onChange={(e) => resetPage(() => setCustomerId(e.target.value))}>
              <option value="">Todos</option>
              {(customersQuery.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName}</option>
              ))}
            </Select>
          </div>
          {isAdmin && (
            <div className="flex flex-col gap-1">
              <Label>Vendedor</Label>
              <Select value={sellerId} onChange={(e) => resetPage(() => setSellerId(e.target.value))}>
                <option value="">Todos</option>
                {(usersQuery.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label>Comprobante</Label>
            <Select value={typeFilter} onChange={(e) => resetPage(() => setTypeFilter(e.target.value as 'all' | VoucherType))}>
              <option value="all">Todos</option>
              <option value="A">Factura A</option>
              <option value="B">Factura B</option>
              <option value="C">Factura C</option>
              <option value="X">Comprobante X</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Estado</Label>
            <Select value={statusFilter} onChange={(e) => resetPage(() => setStatusFilter(e.target.value as 'all' | 'completed' | 'voided'))}>
              <option value="all">Todos</option>
              <option value="completed">Completadas</option>
              <option value="voided">Anuladas</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Buscar N°</Label>
            <Input value={searchNumber} onChange={(e) => resetPage(() => setSearchNumber(e.target.value))} placeholder="N° de comprobante" inputMode="numeric" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">N°</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Vendedor</TableHead>
                <TableHead>Pago</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {salesQuery.isLoading ? (
                <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">Cargando…</TableCell></TableRow>
              ) : pageRows.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">No hay ventas en el rango seleccionado.</TableCell></TableRow>
              ) : (
                pageRows.map((s) => {
                  const voided = s.status === 'voided'
                  return (
                    <TableRow
                      key={s.id}
                      className={cn('cursor-pointer', voided && 'line-through opacity-60')}
                      onDoubleClick={() => setDetailId(s.id)}
                    >
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.number}</TableCell>
                      <TableCell><Badge variant="outline">{s.type}</Badge></TableCell>
                      <TableCell>{customerName.get(s.customerId) ?? '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{sellerName.get(s.sellerId) ?? (isAdmin ? '—' : '')}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{s.isAccountSale ? 'Cuenta cte.' : 'Contado'}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(s.total)}</TableCell>
                      <TableCell>
                        {voided ? <Badge variant="destructive">Anulada</Badge> : <Badge variant="success">Completada</Badge>}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{filtered.length} venta(s) — total completadas: <span className="font-medium tabular-nums text-foreground">{formatCurrency(parseCurrencyInput(String(totalAmount)))}</span></span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <span>Página {page + 1} / {pageCount}</span>
            <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
          </div>
        )}
      </div>

      {detailId && (
        <SaleDetailDialog
          saleId={detailId}
          customerName={customerName.get((salesQuery.data ?? []).find((s) => s.id === detailId)?.customerId ?? '') ?? '—'}
          canVoid={canVoid}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
