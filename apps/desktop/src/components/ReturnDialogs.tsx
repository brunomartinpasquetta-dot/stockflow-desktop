/**
 * Diálogos de DEVOLUCIÓN (venta y compra), total o parcial por líneas.
 *
 * - Muestra qué se compró/vendió, cuánto ya se devolvió y deja elegir cantidad
 *   por línea. El reintegro puede ser en EFECTIVO (mueve caja) o como CRÉDITO
 *   en la cuenta corriente (baja el saldo pendiente del comprobante).
 * - El stock vuelve solo (venta) o baja solo (compra) — promos incluidas.
 * - Al confirmar imprime el comprobante de devolución en A4 (o "Guardar como
 *   PDF" desde el diálogo del sistema).
 */
import { createElement, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Undo2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useArticles, useCompany, useCurrentCash } from '@/lib/hooks'
import { formatCurrency, formatDate } from '@/lib/format'
import { printNode } from '@/lib/printService'
import { FormalDocA4, type FormalDocData } from '@/print/FormalDocA4'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'

interface LineState {
  lineId: string
  articleId: string
  description: string
  sold: number
  returned: number
  unitEff: number
  toReturn: string
}

function buildLineStates(
  lines: Array<{ id: string; articleId: string; quantity: string; lineTotal: string }>,
  returnedByLine: Map<string, number>,
  descByArticle: Map<string, string>,
): LineState[] {
  return lines.map((l) => {
    const sold = Number(l.quantity)
    const returned = returnedByLine.get(l.id) ?? 0
    return {
      lineId: l.id,
      articleId: l.articleId,
      description: descByArticle.get(l.articleId) ?? l.articleId,
      sold,
      returned,
      unitEff: sold > 0 ? Number(l.lineTotal) / sold : 0,
      toReturn: '0',
    }
  })
}

function ReturnTable({ lines, setLines }: { lines: LineState[]; setLines: (fn: (prev: LineState[]) => LineState[]) => void }) {
  return (
    <div className="max-h-[40vh] overflow-y-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted/60 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-left">Artículo</th>
            <th className="px-2 py-1.5 text-right">Cant.</th>
            <th className="px-2 py-1.5 text-right">Ya devuelto</th>
            <th className="w-24 px-2 py-1.5 text-center">Devolver</th>
            <th className="px-2 py-1.5 text-right">Reintegro</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, idx) => {
            const remaining = l.sold - l.returned
            const qty = Number(l.toReturn || '0')
            return (
              <tr key={l.lineId} className={`border-t ${remaining <= 0 ? 'opacity-50' : ''}`}>
                <td className="px-2 py-1.5">{l.description}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{l.sold}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{l.returned > 0 ? l.returned : '—'}</td>
                <td className="px-2 py-1">
                  <Input
                    className="h-7 text-center"
                    inputMode="decimal"
                    disabled={remaining <= 0}
                    value={l.toReturn}
                    onChange={(e) =>
                      setLines((prev) => prev.map((x, k) => (k === idx ? { ...x, toReturn: e.target.value } : x)))
                    }
                    title={remaining > 0 ? `Máximo: ${remaining}` : 'Ya se devolvió todo'}
                  />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{qty > 0 ? formatCurrency(qty * l.unitEff) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Devolución de VENTA                                                 */
/* ------------------------------------------------------------------ */

export function ReturnSaleDialog({
  saleId,
  open,
  onClose,
  onDone,
}: {
  saleId: string
  open: boolean
  onClose: () => void
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const companyQ = useCompany()
  const cashQ = useCurrentCash()
  const articlesQ = useArticles()
  const saleQ = useQuery({ queryKey: ['sale', saleId], queryFn: () => api.sales.get(saleId), enabled: open })
  const returnsQ = useQuery({ queryKey: ['returns', saleId], queryFn: () => api.returns.listBySale(saleId), enabled: open })

  const [lines, setLines] = useState<LineState[]>([])
  const [method, setMethod] = useState<'cash' | 'account'>('cash')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [seeded, setSeeded] = useState(false)

  const descByArticle = useMemo(
    () => new Map((articlesQ.data ?? []).map((a) => [a.id, a.description])),
    [articlesQ.data],
  )

  // sembrar líneas cuando llegan venta + devoluciones previas
  if (open && !seeded && saleQ.data && returnsQ.data && articlesQ.data) {
    const returnedByLine = new Map<string, number>()
    for (const r of returnsQ.data) {
      for (const rl of r.lines) {
        returnedByLine.set(rl.saleLineId, (returnedByLine.get(rl.saleLineId) ?? 0) + Number(rl.quantity))
      }
    }
    setLines(buildLineStates(saleQ.data.lines, returnedByLine, descByArticle))
    setMethod(saleQ.data.sale.isAccountSale ? 'account' : 'cash')
    setSeeded(true)
  }

  const total = lines.reduce((acc, l) => acc + Number(l.toReturn || '0') * l.unitEff, 0)
  const sale = saleQ.data?.sale
  const prevReturns = returnsQ.data ?? []

  async function confirm(): Promise<void> {
    const chosen = lines.filter((l) => Number(l.toReturn || '0') > 0)
    if (chosen.length === 0) {
      toast.error('Indicá qué cantidad devolver en al menos un artículo')
      return
    }
    const bad = chosen.find((l) => Number(l.toReturn) > l.sold - l.returned + 0.0005)
    if (bad) {
      toast.error(`"${bad.description}": el máximo a devolver es ${bad.sold - bad.returned}`)
      return
    }
    if (method === 'cash' && !cashQ.data) {
      toast.error('Para reintegrar en efectivo tiene que haber una caja abierta')
      return
    }
    setSaving(true)
    try {
      const result = await api.returns.createForSale({
        saleId,
        refundMethod: method,
        notes: notes.trim() || null,
        lines: chosen.map((l) => ({ saleLineId: l.lineId, quantity: Number(l.toReturn).toFixed(3) })),
      })
      toast.success(
        `Devolución DEV #${result.ret.number} registrada — ${method === 'cash' ? `reintegro en efectivo por ${formatCurrency(result.ret.total)}` : `crédito en cuenta por ${formatCurrency(result.ret.total)}`}`,
      )
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['customerBalances'] })
      void qc.invalidateQueries({ queryKey: ['returns', saleId] })
      // Comprobante A4 (o Guardar como PDF desde el diálogo).
      if (companyQ.data && sale) {
        const doc: FormalDocData = {
          company: companyQ.data,
          title: 'DEVOLUCIÓN',
          number: `DEV-${String(result.ret.number).padStart(4, '0')}`,
          meta: [
            { label: 'Fecha', value: formatDate(result.ret.date) },
            { label: 'Sobre', value: `Venta ${sale.type} #${sale.number}` },
            { label: 'Reintegro', value: method === 'cash' ? 'Efectivo' : 'Crédito en cuenta corriente' },
          ],
          customer: null,
          lines: chosen.map((l) => ({
            description: l.description,
            quantity: Number(l.toReturn).toString(),
            unitPrice: formatCurrency(l.unitEff),
            lineTotal: formatCurrency(Number(l.toReturn) * l.unitEff),
          })),
          totals: { subtotal: result.ret.total, total: result.ret.total },
          notes: notes.trim() || null,
          footerNote: 'Documento no fiscal — comprobante de devolución',
        }
        void printNode(createElement(FormalDocA4, { data: doc }), 'a4')
      }
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo registrar la devolución')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="h-5 w-5 text-primary" />
            Devolución {sale ? `— Venta ${sale.type} #${sale.number}` : ''}
          </DialogTitle>
        </DialogHeader>

        {saleQ.isLoading || returnsQ.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="flex flex-col gap-3">
            {prevReturns.length > 0 && (
              <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Esta venta ya tiene {prevReturns.length} devolución(es):{' '}
                {prevReturns.map((r) => `DEV #${r.ret.number} (${formatCurrency(r.ret.total)})`).join(', ')}
              </div>
            )}
            <ReturnTable lines={lines} setLines={setLines} />
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label>Reintegro</Label>
                <Select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'account')}>
                  <option value="cash">Efectivo (sale de la caja)</option>
                  <option value="account" disabled={!sale?.isAccountSale}>
                    Crédito en cuenta corriente{sale?.isAccountSale ? '' : ' (la venta no fue a cuenta)'}
                  </option>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Motivo / notas (opcional)</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej: producto fallado" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <span className="text-sm">Total a reintegrar</span>
              <b className="text-lg tabular-nums">{formatCurrency(total)}</b>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void confirm()} disabled={saving || total <= 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            Confirmar devolución
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Devolución de COMPRA (al proveedor)                                 */
/* ------------------------------------------------------------------ */

export function ReturnPurchaseDialog({
  purchaseId,
  open,
  onClose,
  onDone,
}: {
  purchaseId: string
  open: boolean
  onClose: () => void
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const cashQ = useCurrentCash()
  const articlesQ = useArticles()
  const purchaseQ = useQuery({ queryKey: ['purchase', purchaseId], queryFn: () => api.purchases.get(purchaseId), enabled: open })
  const returnsQ = useQuery({
    queryKey: ['purchaseReturns', purchaseId],
    queryFn: () => api.returns.listByPurchase(purchaseId),
    enabled: open,
  })

  const [lines, setLines] = useState<LineState[]>([])
  const [method, setMethod] = useState<'cash' | 'account'>('account')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [seeded, setSeeded] = useState(false)

  const descByArticle = useMemo(
    () => new Map((articlesQ.data ?? []).map((a) => [a.id, a.description])),
    [articlesQ.data],
  )

  if (open && !seeded && purchaseQ.data && returnsQ.data && articlesQ.data) {
    const returnedByLine = new Map<string, number>()
    for (const r of returnsQ.data) {
      for (const rl of r.lines) {
        returnedByLine.set(rl.purchaseLineId, (returnedByLine.get(rl.purchaseLineId) ?? 0) + Number(rl.quantity))
      }
    }
    setLines(buildLineStates(purchaseQ.data.lines, returnedByLine, descByArticle))
    setMethod(purchaseQ.data.purchase.paymentType === 'credit' ? 'account' : 'cash')
    setSeeded(true)
  }

  const total = lines.reduce((acc, l) => acc + Number(l.toReturn || '0') * l.unitEff, 0)
  const purchase = purchaseQ.data?.purchase
  const prevReturns = returnsQ.data ?? []

  async function confirm(): Promise<void> {
    const chosen = lines.filter((l) => Number(l.toReturn || '0') > 0)
    if (chosen.length === 0) {
      toast.error('Indicá qué cantidad devolver en al menos un artículo')
      return
    }
    if (method === 'cash' && !cashQ.data) {
      toast.error('Para recibir el reintegro en efectivo tiene que haber una caja abierta')
      return
    }
    setSaving(true)
    try {
      const result = await api.returns.createForPurchase({
        purchaseId,
        refundMethod: method,
        notes: notes.trim() || null,
        lines: chosen.map((l) => ({ purchaseLineId: l.lineId, quantity: Number(l.toReturn).toFixed(3) })),
      })
      toast.success(
        `Devolución al proveedor DPC #${result.ret.number} registrada por ${formatCurrency(result.ret.total)}`,
      )
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['supplierBalances'] })
      void qc.invalidateQueries({ queryKey: ['purchaseReturns', purchaseId] })
      onDone?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo registrar la devolución')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="h-5 w-5 text-primary" />
            Devolución al proveedor {purchase ? `— Compra ${purchase.type} #${purchase.number}` : ''}
          </DialogTitle>
        </DialogHeader>

        {purchaseQ.isLoading || returnsQ.isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>
        ) : (
          <div className="flex flex-col gap-3">
            {prevReturns.length > 0 && (
              <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Esta compra ya tiene {prevReturns.length} devolución(es):{' '}
                {prevReturns.map((r) => `DPC #${r.ret.number} (${formatCurrency(r.ret.total)})`).join(', ')}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              La mercadería devuelta BAJA del stock. El reintegro puede bajar la deuda con el proveedor o entrar en efectivo a la caja.
            </p>
            <ReturnTable lines={lines} setLines={setLines} />
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label>Reintegro</Label>
                <Select value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'account')}>
                  <option value="account" disabled={purchase?.paymentType !== 'credit'}>
                    Baja la deuda con el proveedor{purchase?.paymentType === 'credit' ? '' : ' (la compra fue de contado)'}
                  </option>
                  <option value="cash">Efectivo (entra a la caja)</option>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Motivo / notas (opcional)</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej: mercadería fallada" />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <span className="text-sm">Total del reintegro</span>
              <b className="text-lg tabular-nums">{formatCurrency(total)}</b>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void confirm()} disabled={saving || total <= 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            Confirmar devolución
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
