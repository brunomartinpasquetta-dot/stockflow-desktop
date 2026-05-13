import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useArticles, useSuppliers } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
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
import type { PurchaseDTO, VoucherType } from '@/types/api'

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

function PurchaseDetailDialog({
  purchaseId,
  supplierName,
  canVoid,
  onClose,
}: {
  purchaseId: string
  supplierName: string
  canVoid: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const detailQuery = useQuery({ queryKey: ['purchase', purchaseId], queryFn: () => api.purchases.get(purchaseId) })
  const articlesQuery = useArticles()
  const descById = useMemo(() => new Map((articlesQuery.data ?? []).map((a) => [a.id, a.description])), [articlesQuery.data])
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')

  const purchase = detailQuery.data?.purchase
  const voidMutation = useMutation({
    mutationFn: () => api.purchases.void(purchaseId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchasesHistory'] })
      void qc.invalidateQueries({ queryKey: ['purchase', purchaseId] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['supplierBalances'] })
      toast.success('Compra anulada')
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo anular la compra'),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {purchase
              ? `${VOUCHER_LABELS[purchase.type]} N° ${purchase.number}${purchase.supplierInvoiceNumber ? ` (prov. ${purchase.supplierInvoiceNumber})` : ''}`
              : 'Detalle de la compra'}
          </DialogTitle>
        </DialogHeader>
        {detailQuery.isLoading || !purchase ? (
          <div className="py-8 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-1 text-muted-foreground">
              <span>Fecha: {formatDateTime(purchase.date)}</span>
              <span>Proveedor: {supplierName}</span>
              <span>N° del proveedor: {purchase.supplierInvoiceNumber ?? '—'}</span>
              <span>Estado: {purchase.status === 'voided' ? 'Anulada' : 'Completada'}</span>
              <span>Modalidad: {purchase.paymentType === 'credit' ? 'Cuenta corriente del proveedor' : 'Contado'}</span>
              <span>Actualizó precios: {purchase.updatedPricesOnSave ? 'Sí' : 'No'}</span>
            </div>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Producto</TableHead>
                    <TableHead className="text-right">Cant.</TableHead>
                    <TableHead className="text-right">Costo unit.</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(detailQuery.data?.lines ?? []).map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>{descById.get(l.articleId) ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(l.costPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(l.lineTotal)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span className="tabular-nums">{formatCurrency(purchase.subtotal)}</span></div>
              {Number(purchase.discount) > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Descuento</span><span className="tabular-nums">-{formatCurrency(purchase.discount)}</span></div>}
              <div className="flex justify-between text-xs text-muted-foreground"><span>IVA</span><span className="tabular-nums">{formatCurrency(purchase.vatAmount)}</span></div>
              <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{formatCurrency(purchase.total)}</span></div>
            </div>
            {canVoid && purchase.status === 'completed' && !confirming && (
              <div className="flex justify-end">
                <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>Anular compra</Button>
              </div>
            )}
            {canVoid && purchase.status === 'completed' && confirming && (
              <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                <p className="text-xs text-destructive">Anular esta compra revierte stock y caja. Indicá el motivo:</p>
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

export function HistorialCompras() {
  const canVoid = usePermission('manage_purchases')
  const suppliersQuery = useSuppliers()

  const [fromIso, setFromIso] = useState(() => todayIso())
  const [toIso, setToIso] = useState(() => todayIso())
  const [supplierId, setSupplierId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | VoucherType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [searchNumber, setSearchNumber] = useState('')
  const [page, setPage] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)

  const purchasesQuery = useQuery({
    queryKey: ['purchasesHistory', fromIso, toIso],
    queryFn: () => api.purchases.listByDateRange(dayStart(fromIso), dayEnd(toIso)),
  })

  const supplierName = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of suppliersQuery.data ?? []) map.set(s.id, `${s.code} — ${s.name}`)
    return map
  }, [suppliersQuery.data])

  const filtered = useMemo(() => {
    const term = searchNumber.trim()
    let rows = (purchasesQuery.data ?? []) as PurchaseDTO[]
    if (supplierId) rows = rows.filter((p) => p.supplierId === supplierId)
    if (typeFilter !== 'all') rows = rows.filter((p) => p.type === typeFilter)
    if (statusFilter !== 'all') rows = rows.filter((p) => p.status === statusFilter)
    if (term) rows = rows.filter((p) => String(p.number).includes(term))
    return [...rows].sort((a, b) => b.date - a.date)
  }, [purchasesQuery.data, supplierId, typeFilter, statusFilter, searchNumber])

  const totalAmount = useMemo(
    () => filtered.filter((p) => p.status === 'completed').reduce((acc, p) => acc + Number(p.total), 0),
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
      <h1 className="text-lg font-semibold">Historial de Compras</h1>

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
            <Label>Proveedor</Label>
            <Select value={supplierId} onChange={(e) => resetPage(() => setSupplierId(e.target.value))}>
              <option value="">Todos</option>
              {(suppliersQuery.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
              ))}
            </Select>
          </div>
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
                <TableHead>Proveedor</TableHead>
                <TableHead>Pago</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchasesQuery.isLoading ? (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">Cargando…</TableCell></TableRow>
              ) : pageRows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No hay compras en el rango seleccionado.</TableCell></TableRow>
              ) : (
                pageRows.map((p) => {
                  const voided = p.status === 'voided'
                  return (
                    <TableRow
                      key={p.id}
                      className={cn('cursor-pointer', voided && 'line-through opacity-60')}
                      onDoubleClick={() => setDetailId(p.id)}
                    >
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(p.date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.number}</TableCell>
                      <TableCell><Badge variant="outline">{p.type}</Badge></TableCell>
                      <TableCell>{supplierName.get(p.supplierId) ?? '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{p.paymentType === 'credit' ? 'Cuenta cte.' : 'Contado'}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(p.total)}</TableCell>
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
        <span>{filtered.length} compra(s) — total completadas: <span className="font-medium tabular-nums text-foreground">{formatCurrency(parseCurrencyInput(String(totalAmount)))}</span></span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <span>Página {page + 1} / {pageCount}</span>
            <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
          </div>
        )}
      </div>

      {detailId && (
        <PurchaseDetailDialog
          purchaseId={detailId}
          supplierName={supplierName.get((purchasesQuery.data ?? []).find((p) => p.id === detailId)?.supplierId ?? '') ?? '—'}
          canVoid={canVoid}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
