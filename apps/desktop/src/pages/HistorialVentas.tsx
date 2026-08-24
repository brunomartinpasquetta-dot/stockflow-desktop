import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Undo2, Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useCompany, useCustomers, usePaymentMethods } from '@/lib/hooks'
import { useAuth, usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { formatCurrency, formatDate, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { ReturnSaleDialog } from '@/components/ReturnDialogs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SaleDTO, VoucherType } from '@/types/api'
import type { SaleTicketData } from '@/print/SaleTicket'
import { VAT_CONDITION_LABELS } from '@/lib/fiscalDoc'
import { printSaleTicketSilent } from '@/lib/printSaleTicket'

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
const VOUCHER_LABELS: Record<VoucherType, string> = { A: 'Factura A', B: 'Factura B', C: 'Factura C', X: 'Remito X' }
const PAGE_SIZE = 50

/**
 * ANULAR TODAS LAS VENTAS DE HOY.
 *
 * Existe para la puesta en marcha de un local: se hacen decenas de ventas de
 * prueba con las terminales y anularlas una por una es media hora de clicks.
 *
 * Es la acción más destructiva de la pantalla, así que:
 *  - muestra ANTES qué va a tocar (cuántas ventas, cuánta plata, cuántas con CAE),
 *  - obliga a escribir ANULAR (no alcanza con un botón: se aprieta sin leer),
 *  - avisa aparte de las que tienen CAE, porque anularlas acá NO las da de baja
 *    en ARCA —eso se hace con una nota de crédito— y esa confusión sale cara.
 *
 * No borra nada: cada venta se anula como si se anulara a mano, revirtiendo
 * stock y caja, y queda en el historial marcada como anulada.
 */
function AnularVentasDeHoyDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [confirmacion, setConfirmacion] = useState('')

  const hoy = todayIso()
  const ventasDeHoyQuery = useQuery({
    queryKey: ['salesHistory', hoy, hoy],
    queryFn: () => api.sales.listByDateRange(dayStart(hoy), dayEnd(hoy)),
  })

  const aAnular = useMemo(
    () => (ventasDeHoyQuery.data ?? []).filter((s) => s.status !== 'voided'),
    [ventasDeHoyQuery.data],
  )
  const totalAAnular = aAnular.reduce((acc, s) => acc + Number(s.total), 0)
  const conCAE = aAnular.filter((s) => s.afipCAE).length

  const anularMut = useMutation({
    mutationFn: () => api.sales.voidRange(dayStart(hoy), dayEnd(hoy)),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['salesHistory'] })
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['accounts'] })
      if (r.omitidas.length > 0) {
        toast.warning(
          `Se anularon ${r.anuladas} venta(s). No se pudieron anular ${r.omitidas.length}: ` +
            r.omitidas.map((o) => `N° ${o.number} (${o.motivo})`).join(' · '),
          { duration: 15000 },
        )
      } else {
        toast.success(`Se anularon ${r.anuladas} venta(s) de hoy`)
      }
      if (r.conCAE > 0) {
        toast.warning(
          `${r.conCAE} de esas ventas tenían CAE. En ARCA siguen emitidas: para darlas de baja hay que hacer una nota de crédito.`,
          { duration: 20000 },
        )
      }
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudieron anular'),
  })

  const puedeConfirmar = confirmacion.trim().toUpperCase() === 'ANULAR' && aAnular.length > 0

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-destructive">Anular todas las ventas de hoy</DialogTitle>
        </DialogHeader>

        {ventasDeHoyQuery.isPending ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando las ventas de hoy…
          </div>
        ) : aAnular.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Hoy no hay ventas para anular.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              Se van a anular <strong>{aAnular.length} venta(s)</strong> de hoy, por un total de{' '}
              <strong>{formatCurrency(String(totalAAnular))}</strong>.
              <br />
              Se devuelve el stock y se revierten los movimientos de caja. Quedan en el historial
              como anuladas.
            </div>

            {conCAE > 0 && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                <strong>{conCAE} tienen CAE de ARCA.</strong> Anularlas acá no las da de baja en
                ARCA: siguen emitidas y hay que hacerles una <strong>nota de crédito</strong>.
              </div>
            )}

            <div className="flex flex-col gap-1">
              <Label>Para confirmar, escribí ANULAR</Label>
              <Input
                value={confirmacion}
                onChange={(e) => setConfirmacion(e.target.value)}
                placeholder="ANULAR"
                autoFocus
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!puedeConfirmar || anularMut.isPending}
            onClick={() => anularMut.mutate()}
          >
            {anularMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Anular {aAnular.length > 0 ? `${aAnular.length} venta(s)` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
  // NO se baja el catálogo: la descripción de cada artículo ya viene con la
  // línea de la venta. Antes, abrir una venta para ver tres renglones bajaba
  // los 12.413 artículos —6,6 MB por red a una terminal Windows 7—, y eso era
  // lo que se sentía como "el sistema anda lento".
  const methodsQuery = usePaymentMethods()
  const companyQuery = useCompany()
  const printerCfgQuery = useQuery({
    queryKey: ['hardwarePrinterConfig'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })
  const descById = useMemo(
    () =>
      new Map(
        (detailQuery.data?.lines ?? [])
          .filter((l): l is typeof l & { articleId: string } => l.articleId != null)
          .map((l) => [l.articleId, l.articleDescription ?? '—']),
      ),
    [detailQuery.data],
  )
  const pmNameById = useMemo(() => new Map((methodsQuery.data ?? []).map((m) => [m.id, m.name])), [methodsQuery.data])
  // La condición del cliente frente al IVA va impresa en el comprobante, así
  // que la reimpresión tiene que resolverla igual que la venta original: si no,
  // el papel reimpreso dice "Consumidor Final" en la factura de un RI.
  const customersQuery = useCustomers()
  const [confirming, setConfirming] = useState(false)
  const [returning, setReturning] = useState(false)
  const [reason, setReason] = useState('')

  // Estado fiscal de la venta: si ya tiene comprobante con CAE, o si se puede
  // emitir/reintentar (cuando ARCA falló o la venta se hizo sin facturar).
  const voucherQuery = useQuery({
    queryKey: ['fiscal', 'voucher', saleId],
    queryFn: () => api.fiscal.getVoucherForSale(saleId),
  })
  const fiscalCfgQuery = useQuery({
    queryKey: ['fiscal', 'configPublic'],
    queryFn: () => api.fiscal.getConfigPublic(),
    staleTime: 60_000,
  })
  const salePointsQuery = useQuery({
    queryKey: ['fiscal', 'salePoints'],
    queryFn: () => api.fiscal.listSalePoints(),
    staleTime: 60_000,
  })
  const [issuePoint, setIssuePoint] = useState<number | null>(null)
  const activePoints = useMemo(
    () => (salePointsQuery.data ?? []).filter((p) => p.active),
    [salePointsQuery.data],
  )
  // Impresión del comprobante fiscal (A4 con CAE y QR de ARCA).
  const [printingFiscal, setPrintingFiscal] = useState(false)
  async function printFiscal(): Promise<void> {
    const v = voucherQuery.data
    const company = companyQuery.data
    if (!v || !company) return
    setPrintingFiscal(true)
    try {
      const [{ buildFiscalDoc }, { printNode }, { FormalDocA4 }, { createElement }] =
        await Promise.all([
          import('@/lib/fiscalDoc'),
          import('@/lib/printService'),
          import('@/print/FormalDocA4'),
          import('react'),
        ])
      const d = detailQuery.data
      const doc = await buildFiscalDoc({
        company,
        voucher: v,
        sale: d?.sale ?? null,
        lines: d?.lines,
        descriptionById: descById,
        paymentNote: d?.sale.isAccountSale ? 'Cuenta corriente' : null,
      })
      printNode(createElement(FormalDocA4, { data: doc }), 'a4')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo imprimir el comprobante')
    } finally {
      setPrintingFiscal(false)
    }
  }

  // Notas de crédito/débito sobre un comprobante ya autorizado.
  const [noteKind, setNoteKind] = useState<'credit_note' | 'debit_note' | null>(null)
  const [noteAmount, setNoteAmount] = useState('')
  const noteMutation = useMutation({
    mutationFn: () =>
      api.fiscal.issueNote({
        relatedVoucherId: voucherQuery.data!.id,
        kind: noteKind!,
        total: noteAmount.trim() ? parseCurrencyInput(noteAmount) : undefined,
      }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['fiscal'] })
      setNoteKind(null)
      setNoteAmount('')
      toast.success(
        `${v.label} ${String(v.salePoint).padStart(5, '0')}-${String(v.number).padStart(8, '0')} — CAE ${v.cae}`,
        { duration: 10_000 },
      )
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'ARCA no autorizó la nota', {
        duration: 12_000,
      }),
  })

  const issueMutation = useMutation({
    mutationFn: (letter: 'A' | 'B' | 'C') =>
      api.fiscal.issueInvoice({
        saleId,
        salePoint: issuePoint ?? activePoints[0]?.number ?? 1,
        letter,
      }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['fiscal', 'voucher', saleId] })
      toast.success(
        `${v.label} ${String(v.salePoint).padStart(5, '0')}-${String(v.number).padStart(8, '0')} — CAE ${v.cae}`,
        { duration: 10_000 },
      )
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'ARCA no autorizó el comprobante', {
        duration: 12_000,
      }),
  })

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

  /** El QR de ARCA como imagen; se dibuja localmente. */
  async function qrComoImagen(url: string): Promise<string | null> {
    try {
      const QR = await import('qrcode')
      return await QR.toDataURL(url, { margin: 0, width: 220 })
    } catch {
      return null
    }
  }

  // Reimprime el ticket de una venta histórica reusando el MISMO path de
  // impresión silenciosa que el flujo de venta (útil si la auto-impresión falló
  // o se trabó el papel). Reconstruye el ticket desde el detalle guardado.
  async function reprint(): Promise<void> {
    const d = detailQuery.data
    const company = companyQuery.data
    if (!d || !company) return
    const ticketData: SaleTicketData = {
      company,
      sale: d.sale,
      priceMode: company.priceMode,
      lines: d.lines.map((l) => ({
        // La descripción y el código los resuelve el servidor y viajan con la
        // línea (ver SalesService.getSale): la pantalla no baja el catálogo.
        description:
          l.articleDescription ?? (l.articleId ? descById.get(l.articleId) : null) ?? '—',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        code: l.articleCode ?? null,
        vatRate: l.vatRate,
        discount: l.discount,
      })),
      customerName: customerName || null,
      customerDoc: null,
      customerVatCondition: (() => {
        const c = (customersQuery.data ?? []).find((x) => x.id === d.sale.customerId)
        return c ? (VAT_CONDITION_LABELS[c.category] ?? null) : null
      })(),
      sellerName: null,
      isAccountSale: d.sale.isAccountSale,
      payments: d.payments.map((p) => ({
        methodName: pmNameById.get(p.paymentMethodId) ?? 'Medio de pago',
        amount: p.amount,
      })),
      // El pie fiscal también en la REIMPRESIÓN. Es el camino que se usa
      // cuando se factura después (porque ARCA falló, o faltaba el punto de
      // venta) y salía sin CAE ni QR: el comprobante así no es válido.
      fiscal: voucherQuery.data?.cae
        ? {
            cae: voucherQuery.data.cae,
            caeExpiry: voucherQuery.data.caeExpiry,
            qrDataUrl: voucherQuery.data.qrUrl ? await qrComoImagen(voucherQuery.data.qrUrl) : null,
            letter: voucherQuery.data.letter,
          }
        : null,
    }
    await printSaleTicketSilent(ticketData, printerCfgQuery.data ?? null)
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      {/* Igual que el detalle de compras: max-h + scroll interno para que los
          botones no se caigan de la pantalla con ventas de muchos renglones. */}
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {sale ? `${VOUCHER_LABELS[sale.type]} N° ${sale.number}` : 'Detalle de la venta'}
          </DialogTitle>
        </DialogHeader>
        {detailQuery.isLoading || !sale ? (
          <div className="py-8 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1 text-sm">
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
                      <TableCell>
                        {l.articleDescription ??
                          (l.articleId ? descById.get(l.articleId) : l.description) ??
                          '—'}
                      </TableCell>
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
            {/* Estado fiscal: CAE si ya se facturó, o emisión/reintento si no. */}
            {sale.status === 'completed' && (
              <div className="rounded-md border p-2 text-xs">
                {voucherQuery.data?.cae ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">
                      Comprobante fiscal: {voucherQuery.data.letter}{' '}
                      {String(voucherQuery.data.salePoint).padStart(5, '0')}-
                      {String(voucherQuery.data.number).padStart(8, '0')}
                    </span>
                    <span className="text-muted-foreground">
                      CAE {voucherQuery.data.cae}
                      {voucherQuery.data.caeExpiry
                        ? ` · vence ${formatDate(voucherQuery.data.caeExpiry)}`
                        : ''}
                    </span>
                    {voucherQuery.data.observations && (
                      <span className="text-amber-600">
                        Observaciones de ARCA: {voucherQuery.data.observations}
                      </span>
                    )}
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!companyQuery.data || printingFiscal}
                        onClick={() => void printFiscal()}
                      >
                        {printingFiscal && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Imprimir comprobante
                      </Button>
                      {canVoid && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setNoteKind('credit_note')}>
                            Nota de crédito
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setNoteKind('debit_note')}>
                            Nota de débito
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ) : fiscalCfgQuery.data?.enabled ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">
                      Esta venta todavía no tiene comprobante fiscal.
                    </span>
                    {activePoints.length > 1 && (
                      <select
                        className="rounded border bg-background px-1 py-0.5 text-xs"
                        value={String(issuePoint ?? activePoints[0]?.number ?? '')}
                        onChange={(e) => setIssuePoint(Number(e.target.value))}
                      >
                        {activePoints.map((p) => (
                          <option key={p.id} value={p.number}>
                            Pto. {String(p.number).padStart(5, '0')}
                          </option>
                        ))}
                      </select>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={issueMutation.isPending}
                      onClick={() =>
                        issueMutation.mutate(
                          sale.type === 'A' || sale.type === 'B' || sale.type === 'C'
                            ? sale.type
                            : 'B',
                        )
                      }
                    >
                      {issueMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {sale.type === 'X' ? 'Facturar (Factura B)' : `Emitir Factura ${sale.type}`}
                    </Button>
                  </div>
                ) : (
                  <span className="text-muted-foreground">
                    Comprobante no fiscal (la facturación electrónica está desactivada).
                  </span>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              {canVoid && sale.status === 'completed' && (
                <Button variant="outline" size="sm" onClick={() => setReturning(true)}>
                  <Undo2 className="h-4 w-4" />
                  Devolución
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reprint()}
                disabled={!companyQuery.data || detailQuery.isLoading}
              >
                Reimprimir ticket
              </Button>
            </div>
            {/* Nota de crédito / débito sobre el comprobante fiscal. */}
            {noteKind && voucherQuery.data && (
              <Dialog open onOpenChange={(o) => { if (!o) { setNoteKind(null); setNoteAmount('') } }}>
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>
                      {noteKind === 'credit_note' ? 'Nota de Crédito' : 'Nota de Débito'}{' '}
                      {voucherQuery.data.letter}
                    </DialogTitle>
                  </DialogHeader>
                  <div className="flex flex-col gap-3 text-sm">
                    <p className="text-muted-foreground">
                      {noteKind === 'credit_note'
                        ? 'La nota de crédito anula total o parcialmente la factura. Se emite con CAE y queda asociada al comprobante original.'
                        : 'La nota de débito suma un importe a la factura original (intereses, gastos). Se emite con CAE.'}
                    </p>
                    <div className="rounded-md bg-muted px-3 py-2 text-xs">
                      Sobre: {voucherQuery.data.letter}{' '}
                      {String(voucherQuery.data.salePoint).padStart(5, '0')}-
                      {String(voucherQuery.data.number).padStart(8, '0')} ·{' '}
                      {formatCurrency(voucherQuery.data.total)}
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="note-amount">Importe</Label>
                      <CurrencyInput
                        id="note-amount"
                        value={noteAmount}
                        onChange={setNoteAmount}
                        autoFocus
                      />
                      <span className="text-xs text-muted-foreground">
                        Dejalo vacío para usar el total de la factura
                        {' '}({formatCurrency(voucherQuery.data.total)}).
                      </span>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => { setNoteKind(null); setNoteAmount('') }}
                      disabled={noteMutation.isPending}
                    >
                      Cancelar
                    </Button>
                    <Button onClick={() => noteMutation.mutate()} disabled={noteMutation.isPending}>
                      {noteMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                      Emitir con CAE
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}

            {returning && (
              <ReturnSaleDialog
                saleId={saleId}
                open={returning}
                onClose={() => setReturning(false)}
                onDone={() => {
                  void qc.invalidateQueries({ queryKey: ['salesHistory'] })
                  void qc.invalidateQueries({ queryKey: ['sale', saleId] })
                }}
              />
            )}
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
  const canWrite = useCanWrite()
  const canVoid = usePermission('void_sale') && canWrite
  const customersQuery = useCustomers()
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: api.users.list, enabled: isAdmin })

  const [fromIso, setFromIso] = useState(() => todayIso())
  const [toIso, setToIso] = useState(() => todayIso())
  const [customerId, setCustomerId] = useState('')
  const [sellerId, setSellerId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | VoucherType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [searchNumber, setSearchNumber] = useState('')
  /** Filtro por forma de pago: "cuánto vendí por transferencia" en el día. */
  const [payMethod, setPayMethod] = useState('')
  const [page, setPage] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [anulandoHoy, setAnulandoHoy] = useState(false)

  // Deep-link: `?saleId=<id>` abre el detalle. Si la venta no está en el rango
  // actual, ampliamos el rango y resolvemos el cliente con get().
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id = searchParams.get('saleId')
    if (!id) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailId(id)
    const next = new URLSearchParams(searchParams)
    next.delete('saleId')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

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
    if (payMethod) rows = rows.filter((s) => (s.payments ?? []).some((p) => p.paymentMethodId === payMethod))
    return [...rows].sort((a, b) => b.date - a.date)
  }, [salesQuery.data, customerId, sellerId, typeFilter, statusFilter, searchNumber, payMethod])

  /** Formas de pago presentes en el rango, para poblar el desplegable. */
  const mediosEnRango = useMemo(() => {
    const m = new Map<string, string>()
    for (const v of salesQuery.data ?? []) {
      for (const p of v.payments ?? []) m.set(p.paymentMethodId, p.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [salesQuery.data])

  /**
   * Total cobrado POR ESE MEDIO en lo filtrado. No es el total de las ventas:
   * en un pago mixto sólo cuenta la parte que entró por ese medio, que es lo
   * que el comercio quiere saber.
   */
  const totalDelMedio = useMemo(() => {
    if (!payMethod) return null
    return filtered
      .filter((s) => s.status === 'completed')
      .reduce(
        (acc, s) =>
          acc + (s.payments ?? []).filter((p) => p.paymentMethodId === payMethod).reduce((a, p) => a + Number(p.amount), 0),
        0,
      )
  }, [filtered, payMethod])

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
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Historial de Ventas</h1>
        {/* Sólo el administrador, y sólo si puede anular. Es para la puesta en
            marcha de un local: limpiar las ventas de prueba del día. */}
        {isAdmin && canVoid && (
          <Button variant="outline" size="sm" onClick={() => setAnulandoHoy(true)}>
            <Undo2 className="h-4 w-4" />
            Anular ventas de hoy
          </Button>
        )}
      </div>

      {anulandoHoy && <AnularVentasDeHoyDialog onClose={() => setAnulandoHoy(false)} />}

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
            <Label>Forma de pago</Label>
            <Select value={payMethod} onChange={(e) => resetPage(() => setPayMethod(e.target.value))}>
              <option value="">Todas</option>
              {mediosEnRango.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
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
        <span>
          {filtered.length} venta(s) — total completadas: <span className="font-medium tabular-nums text-foreground">{formatCurrency(parseCurrencyInput(String(totalAmount)))}</span>
          {/* Con un medio filtrado, lo que importa es cuánto entró POR ESE medio:
              en un pago mixto solo cuenta esa parte, no el total de la venta. */}
          {totalDelMedio != null && (
            <>
              {' · '}cobrado por {mediosEnRango.find((m) => m.id === payMethod)?.name ?? 'ese medio'}:{' '}
              <span className="font-semibold tabular-nums text-foreground">{formatCurrency(parseCurrencyInput(String(totalDelMedio)))}</span>
            </>
          )}
        </span>
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
