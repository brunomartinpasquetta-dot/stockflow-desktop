import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Undo2, FileDown, FileSpreadsheet, ArrowLeft, ChevronDown, ChevronRight, Landmark, Loader2, Printer, ReceiptText } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useArticles, useCompany, useCustomerBalances, usePaymentMethods } from '@/lib/hooks'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
import { printSaleTicketSilent } from '@/lib/printSaleTicket'
import { ReturnSaleDialog } from '@/components/ReturnDialogs'
import { exportReceiptPdf } from '@/lib/receiptDoc'
import { exportStatementPdf, exportStatementExcel } from '@/lib/statementDoc'
import { printPaymentReceiptSilent } from '@/lib/printPaymentReceipt'
import type { SaleTicketData } from '@/print/SaleTicket'
import type { PaymentReceiptData } from '@/print/PaymentReceipt'
import { usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { formatCurrency, formatDate, parseCurrencyInput } from '@/lib/format'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PaymentSplitInput } from '@/components/PaymentSplitInput'
import { WhatsAppButton } from '@/components/WhatsAppButton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CuentasCorrientesProveedores } from './CuentasCorrientesProveedores'
import type { AccountReceivableDTO, StatementEntryDTO } from '@/types/api'

function CobranzaDialog({
  account,
  customerId,
  onClose,
}: {
  account: AccountReceivableDTO
  customerId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const methodsQuery = usePaymentMethods()
  const activeMethods = useMemo(() => (methodsQuery.data ?? []).filter((m) => m.active), [methodsQuery.data])
  const [monto, setMonto] = useState<string>(account.balance)
  const montoNum = monto ? Number(parseCurrencyInput(monto)) : 0
  const balanceNum = Number(account.balance)
  const split = usePaymentSplit(activeMethods, montoNum)

  const overBalance = montoNum > balanceNum + 0.005
  const canConfirm = montoNum > 0 && !overBalance && split.isComplete && activeMethods.length > 0

  const mutation = useMutation({
    mutationFn: () =>
      api.accounts.receivePayment({
        accountId: account.id,
        payments: split.payments,
        expectedAmount: montoNum.toFixed(4),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customerBalances'] })
      void qc.invalidateQueries({ queryKey: ['accountStatement', customerId] })
      void qc.invalidateQueries({ queryKey: ['accountOpen', customerId] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      toast.success(`Cobranza registrada — ${formatCurrency(montoNum)}`)
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar la cobranza'),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar cobranza</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            Saldo del comprobante: <span className="font-semibold tabular-nums">{formatCurrency(account.balance)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cobranza-monto">Monto a cobrar</Label>
            <CurrencyInput
              id="cobranza-monto"
              autoFocus
              value={monto}
              onChange={setMonto}
            />
            {overBalance && <span className="text-xs text-destructive">No puede superar el saldo del comprobante.</span>}
          </div>
          <div className="border-t pt-2">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Composición del pago</p>
            <PaymentSplitInput methods={activeMethods} split={split} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canConfirm || mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar cobranza
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Cobranza a NIVEL CUENTA: un monto (parcial o total) que se aplica al saldo
 * total del cliente, distribuyéndose automáticamente entre los comprobantes
 * abiertos (FIFO, del más viejo al más nuevo).
 */
function CobranzaCuentaDialog({
  customerId,
  totalBalance,
  initialAmount,
  contextNote,
  onPaid,
  onClose,
}: {
  customerId: string
  totalBalance: string
  /** Monto precargado (ej: neto del período filtrado). Default: saldo total. */
  initialAmount?: string
  /** Nota de contexto que se muestra en el diálogo (ej: "Período 01/06–30/06"). */
  contextNote?: string
  /** Callback tras registrar el pago (para imprimir el recibo del período). */
  onPaid?: (info: { amount: number; payments: { paymentMethodId: string; amount: string }[] }) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const methodsQuery = usePaymentMethods()
  const activeMethods = useMemo(() => (methodsQuery.data ?? []).filter((m) => m.active), [methodsQuery.data])
  const [monto, setMonto] = useState<string>(initialAmount ?? totalBalance)
  const montoNum = monto ? Number(parseCurrencyInput(monto)) : 0
  const balanceNum = Number(totalBalance)
  const split = usePaymentSplit(activeMethods, montoNum)

  const overBalance = montoNum > balanceNum + 0.005
  const canConfirm = montoNum > 0 && !overBalance && split.isComplete && activeMethods.length > 0

  const mutation = useMutation({
    mutationFn: () =>
      api.accounts.receivePaymentToCustomer({
        customerId,
        payments: split.payments,
        expectedAmount: montoNum.toFixed(4),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customerBalances'] })
      void qc.invalidateQueries({ queryKey: ['accountStatement', customerId] })
      void qc.invalidateQueries({ queryKey: ['accountOpen', customerId] })
      void qc.invalidateQueries({ queryKey: ['accountDetail'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      toast.success(`Cobranza registrada — ${formatCurrency(montoNum)}`)
      onPaid?.({ amount: montoNum, payments: split.payments })
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar la cobranza'),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar cobranza a la cuenta</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {contextNote && (
            <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm">{contextNote}</div>
          )}
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            Saldo total del cliente: <span className="font-semibold tabular-nums">{formatCurrency(totalBalance)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            El monto se aplicará a los comprobantes abiertos del más antiguo al más reciente.
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cobranza-cuenta-monto">Monto a cobrar</Label>
            <CurrencyInput
              id="cobranza-cuenta-monto"
              autoFocus
              value={monto}
              onChange={setMonto}
            />
            {overBalance && <span className="text-xs text-destructive">No puede superar el saldo total del cliente.</span>}
          </div>
          <div className="border-t pt-2">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Composición del pago</p>
            <PaymentSplitInput methods={activeMethods} split={split} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canConfirm || mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar cobranza
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Detalle expandible de un comprobante: productos + cobranzas aplicadas. */
function ComprobanteDetalle({ accountId }: { accountId: string }) {
  const detailQuery = useQuery({
    queryKey: ['accountDetail', accountId],
    queryFn: () => api.accounts.getAccountDetail(accountId),
  })

  if (detailQuery.isLoading) {
    return <div className="px-4 py-3 text-sm text-muted-foreground">Cargando detalle…</div>
  }
  if (detailQuery.isError || !detailQuery.data) {
    return <div className="px-4 py-3 text-sm text-destructive">No se pudo cargar el detalle.</div>
  }

  const { lines, payments, account } = detailQuery.data

  return (
    <div className="flex flex-col gap-4 bg-muted/40 px-4 py-3">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Productos</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Descripción</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Precio unit.</TableHead>
              <TableHead className="text-right">Subtotal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-4 text-center text-sm text-muted-foreground">Sin líneas</TableCell>
              </TableRow>
            ) : (
              lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm">
                    {l.description}
                    {l.brand && <span className="ml-1 text-xs text-muted-foreground">({l.brand})</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(l.unitPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(l.lineTotal)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cobranzas aplicadas</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Medio de pago</TableHead>
              <TableHead className="text-right">Monto</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-4 text-center text-sm text-muted-foreground">Sin cobranzas aplicadas</TableCell>
              </TableRow>
            ) : (
              payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-sm">{formatDate(p.date)}</TableCell>
                  <TableCell className="text-sm">{p.paymentMethodName}</TableCell>
                  <TableCell className="text-right tabular-nums text-success">{formatCurrency(p.amount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end text-sm">
        <span className="rounded-md bg-background px-3 py-1">
          Saldo del comprobante: <span className="font-semibold tabular-nums">{formatCurrency(account.balance)}</span>
        </span>
      </div>
    </div>
  )
}

function CustomerDetail({ customerId, onBack }: { customerId: string; onBack: () => void }) {
  const canWrite = useCanWrite()
  const canCobrar = usePermission('receive_payment') && canWrite
  const statementQuery = useQuery({
    queryKey: ['accountStatement', customerId],
    queryFn: () => api.accounts.getStatement(customerId),
  })
  const openQuery = useQuery({
    queryKey: ['accountOpen', customerId],
    queryFn: () => api.accounts.listOpenByCustomer(customerId),
  })
  const [cobrando, setCobrando] = useState<AccountReceivableDTO | null>(null)
  const [cobrandoCuenta, setCobrandoCuenta] = useState(false)
  const [cobrandoPeriodo, setCobrandoPeriodo] = useState(false)
  const [returningSaleId, setReturningSaleId] = useState<string | null>(null)
  const qc = useQueryClient()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Filtro de movimientos por rango de fechas (YYYY-MM-DD; vacío = sin límite).
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const companyQuery = useCompany()
  const articlesQuery = useArticles()
  const methodsQuery = usePaymentMethods()
  const printerCfgQuery = useQuery({
    queryKey: ['hardwarePrinterConfig'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })
  const descById = useMemo(
    () => new Map((articlesQuery.data ?? []).map((a) => [a.id, a.description])),
    [articlesQuery.data],
  )
  const pmNameById = useMemo(
    () => new Map((methodsQuery.data ?? []).map((m) => [m.id, m.name])),
    [methodsQuery.data],
  )

  const customer = statementQuery.data?.customer
  const name = customer ? (customer.firstName ? `${customer.lastName}, ${customer.firstName}` : customer.lastName) : '…'
  const balance = statementQuery.data?.currentBalance ?? '0'
  const hasBalance = Number(balance) > 0.005

  // ── Rango de fechas: movimientos filtrados + totales del período ──
  const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null
  const toMs = toDate ? new Date(`${toDate}T23:59:59.999`).getTime() : null
  const rangeActive = fromMs != null || toMs != null
  const filteredEntries = useMemo(() => {
    const all = statementQuery.data?.entries ?? []
    if (!rangeActive) return all
    return all.filter((e) => (fromMs == null || e.date >= fromMs) && (toMs == null || e.date <= toMs))
  }, [statementQuery.data, fromMs, toMs, rangeActive])
  const periodCharges = useMemo(
    () => filteredEntries.reduce((n, e) => n + Number(e.debit || 0), 0),
    [filteredEntries],
  )
  const periodPayments = useMemo(
    () => filteredEntries.reduce((n, e) => n + Number(e.credit || 0), 0),
    [filteredEntries],
  )
  const periodNet = Math.max(0, periodCharges - periodPayments)
  // Lo cobrable del período no puede superar el saldo actual de la cuenta.
  const periodCobrable = Math.min(periodNet, Number(balance))

  /** Recibo del período: se imprime tras registrar la cobranza del rango. */
  function printPeriodReceipt(info: { amount: number; payments: { paymentMethodId: string; amount: string }[] }): void {
    const company = companyQuery.data
    if (!company || filteredEntries.length === 0) return
    const methodLabel =
      info.payments.length <= 1
        ? (pmNameById.get(info.payments[0]?.paymentMethodId ?? '') ?? 'Cobranza')
        : info.payments.map((p) => pmNameById.get(p.paymentMethodId) ?? '—').join(' + ')
    // Tope de líneas para no escupir un rollo infinito en rangos largos.
    const MAX_LINES = 40
    const lines = filteredEntries.slice(0, MAX_LINES).map((e) => ({
      date: e.date,
      label:
        e.kind === 'sale'
          ? e.saleType && e.saleNumber != null
            ? `Venta ${e.saleType} #${e.saleNumber}`
            : 'Venta'
          : `Pago ${e.paymentMethodName ?? ''}`.trim(),
      amount: Number(e.debit) > 0 ? e.debit : e.credit,
    }))
    if (filteredEntries.length > MAX_LINES)
      lines.push({ date: toMs ?? Date.now(), label: `… y ${filteredEntries.length - MAX_LINES} mov. más`, amount: '0' })
    const data: PaymentReceiptData = {
      company,
      customerName: name,
      customerDoc: customer?.docNumber ? `${customer.docType ?? ''} ${customer.docNumber}`.trim() : null,
      date: Date.now(),
      paymentMethod: methodLabel,
      amount: info.amount.toFixed(2),
      comprobanteRef: null,
      comprobanteBalance: null,
      accountBalance: Math.max(0, Number(balance) - info.amount).toFixed(2),
      period: {
        from: fromMs ?? filteredEntries[0]!.date,
        to: toMs ?? filteredEntries[filteredEntries.length - 1]!.date,
        lines,
        charges: periodCharges.toFixed(2),
        payments: periodPayments.toFixed(2),
      },
    }
    void printPaymentReceiptSilent(data, printerCfgQuery.data ?? null)
  }

  // Reimprime el ticket de una venta a cuenta (mismo camino que Historial de
  // Ventas). Útil cuando la venta ya está saldada y quiere entregarse el ticket.
  async function reprintSale(saleId: string): Promise<void> {
    const company = companyQuery.data
    if (!company) return
    const d = await api.sales.get(saleId)
    const ticketData: SaleTicketData = {
      company,
      sale: d.sale,
      priceMode: company.priceMode,
      lines: d.lines.map((l) => ({
        description: descById.get(l.articleId) ?? '—',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
      customerName: name !== '…' ? name : null,
      customerDoc: customer?.docNumber ? `${customer.docType ?? ''} ${customer.docNumber}`.trim() : null,
      sellerName: null,
      isAccountSale: d.sale.isAccountSale,
      payments: d.payments.map((p) => ({
        methodName: pmNameById.get(p.paymentMethodId) ?? 'Medio de pago',
        amount: p.amount,
      })),
    }
    await printSaleTicketSilent(ticketData, printerCfgQuery.data ?? null)
  }

  // Datos del recibo de una cobranza (compartidos por Imprimir y Exportar PDF).
  function receiptDataFor(e: StatementEntryDTO): PaymentReceiptData | null {
    const company = companyQuery.data
    if (!company) return null
    return {
      company,
      customerName: name,
      customerDoc: customer?.docNumber ? `${customer.docType ?? ''} ${customer.docNumber}`.trim() : null,
      date: e.date,
      paymentMethod: e.paymentMethodName ?? 'Cobranza',
      amount: e.credit,
      comprobanteRef: e.saleType && e.saleNumber != null ? `Venta ${e.saleType} #${e.saleNumber}` : null,
      comprobanteBalance: e.comprobanteBalance,
      accountBalance: e.runningBalance,
    }
  }

  /** Datos del resumen, compartidos por PDF y Excel (respetan el filtro de fechas). */
  function statementDocData() {
    const company = companyQuery.data
    if (!company || !customer) return null
    return {
      company,
      customer,
      entries: filteredEntries,
      balance,
      range: rangeActive
        ? { from: fromMs ?? filteredEntries[0]?.date ?? Date.now(), to: toMs ?? Date.now() }
        : null,
    }
  }

  function printReceipt(e: StatementEntryDTO): void {
    const data = receiptDataFor(e)
    if (data) void printPaymentReceiptSilent(data, printerCfgQuery.data ?? null)
  }

  function exportPdf(e: StatementEntryDTO): void {
    const data = receiptDataFor(e)
    if (data) exportReceiptPdf(data)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} title="Volver al listado">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="inline-flex items-center gap-1.5 text-lg font-semibold">
              {name}
              <WhatsAppButton phone={customer?.mobile ?? customer?.phone} />
            </h1>
            {customer?.docNumber && (
              <p className="text-xs text-muted-foreground">
                {customer.docType} {customer.docNumber}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Card>
            <CardContent className="px-4 py-2 text-sm">
              Saldo: <span className="text-lg font-bold tabular-nums">{formatCurrency(balance)}</span>
            </CardContent>
          </Card>
          <Button
            variant="outline"
            onClick={() => {
              const d = statementDocData()
              if (d) exportStatementPdf(d)
            }}
            disabled={filteredEntries.length === 0 || !companyQuery.data}
            title="Descargar el resumen de cuenta en PDF para mandarle al cliente"
          >
            <FileDown className="mr-1.5 h-4 w-4" /> Resumen PDF
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const d = statementDocData()
              if (d) void exportStatementExcel(d)
            }}
            disabled={filteredEntries.length === 0 || !companyQuery.data}
            title="Descargar el resumen de cuenta en Excel"
          >
            <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Resumen Excel
          </Button>
          <Button
            disabled={!canCobrar || !hasBalance}
            title={
              !canCobrar
                ? 'Requiere permiso para cobrar'
                : !hasBalance
                  ? 'El cliente no tiene saldo pendiente'
                  : undefined
            }
            onClick={() => setCobrandoCuenta(true)}
          >
            Registrar cobranza
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-sm font-medium">Comprobantes con saldo</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {openQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Cargando…</TableCell>
                </TableRow>
              ) : (openQuery.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Sin comprobantes pendientes</TableCell>
                </TableRow>
              ) : (
                (openQuery.data ?? []).map((ar) => {
                  const isOpen = expandedId === ar.id
                  return (
                    <Fragment key={ar.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpandedId(isOpen ? null : ar.id)}
                      >
                        <TableCell className="text-muted-foreground">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(ar.createdAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(ar.total)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{formatCurrency(ar.balance)}</TableCell>
                        <TableCell>
                          <Badge variant={ar.status === 'partial' ? 'warning' : 'outline'}>{ar.status === 'partial' ? 'Parcial' : 'Abierto'}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canCobrar}
                            title={canCobrar ? undefined : 'Requiere permiso para cobrar'}
                            onClick={(e) => { e.stopPropagation(); setCobrando(ar) }}
                          >
                            Cobrar
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={6} className="p-0">
                            <ComprobanteDetalle accountId={ar.id} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-sm font-medium">Movimientos</span>
            <div className="flex items-center gap-1.5">
              <Label htmlFor="cc-desde" className="text-xs text-muted-foreground">Desde</Label>
              <Input id="cc-desde" type="date" className="h-7 w-[135px] px-2 text-xs" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              <Label htmlFor="cc-hasta" className="text-xs text-muted-foreground">Hasta</Label>
              <Input id="cc-hasta" type="date" className="h-7 w-[135px] px-2 text-xs" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              {rangeActive && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setFromDate(''); setToDate('') }}>
                  Todo
                </Button>
              )}
            </div>
          </div>
          {rangeActive && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-primary/5 px-4 py-2 text-sm">
              <div className="flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
                <span>Ventas del período: <b>{formatCurrency(periodCharges)}</b></span>
                <span>Cobranzas: <b className="text-success">{formatCurrency(periodPayments)}</b></span>
                <span>Total del período: <b>{formatCurrency(periodNet)}</b></span>
              </div>
              <Button
                size="sm"
                disabled={!canCobrar || periodCobrable <= 0.005 || filteredEntries.length === 0}
                title={
                  !canCobrar
                    ? 'Requiere permiso para cobrar'
                    : periodCobrable <= 0.005
                      ? 'No hay importe pendiente en el período'
                      : `Registrar una cobranza por ${formatCurrency(periodCobrable)} y emitir el ticket con el detalle`
                }
                onClick={() => setCobrandoPeriodo(true)}
              >
                <ReceiptText className="h-4 w-4" />
                Cobrar período
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Detalle</TableHead>
                <TableHead>Medio de pago</TableHead>
                <TableHead className="text-right">Importe</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statementQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Cargando…</TableCell>
                </TableRow>
              ) : filteredEntries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                    {rangeActive ? 'Sin movimientos en el período seleccionado' : 'Sin movimientos'}
                  </TableCell>
                </TableRow>
              ) : (
                filteredEntries.map((e, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{formatDate(e.date)}</TableCell>
                    <TableCell>
                      {e.kind === 'sale'
                        ? 'Venta'
                        : e.kind === 'return'
                          ? 'Devolución'
                          : e.comprobanteBalance != null && Number(e.comprobanteBalance) <= 0.005
                            ? 'Cobranza total'
                            : 'Cobranza parcial'}
                    </TableCell>
                    <TableCell className="text-sm">{e.kind === 'sale' ? 'Cuenta corriente' : e.kind === 'return' ? 'Crédito en cuenta' : (e.paymentMethodName ?? '—')}</TableCell>
                    <TableCell className={`text-right tabular-nums ${e.kind !== 'sale' ? 'text-success' : ''}`}>
                      {formatCurrency(Number(e.debit) > 0 ? e.debit : e.credit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(e.runningBalance)}</TableCell>
                    <TableCell className="text-right">
                      {e.kind === 'payment' ? (
                        <span className="inline-flex items-center">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="Imprimir recibo de cobranza"
                          disabled={!companyQuery.data}
                          onClick={() => printReceipt(e)}
                        >
                          <ReceiptText className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          title="Exportar recibo como PDF"
                          disabled={!companyQuery.data}
                          onClick={() => exportPdf(e)}
                        >
                          <FileDown className="h-4 w-4" />
                        </Button>
                        </span>
                      ) : e.kind === 'sale' && e.saleId ? (
                        <span className="inline-flex items-center">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Reimprimir venta"
                            disabled={!companyQuery.data}
                            onClick={() => { void reprintSale(e.saleId!) }}
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Registrar una devolución de esta venta"
                            onClick={() => setReturningSaleId(e.saleId)}
                          >
                            <Undo2 className="h-4 w-4" />
                          </Button>
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {returningSaleId && (
        <ReturnSaleDialog
          saleId={returningSaleId}
          open
          onClose={() => setReturningSaleId(null)}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ['customerStatement'] })
            void qc.invalidateQueries({ queryKey: ['customerBalances'] })
          }}
        />
      )}
      {cobrando && <CobranzaDialog account={cobrando} customerId={customerId} onClose={() => setCobrando(null)} />}
      {cobrandoCuenta && (
        <CobranzaCuentaDialog
          customerId={customerId}
          totalBalance={balance}
          onClose={() => setCobrandoCuenta(false)}
        />
      )}
      {cobrandoPeriodo && (
        <CobranzaCuentaDialog
          customerId={customerId}
          totalBalance={balance}
          initialAmount={periodCobrable.toFixed(2)}
          contextNote={`Cobranza del período ${fromDate ? formatDate(fromMs!) : 'inicio'} al ${toDate ? formatDate(toMs!) : 'hoy'} — ${filteredEntries.length} movimiento(s). Al confirmar se imprime el ticket con el detalle.`}
          onPaid={printPeriodReceipt}
          onClose={() => setCobrandoPeriodo(false)}
        />
      )}
    </div>
  )
}

function ClientesTab() {
  const balances = useCustomerBalances()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (selectedId) {
    return <CustomerDetail customerId={selectedId} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead className="text-right">Comprobantes</TableHead>
                <TableHead className="text-right">Último pago</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balances.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">Cargando…</TableCell>
                </TableRow>
              ) : (balances.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    <Landmark className="mx-auto mb-2 h-7 w-7 opacity-40" />
                    No hay clientes con saldo en cuenta corriente.
                  </TableCell>
                </TableRow>
              ) : (
                (balances.data ?? []).map((b) => (
                  <TableRow key={b.customerId} className="cursor-pointer" onClick={() => setSelectedId(b.customerId)}>
                    <TableCell className="font-medium">{b.customerName}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.openInvoicesCount}</TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">{b.lastPaymentDate ? formatDate(b.lastPaymentDate) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatCurrency(b.totalDebt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <WhatsAppButton phone={b.phone} />
                        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(b.customerId) }}>
                          Ver
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

export function CuentasCorrientes() {
  return (
    <Tabs defaultValue="clientes" className="flex flex-col gap-3">
      <TabsList className="self-start">
        <TabsTrigger value="clientes">Clientes</TabsTrigger>
        <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
      </TabsList>
      <TabsContent value="clientes"><ClientesTab /></TabsContent>
      <TabsContent value="proveedores"><CuentasCorrientesProveedores /></TabsContent>
    </Tabs>
  )
}
