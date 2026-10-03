/**
 * Detalle de una venta (renglones, pagos, estado fiscal con CAE, emitir o
 * reintentar la factura, notas de crédito/débito, devolución, anular,
 * reimprimir). Lo usan Historial de Ventas y Facturas emitidas (Contabilidad).
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Undo2, Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useCompany, useCustomers, usePaymentMethods } from '@/lib/hooks'
import { formatCurrency, formatDate, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { ReturnSaleDialog } from '@/components/ReturnDialogs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { DocType, VoucherType } from '@/types/api'
import type { SaleTicketData } from '@/print/SaleTicket'
import { RECEIVER_VAT_CONDITION_BY_ID, VAT_CONDITION_LABELS } from '@/lib/fiscalDoc'
import { printSaleTicketSilent } from '@/lib/printSaleTicket'

const VOUCHER_LABELS: Record<VoucherType, string> = { A: 'Factura A', B: 'Factura B', C: 'Factura C', X: 'Remito X' }

export function SaleDetailDialog({
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
      // Comprobantes emitidos antes de guardar la condición IVA del receptor:
      // se toma la categoría actual del cliente.
      const clienteActual = (customersQuery.data ?? []).find((x) => x.id === v.customerId)
      const doc = await buildFiscalDoc({
        company,
        voucher: v,
        sale: d?.sale ?? null,
        lines: d?.lines,
        descriptionById: descById,
        paymentNote: d?.sale.isAccountSale ? 'Cuenta corriente' : null,
        customerVatCondition: clienteActual ? (VAT_CONDITION_LABELS[clienteActual.category] ?? null) : null,
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

  /**
   * Documento del receptor para emitir DESDE ACÁ, como en Ventas: arranca con
   * el de la ficha y se puede completar en el momento. Sin esto, la venta a un
   * consumidor final con DNI tipeado en el mostrador no se podía reintentar.
   */
  const clienteVenta = useMemo(
    () => (customersQuery.data ?? []).find((c) => c.id === detailQuery.data?.sale.customerId) ?? null,
    [customersQuery.data, detailQuery.data],
  )
  const [docManual, setDocManual] = useState<{ tipo: DocType; nro: string } | null>(null)
  const docReceptor = docManual ?? {
    tipo: (clienteVenta?.docType ?? 'CF') as DocType,
    nro: clienteVenta?.docNumber ?? '',
  }
  // La letra NO se fuerza con la de la venta: la decide el emisor y el cliente
  // (misma regla que `resolveVoucherLetter` en el servicio, que es quien la
  // aplica cuando no se manda `letter`). Forzarla mandaba "Factura B" a un
  // responsable inscripto y una B a un emisor monotributista: rechazo seguro.
  // La única excepción es la Factura A "de mostrador" (ficha Consumidor Final
  // con CUIT tipeado), que la venta registró como A y hay que respetar.
  const emisor = fiscalCfgQuery.data?.vatCondition ?? 'RI'
  const letraCliente: 'A' | 'B' | 'C' =
    emisor === 'MT' ? 'C' : clienteVenta?.category === 'RI' || clienteVenta?.category === 'MT' ? 'A' : 'B'
  const aDeMostrador =
    emisor === 'RI' && detailQuery.data?.sale.type === 'A' && docReceptor.tipo === 'CUIT'
  const letraAEmitir: 'A' | 'B' | 'C' = aDeMostrador ? 'A' : letraCliente
  const faltaCuitParaFacturaA =
    letraAEmitir === 'A' && (docReceptor.tipo !== 'CUIT' || docReceptor.nro.trim() === '')

  const issueMutation = useMutation({
    mutationFn: () =>
      api.fiscal.issueInvoice({
        saleId,
        salePoint: issuePoint ?? activePoints[0]?.number ?? 1,
        letter: aDeMostrador ? 'A' : undefined,
        // Si la ficha no está en la lista (todavía no cargó, o el cliente está
        // inactivo) `docReceptor` cae a Consumidor Final sin documento; mandarlo
        // igual pisaba el CUIT de la ficha que el servicio sí conoce.
        receiverDoc:
          docManual || clienteVenta
            ? { docType: docReceptor.tipo, docNumber: docReceptor.nro }
            : undefined,
      }),
    onSuccess: (v) => {
      void qc.invalidateQueries({ queryKey: ['fiscal', 'voucher', saleId] })
      // Facturas emitidas (Contabilidad) lista los comprobantes del período:
      // si se emite desde acá, que deje de verse como pendiente.
      void qc.invalidateQueries({ queryKey: ['fiscal', 'vouchers'] })
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
    mutationFn: () => api.sales.void(saleId, reason.trim() || null),
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
    // El documento y la condición IVA del receptor se toman del comprobante
    // autorizado, que es lo que se le informó a ARCA; la ficha de hoy sirve
    // sólo si no hay comprobante. La Factura A de mostrador (ficha Consumidor
    // Final + CUIT tipeado) se reimprimía sin el CUIT y como Consumidor Final.
    const v = voucherQuery.data?.cae ? voucherQuery.data : null
    const docVoucher =
      v && v.customerDocType !== 99
        ? `${v.customerDocType === 80 ? 'CUIT' : v.customerDocType === 96 ? 'DNI' : 'Doc'} ${v.customerDocNumber}`
        : null
    const condVoucher =
      v?.customerVatConditionId != null ? (RECEIVER_VAT_CONDITION_BY_ID[v.customerVatConditionId] ?? null) : null
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
      customerDoc: docVoucher,
      customerVatCondition:
        condVoucher ??
        (() => {
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
            qrUrl: voucherQuery.data.qrUrl,
            letter: voucherQuery.data.letter,
            // El papel lleva la numeración de ARCA, no la interna de la venta.
            salePoint: voucherQuery.data.salePoint,
            number: voucherQuery.data.number,
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
                  <div className="flex flex-col gap-2">
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
                    </div>
                    {/* Documento del receptor, como en Ventas: el de la ficha o
                        el tipeado acá. */}
                    <div className="flex items-end gap-2">
                      <div className="flex flex-col gap-1">
                        <Label className="text-xs">Documento del cliente</Label>
                        <Select
                          className="w-28"
                          value={docReceptor.tipo}
                          onChange={(e) =>
                            setDocManual({ tipo: e.target.value as DocType, nro: docReceptor.nro })
                          }
                        >
                          <option value="CF">Sin identificar</option>
                          <option value="DNI">DNI</option>
                          <option value="CUIT">CUIT</option>
                          <option value="CUIL">CUIL</option>
                          <option value="PASS">Pasaporte</option>
                        </Select>
                      </div>
                      <Input
                        className="flex-1 tabular-nums"
                        value={docReceptor.nro}
                        disabled={docReceptor.tipo === 'CF'}
                        placeholder={docReceptor.tipo === 'CF' ? 'Consumidor final' : 'Número, sin puntos ni guiones'}
                        inputMode="numeric"
                        onChange={(e) =>
                          setDocManual({ tipo: docReceptor.tipo, nro: e.target.value.replace(/\D/g, '') })
                        }
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={issueMutation.isPending || faltaCuitParaFacturaA}
                        onClick={() => issueMutation.mutate()}
                      >
                        {issueMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        Emitir Factura {letraAEmitir}
                      </Button>
                    </div>
                    {faltaCuitParaFacturaA && (
                      <span className="text-destructive">
                        {clienteVenta?.category === 'MT'
                          ? 'Al cliente Monotributista corresponde emitirle Factura A, que requiere su CUIT.'
                          : 'La Factura A requiere el CUIT del cliente.'}
                      </span>
                    )}
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
                        Dejar vacío para usar el total de la factura
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
                <p className="text-xs text-destructive">Anular esta venta revierte stock y caja. Indique el motivo:</p>
                {(sale.afipCAE || voucherQuery.data?.cae) && (
                  <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                    Este comprobante tiene CAE de ARCA (N° {sale.afipCAE || voucherQuery.data?.cae}). Anularlo acá no lo da de baja en ARCA:
                    corresponde emitir la nota de crédito. El motivo queda registrado en la venta.
                  </p>
                )}
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
