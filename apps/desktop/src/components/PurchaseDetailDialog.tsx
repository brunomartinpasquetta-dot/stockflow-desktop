/**
 * Detalle de una compra (renglones, totales, anular, devolución, PDF).
 * Lo usan Historial de Compras y Compras por proveedor (Contabilidad).
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Undo2, Loader2, FileDown, Printer } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useArticles, useCompany } from '@/lib/hooks'
import { formatCurrency, formatDateTime } from '@/lib/format'
import { ReturnPurchaseDialog } from '@/components/ReturnDialogs'
import { exportPurchasePdf, printPurchasePdf, type PurchaseDocData } from '@/lib/purchaseDoc'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { VoucherType } from '@/types/api'

const VOUCHER_LABELS: Record<VoucherType, string> = { A: 'Factura A', B: 'Factura B', C: 'Factura C', X: 'Comprobante X' }

export function PurchaseDetailDialog({
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
  const [returning, setReturning] = useState(false)
  const [reason, setReason] = useState('')

  const purchase = detailQuery.data?.purchase
  const companyQuery = useCompany()

  function docData(): PurchaseDocData | null {
    if (!purchase || !companyQuery.data) return null
    return {
      company: companyQuery.data,
      purchase,
      supplierName,
      lines: (detailQuery.data?.lines ?? []).map((l) => ({
        line: l,
        description: descById.get(l.articleId) ?? '—',
      })),
      voucherLabel: VOUCHER_LABELS[purchase.type],
    }
  }

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
      {/* max-h + scroll INTERNO: con una compra de muchos renglones el diálogo
          crecía más que la pantalla y los botones quedaban abajo, inalcanzables
          (reporte de Peverelli). El cuerpo scrollea; encabezado y botones, fijos. */}
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
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
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1 text-sm">
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
            {canVoid && purchase.status === 'completed' && (
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setReturning(true)}>
                  <Undo2 className="h-4 w-4" />
                  Devolución al proveedor
                </Button>
              </div>
            )}
            {returning && (
              <ReturnPurchaseDialog
                purchaseId={purchaseId}
                open={returning}
                onClose={() => setReturning(false)}
                onDone={() => {
                  void qc.invalidateQueries({ queryKey: ['purchasesHistory'] })
                  void qc.invalidateQueries({ queryKey: ['purchase', purchaseId] })
                }}
              />
            )}
            {canVoid && purchase.status === 'completed' && !confirming && (
              <div className="flex justify-end">
                <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>Anular compra</Button>
              </div>
            )}
            {canVoid && purchase.status === 'completed' && confirming && (
              <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                <p className="text-xs text-destructive">Anular esta compra revierte stock y caja. Indique el motivo:</p>
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
          <Button
            variant="outline"
            disabled={!purchase || !companyQuery.data}
            onClick={() => { const d = docData(); if (d) exportPurchasePdf(d) }}
            title="Descargar la compra como PDF"
          >
            <FileDown className="h-4 w-4" />
            Exportar PDF
          </Button>
          <Button
            variant="outline"
            disabled={!purchase || !companyQuery.data}
            onClick={() => { const d = docData(); if (d) printPurchasePdf(d) }}
            title="Imprimir la compra"
          >
            <Printer className="h-4 w-4" />
            Imprimir
          </Button>
          <Button variant="outline" onClick={onClose}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
