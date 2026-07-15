import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FileDown, ArrowLeft, ChevronDown, ChevronRight, Loader2, ReceiptText, Truck } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useSupplierBalances } from '@/lib/hooks'
import { useCompany, usePaymentMethods } from '@/lib/hooks'
import { exportReceiptPdf } from '@/lib/receiptDoc'
import { printPaymentReceiptSilent } from '@/lib/printPaymentReceipt'
import type { PaymentReceiptData } from '@/print/PaymentReceipt'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
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
import type { SupplierAccountPayableDTO } from '@/types/api'

function PagoDialog({
  account,
  supplierId,
  onClose,
}: {
  account: SupplierAccountPayableDTO
  supplierId: string
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
      api.supplierAccounts.payInvoice({
        accountId: account.id,
        payments: split.payments,
        expectedAmount: montoNum.toFixed(4),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['supplierBalances'] })
      void qc.invalidateQueries({ queryKey: ['supplierStatement', supplierId] })
      void qc.invalidateQueries({ queryKey: ['supplierOpen', supplierId] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      toast.success(`Pago registrado — ${formatCurrency(montoNum)}`)
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar el pago'),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar pago</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            Saldo del comprobante: <span className="font-semibold tabular-nums">{formatCurrency(account.balance)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pago-monto">Monto a pagar</Label>
            <CurrencyInput
              id="pago-monto"
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
            Confirmar pago
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Pago a NIVEL CUENTA: un monto (parcial o total) que se aplica al saldo total
 * del proveedor, distribuyéndose automáticamente entre los comprobantes abiertos
 * (FIFO, del más viejo al más nuevo).
 */
function PagoCuentaDialog({
  supplierId,
  totalBalance,
  initialAmount,
  contextNote,
  onPaid,
  onClose,
}: {
  supplierId: string
  totalBalance: string
  /** Monto precargado (ej: neto del período filtrado). Default: saldo total. */
  initialAmount?: string
  /** Nota de contexto que se muestra en el diálogo. */
  contextNote?: string
  /** Callback tras registrar el pago (para imprimir el comprobante del período). */
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
      api.supplierAccounts.payToSupplier({
        supplierId,
        payments: split.payments,
        expectedAmount: montoNum.toFixed(4),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['supplierBalances'] })
      void qc.invalidateQueries({ queryKey: ['supplierStatement', supplierId] })
      void qc.invalidateQueries({ queryKey: ['supplierOpen', supplierId] })
      void qc.invalidateQueries({ queryKey: ['supplierAccountDetail'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      toast.success(`Pago registrado — ${formatCurrency(montoNum)}`)
      onPaid?.({ amount: montoNum, payments: split.payments })
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar el pago'),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar pago a la cuenta</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {contextNote && (
            <div className="rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm">{contextNote}</div>
          )}
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            Saldo total del proveedor: <span className="font-semibold tabular-nums">{formatCurrency(totalBalance)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            El monto se aplicará a los comprobantes abiertos del más antiguo al más reciente.
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pago-cuenta-monto">Monto a pagar</Label>
            <CurrencyInput
              id="pago-cuenta-monto"
              autoFocus
              value={monto}
              onChange={setMonto}
            />
            {overBalance && <span className="text-xs text-destructive">No puede superar el saldo total del proveedor.</span>}
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
            Confirmar pago
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Detalle expandible de un comprobante: productos + pagos aplicados. */
function ComprobanteDetalle({ accountId }: { accountId: string }) {
  const detailQuery = useQuery({
    queryKey: ['supplierAccountDetail', accountId],
    queryFn: () => api.supplierAccounts.getAccountDetail(accountId),
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
              <TableHead className="text-right">Costo unit.</TableHead>
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
                  <TableCell className="text-right tabular-nums">{formatCurrency(l.costPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(l.lineTotal)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pagos aplicados</p>
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
                <TableCell colSpan={3} className="py-4 text-center text-sm text-muted-foreground">Sin pagos aplicados</TableCell>
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

function SupplierDetail({ supplierId, onBack }: { supplierId: string; onBack: () => void }) {
  const canWrite = useCanWrite()
  const canPagar = usePermission('manage_supplier_accounts') && canWrite
  const statementQuery = useQuery({
    queryKey: ['supplierStatement', supplierId],
    queryFn: () => api.supplierAccounts.getStatement(supplierId),
  })
  const openQuery = useQuery({
    queryKey: ['supplierOpen', supplierId],
    queryFn: () => api.supplierAccounts.listOpenBySupplier(supplierId),
  })
  const [pagando, setPagando] = useState<SupplierAccountPayableDTO | null>(null)
  const [pagandoCuenta, setPagandoCuenta] = useState(false)
  const [pagandoPeriodo, setPagandoPeriodo] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Filtro de movimientos por rango de fechas (YYYY-MM-DD; vacío = sin límite).
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const companyQuery = useCompany()
  const methodsQuery = usePaymentMethods()
  const printerCfgQuery = useQuery({
    queryKey: ['hardwarePrinterConfig'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })
  const pmNameById = useMemo(
    () => new Map((methodsQuery.data ?? []).map((m) => [m.id, m.name])),
    [methodsQuery.data],
  )

  const supplier = statementQuery.data?.supplier
  const name = supplier ? `${supplier.code} — ${supplier.name}` : '…'
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
  const periodCharges = useMemo(() => filteredEntries.reduce((n, e) => n + Number(e.debit || 0), 0), [filteredEntries])
  const periodPayments = useMemo(() => filteredEntries.reduce((n, e) => n + Number(e.credit || 0), 0), [filteredEntries])
  const periodNet = Math.max(0, periodCharges - periodPayments)
  const periodPagable = Math.min(periodNet, Number(balance))

  /** Comprobante del período: se imprime tras registrar el pago del rango. */
  function printPeriodReceipt(info: { amount: number; payments: { paymentMethodId: string; amount: string }[] }): void {
    const company = companyQuery.data
    if (!company || filteredEntries.length === 0) return
    const methodLabel =
      info.payments.length <= 1
        ? (pmNameById.get(info.payments[0]?.paymentMethodId ?? '') ?? 'Pago')
        : info.payments.map((pm) => pmNameById.get(pm.paymentMethodId) ?? '—').join(' + ')
    const MAX_LINES = 40
    const lines = filteredEntries.slice(0, MAX_LINES).map((e) => ({
      date: e.date,
      label: e.kind === 'purchase' ? (e.reference || 'Compra') : `Pago ${e.paymentMethodName ?? ''}`.trim(),
      amount: Number(e.debit) > 0 ? e.debit : e.credit,
    }))
    if (filteredEntries.length > MAX_LINES)
      lines.push({ date: toMs ?? Date.now(), label: `… y ${filteredEntries.length - MAX_LINES} mov. más`, amount: '0' })
    const data: PaymentReceiptData = {
      company,
      customerName: name,
      customerDoc: supplier?.cuit ? `CUIT ${supplier.cuit}` : null,
      date: Date.now(),
      paymentMethod: methodLabel,
      amount: info.amount.toFixed(2),
      comprobanteRef: null,
      comprobanteBalance: null,
      accountBalance: Math.max(0, Number(balance) - info.amount).toFixed(2),
      title: 'COMPROBANTE DE PAGO',
      partyLabel: 'Proveedor',
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

  // Recibo individual de un pago al proveedor (Imprimir / Exportar PDF).
  function receiptDataFor(e: (typeof filteredEntries)[number]): PaymentReceiptData | null {
    const company = companyQuery.data
    if (!company) return null
    return {
      company,
      customerName: name,
      customerDoc: null,
      date: e.date,
      paymentMethod: e.paymentMethodName ?? 'Pago',
      amount: e.credit,
      comprobanteRef: e.kind === 'payment' && e.reference ? e.reference : null,
      comprobanteBalance: e.comprobanteBalance ?? null,
      accountBalance: e.runningBalance,
      title: 'COMPROBANTE DE PAGO',
      partyLabel: 'Proveedor',
    }
  }

  function printReceipt(e: (typeof filteredEntries)[number]): void {
    const data = receiptDataFor(e)
    if (data) void printPaymentReceiptSilent(data, printerCfgQuery.data ?? null)
  }

  function exportPdf(e: (typeof filteredEntries)[number]): void {
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
              <WhatsAppButton phone={supplier?.mobile ?? supplier?.phone} />
            </h1>
            {supplier?.cuit && (
              <p className="text-xs text-muted-foreground">CUIT: {supplier.cuit}</p>
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
            disabled={!canPagar || !hasBalance}
            title={
              !canPagar
                ? 'Requiere permiso para pagar'
                : !hasBalance
                  ? 'El proveedor no tiene saldo pendiente'
                  : undefined
            }
            onClick={() => setPagandoCuenta(true)}
          >
            Registrar pago
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
                (openQuery.data ?? []).map((ap) => {
                  const isOpen = expandedId === ap.id
                  return (
                    <Fragment key={ap.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpandedId(isOpen ? null : ap.id)}
                      >
                        <TableCell className="text-muted-foreground">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(ap.createdAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(ap.total)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{formatCurrency(ap.balance)}</TableCell>
                        <TableCell>
                          <Badge variant={ap.status === 'partial' ? 'warning' : 'outline'}>{ap.status === 'partial' ? 'Parcial' : 'Abierto'}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canPagar}
                            title={canPagar ? undefined : 'Requiere permiso para pagar'}
                            onClick={(e) => { e.stopPropagation(); setPagando(ap) }}
                          >
                            Pagar
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={6} className="p-0">
                            <ComprobanteDetalle accountId={ap.id} />
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
              <Label htmlFor="ccp-desde" className="text-xs text-muted-foreground">Desde</Label>
              <Input id="ccp-desde" type="date" className="h-7 w-[135px] px-2 text-xs" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              <Label htmlFor="ccp-hasta" className="text-xs text-muted-foreground">Hasta</Label>
              <Input id="ccp-hasta" type="date" className="h-7 w-[135px] px-2 text-xs" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
                <span>Compras del período: <b>{formatCurrency(periodCharges)}</b></span>
                <span>Pagos: <b className="text-success">{formatCurrency(periodPayments)}</b></span>
                <span>Total del período: <b>{formatCurrency(periodNet)}</b></span>
              </div>
              <Button
                size="sm"
                disabled={!canPagar || periodPagable <= 0.005 || filteredEntries.length === 0}
                title={
                  !canPagar
                    ? 'Requiere permiso para pagar'
                    : periodPagable <= 0.005
                      ? 'No hay importe pendiente en el período'
                      : `Registrar un pago por ${formatCurrency(periodPagable)} y emitir el comprobante con el detalle`
                }
                onClick={() => setPagandoPeriodo(true)}
              >
                <ReceiptText className="h-4 w-4" />
                Pagar período
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
                      {e.kind === 'purchase'
                        ? 'Compra'
                        : e.kind === 'return'
                          ? 'Devolución'
                          : e.comprobanteBalance != null && Number(e.comprobanteBalance) <= 0.005
                            ? 'Pago total'
                            : 'Pago parcial'}
                    </TableCell>
                    <TableCell className="text-sm">{e.kind === 'purchase' ? 'Cuenta corriente' : e.kind === 'return' ? 'Crédito en cuenta' : (e.paymentMethodName ?? '—')}</TableCell>
                    <TableCell className={`text-right tabular-nums ${e.kind === 'payment' ? 'text-success' : ''}`}>
                      {formatCurrency(Number(e.debit) > 0 ? e.debit : e.credit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(e.runningBalance)}</TableCell>
                    <TableCell className="text-right">
                      {e.kind === 'payment' && (
                        <span className="inline-flex items-center">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Imprimir comprobante de pago"
                            disabled={!companyQuery.data}
                            onClick={() => printReceipt(e)}
                          >
                            <ReceiptText className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            title="Exportar comprobante como PDF"
                            disabled={!companyQuery.data}
                            onClick={() => exportPdf(e)}
                          >
                            <FileDown className="h-4 w-4" />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {pagando && <PagoDialog account={pagando} supplierId={supplierId} onClose={() => setPagando(null)} />}
      {pagandoCuenta && (
        <PagoCuentaDialog
          supplierId={supplierId}
          totalBalance={balance}
          onClose={() => setPagandoCuenta(false)}
        />
      )}
      {pagandoPeriodo && (
        <PagoCuentaDialog
          supplierId={supplierId}
          totalBalance={balance}
          initialAmount={periodPagable.toFixed(2)}
          contextNote={`Pago del período ${fromDate ? formatDate(fromMs!) : 'inicio'} al ${toDate ? formatDate(toMs!) : 'hoy'} — ${filteredEntries.length} movimiento(s). Al confirmar se imprime el comprobante con el detalle.`}
          onPaid={printPeriodReceipt}
          onClose={() => setPagandoPeriodo(false)}
        />
      )}
    </div>
  )
}

export function CuentasCorrientesProveedores() {
  const balances = useSupplierBalances()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (selectedId) {
    return <SupplierDetail supplierId={selectedId} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proveedor</TableHead>
                <TableHead className="text-right">Comprobantes</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {balances.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">Cargando…</TableCell>
                </TableRow>
              ) : (balances.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                    <Truck className="mx-auto mb-2 h-7 w-7 opacity-40" />
                    No hay proveedores con saldo pendiente.
                  </TableCell>
                </TableRow>
              ) : (
                (balances.data ?? []).map((b) => (
                  <TableRow key={b.supplierId} className="cursor-pointer" onClick={() => setSelectedId(b.supplierId)}>
                    <TableCell className="font-medium">{b.supplierName}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.openInvoicesCount}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatCurrency(b.totalDebt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <WhatsAppButton phone={b.phone} />
                        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(b.supplierId) }}>
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
