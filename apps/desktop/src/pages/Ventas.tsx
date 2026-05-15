import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, QrCode, Search, ShoppingCart, Trash2, Wallet, X } from 'lucide-react'

import { api } from '@/lib/api'
import {
  useArticles,
  useCompany,
  useCreateSale,
  useCurrentCash,
  useCustomerBalances,
  useCustomers,
  usePaymentMethods,
} from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePrintSaleTicket } from '@/lib/usePrint'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
import { calculateSaleTotals, lineTotal, resolvePrice, vatBreakdown } from '@/lib/pricing'
import { formatCurrency, formatDate, formatNumber, parseCurrencyInput } from '@/lib/format'
import type { SaleTicketData, SaleTicketLine, SaleTicketPayment } from '@/print/SaleTicket'
import { PaymentSplitInput } from '@/components/PaymentSplitInput'
import { PaymentMethodSelect } from '@/components/PaymentMethodSelect'
import { WeightDialog } from '@/components/WeightDialog'
import { CobroQrModal } from '@/components/CobroQrModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useQuery } from '@tanstack/react-query'
import type { ArticleDTO, CompanyDTO, CreateSaleResultDTO, CustomerDTO, PriceMode, SaleTicketDataDTO, VoucherType } from '@/types/api'

interface CartLine {
  article: ArticleDTO
  quantity: string
  unitPrice: string
  discount: string
  priceManuallySet: boolean
}

const VOUCHER_OPTIONS: { value: VoucherType; label: string }[] = [
  { value: 'B', label: 'Factura B' },
  { value: 'A', label: 'Factura A' },
  { value: 'C', label: 'Factura C' },
  { value: 'X', label: 'Comprobante X' },
]

/** Imprimir el ticket automáticamente al confirmar la venta (sin pasar por el toast). */
const AUTO_PRINT_TICKET = false

function isCfCustomer(c: CustomerDTO | null): boolean {
  return c == null || c.lastName.toUpperCase() === 'CONSUMIDOR FINAL' || c.docType === 'CF'
}

function CustomerPicker({
  open,
  customers,
  onClose,
  onSelect,
}: {
  open: boolean
  customers: CustomerDTO[]
  onClose: () => void
  onSelect: (c: CustomerDTO) => void
}) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    const base = [...customers].sort((a, b) => a.lastName.localeCompare(b.lastName))
    if (!term) return base.slice(0, 50)
    return base
      .filter((c) =>
        `${c.lastName} ${c.firstName ?? ''} ${c.docNumber ?? ''}`.toLowerCase().includes(term),
      )
      .slice(0, 50)
  }, [customers, q])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Seleccionar cliente</DialogTitle>
        </DialogHeader>
        <Input autoFocus placeholder="Buscar por apellido, nombre o documento…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-72 overflow-auto rounded-md border">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Sin resultados</div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span>
                  {c.lastName}
                  {c.firstName ? `, ${c.firstName}` : ''}
                </span>
                <span className="text-xs text-muted-foreground">{c.docNumber ? `${c.docType ?? ''} ${c.docNumber}` : c.category}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NoCash() {
  const navigate = useNavigate()
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 pt-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Wallet className="h-7 w-7" />
          </div>
          <p className="text-base font-medium">No hay caja abierta</p>
          <p className="text-sm text-muted-foreground">Para registrar ventas primero hay que abrir la caja.</p>
          <Button onClick={() => navigate('/caja')}>Ir a Caja</Button>
        </CardContent>
      </Card>
    </div>
  )
}

const FALLBACK_COMPANY: CompanyDTO = {
  id: '', name: 'StockFlow', address: null, phone: null, email: null, cuit: null, ingBrutos: null, priceMode: 'gross', createdAt: 0, updatedAt: 0,
}

function PDV() {
  const { currentUser } = useAuth()
  const canWrite = useCanWrite()
  const articlesQuery = useArticles()
  const customersQuery = useCustomers()
  const balancesQuery = useCustomerBalances()
  const paymentMethodsQuery = usePaymentMethods()
  const companyQuery = useCompany()
  const createSale = useCreateSale()
  const printSaleTicket = usePrintSaleTicket()
  const printerConfigQuery = useQuery({
    queryKey: ['hardwarePrinterConfig'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })
  const currentCashQuery = useCurrentCash()
  const currentCashRegisterId = currentCashQuery.data?.id ?? null
  const mpConfigQuery = useQuery({
    queryKey: ['mpQr', 'config'],
    queryFn: () => api.mpQr.getConfig(),
    staleTime: 60_000,
  })
  const mpPosDevicesQuery = useQuery({
    queryKey: ['mpQr', 'posDevices'],
    queryFn: () => api.mpQr.listPosDevices(),
    staleTime: 60_000,
  })

  const priceMode: PriceMode = companyQuery.data?.priceMode ?? 'gross'
  const allArticles = useMemo(() => (articlesQuery.data ?? []).filter((a) => a.active), [articlesQuery.data])
  const customers = useMemo(() => customersQuery.data ?? [], [customersQuery.data])
  const activeMethods = useMemo(() => (paymentMethodsQuery.data ?? []).filter((m) => m.active), [paymentMethodsQuery.data])
  const methodNameById = useMemo(() => new Map(activeMethods.map((m) => [m.id, m.name])), [activeMethods])
  const cfCustomer = useMemo(() => customers.find((c) => c.lastName.toUpperCase() === 'CONSUMIDOR FINAL'), [customers])
  const [today] = useState(() => formatDate(Date.now()))

  // null = sin selección explícita → se usa Consumidor Final por defecto
  const [customerId, setCustomerId] = useState<string | null>(null)
  const selectedCustomer = (customerId != null ? customers.find((c) => c.id === customerId) : null) ?? cfCustomer ?? null
  const effectiveCustomerId = selectedCustomer?.id
  const customerDebt = (balancesQuery.data ?? []).find((b) => b.customerId === effectiveCustomerId)?.totalDebt ?? '0'
  const isCF = isCfCustomer(selectedCustomer)

  const [voucherType, setVoucherType] = useState<VoucherType>('B')
  const numberQuery = useQuery({
    queryKey: ['sales', 'nextNumber', voucherType],
    queryFn: () => api.sales.getNextNumber(voucherType),
  })

  const [cart, setCart] = useState<CartLine[]>([])
  const [globalDiscount, setGlobalDiscount] = useState('0')
  const [isAccountSale, setIsAccountSale] = useState(false)
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [barcode, setBarcode] = useState('')
  const barcodeRef = useRef<HTMLInputElement>(null)
  // Medio de pago seleccionado en modo mono-medio (default: efectivo).
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  // Modo mixto explícito (toggle "Pago Mixto"): expone el split N-filas.
  const [mixedMode, setMixedMode] = useState(false)

  useEffect(() => {
    barcodeRef.current?.focus()
  }, [])

  // Inicializar / corregir el medio de pago mono-medio default (efectivo físico).
  // Pattern de "derivar estado de props" recomendado por React: setState durante render.
  if (
    activeMethods.length > 0 &&
    (!selectedMethodId || !activeMethods.some((m) => m.id === selectedMethodId))
  ) {
    const fallback =
      activeMethods.find((m) => m.type === 'cash') ??
      activeMethods.find((m) => m.isPhysicalCash) ??
      activeMethods[0]
    setSelectedMethodId(fallback?.id ?? null)
  }

  const totals = calculateSaleTotals(
    cart.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, vatRate: l.article.vatRate })),
    parseCurrencyInput(globalDiscount),
    priceMode,
  )
  const totalNum = Number(totals.total)

  // cuenta corriente sólo disponible si el cliente no es Consumidor Final
  const accountSale = isAccountSale && !isCF
  const split = usePaymentSplit(activeMethods, totalNum)

  // --- carrito ---
  const [pendingWeightArticle, setPendingWeightArticle] = useState<ArticleDTO | null>(null)
  function addArticle(article: ArticleDTO): void {
    if (article.soldByWeight) {
      setPendingWeightArticle(article)
      return
    }
    addArticleWithQty(article, '1')
  }
  function addArticleWithQty(article: ArticleDTO, qty: string): void {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.article.id === article.id)
      if (idx >= 0) {
        const next = [...prev]
        const line = next[idx]!
        const newQty = (Number(line.quantity) + Number(qty)).toString()
        next[idx] = {
          ...line,
          quantity: newQty,
          unitPrice: line.priceManuallySet ? line.unitPrice : resolvePrice(article, selectedCustomer, newQty),
        }
        return next
      }
      return [
        ...prev,
        { article, quantity: qty, unitPrice: resolvePrice(article, selectedCustomer, qty), discount: '0', priceManuallySet: false },
      ]
    })
  }
  function removeLine(i: number): void {
    setCart((prev) => prev.filter((_, idx) => idx !== i))
  }
  function setLineQty(i: number, value: string): void {
    setCart((prev) => {
      const next = [...prev]
      const line = next[i]!
      next[i] = {
        ...line,
        quantity: value,
        unitPrice: line.priceManuallySet ? line.unitPrice : resolvePrice(line.article, selectedCustomer, value),
      }
      return next
    })
  }
  function setLinePrice(i: number, value: string): void {
    setCart((prev) => {
      const next = [...prev]
      next[i] = { ...next[i]!, unitPrice: value, priceManuallySet: true }
      return next
    })
  }
  function setLineDiscount(i: number, value: string): void {
    setCart((prev) => {
      const next = [...prev]
      next[i] = { ...next[i]!, discount: value }
      return next
    })
  }
  function clearSale(): void {
    setCart([])
    setGlobalDiscount('0')
    setIsAccountSale(false)
    setMixedMode(false)
    split.reset()
    barcodeRef.current?.focus()
  }
  function pickCustomer(c: CustomerDTO): void {
    setCustomerId(c.id)
    setCustomerPickerOpen(false)
    setCart((prev) => prev.map((l) => (l.priceManuallySet ? l : { ...l, unitPrice: resolvePrice(l.article, c, l.quantity) })))
    if (isCfCustomer(c)) setIsAccountSale(false)
    barcodeRef.current?.focus()
  }

  // --- búsqueda de productos ---
  const exactByBarcode = useMemo(() => {
    const v = barcode.trim()
    return v ? allArticles.find((a) => a.barcode === v) ?? null : null
  }, [barcode, allArticles])
  const suggestions = useMemo(() => {
    const v = barcode.trim().toLowerCase()
    if (v.length < 2 || exactByBarcode) return []
    return allArticles
      .filter((a) => a.barcode.toLowerCase().startsWith(v) || a.description.toLowerCase().includes(v))
      .slice(0, 8)
  }, [barcode, allArticles, exactByBarcode])

  function commitBarcode(): void {
    const v = barcode.trim()
    if (!v) return
    if (exactByBarcode) {
      addArticle(exactByBarcode)
    } else if (suggestions.length > 0) {
      addArticle(suggestions[0]!)
    } else {
      toast.error('No se encontró el producto')
      return
    }
    setBarcode('')
    barcodeRef.current?.focus()
  }

  // --- cuenta corriente ---
  const accountEligible =
    selectedCustomer != null &&
    selectedCustomer.docType != null &&
    selectedCustomer.docType !== 'CF' &&
    !!selectedCustomer.docNumber
  const creditLimitNum = Number(selectedCustomer?.creditLimit ?? '0')
  const overCredit = accountSale && creditLimitNum > 0 && Number(customerDebt) + totalNum > creditLimitNum
  const noMethods = !accountSale && activeMethods.length === 0

  // --- MercadoPago QR ---
  const mpConfigured = mpConfigQuery.data?.configured === true
  const mpPosDeviceForCurrentCash = useMemo(() => {
    const list = mpPosDevicesQuery.data ?? []
    if (!currentCashRegisterId) return null
    return list.find((d) => d.cashRegisterId === currentCashRegisterId && d.active) ?? null
  }, [mpPosDevicesQuery.data, currentCashRegisterId])
  const mpMethod = useMemo(() => {
    const methods = activeMethods
    return (
      methods.find((m) => m.type === 'mp' && m.name.toLowerCase().includes('qr')) ??
      methods.find((m) => m.type === 'mp') ??
      null
    )
  }, [activeMethods])
  const canCobrarQr =
    canWrite &&
    mpConfigured &&
    mpPosDeviceForCurrentCash !== null &&
    mpMethod !== null &&
    cart.length > 0 &&
    totalNum > 0 &&
    !accountSale &&
    !createSale.isPending &&
    effectiveCustomerId != null
  const [qrModalOpen, setQrModalOpen] = useState(false)

  const selectedMethod = useMemo(
    () => activeMethods.find((m) => m.id === selectedMethodId) ?? null,
    [activeMethods, selectedMethodId],
  )

  const canConfirm =
    canWrite &&
    cart.length > 0 &&
    totalNum > 0 &&
    effectiveCustomerId != null &&
    !createSale.isPending &&
    (accountSale
      ? accountEligible && !overCredit
      : mixedMode
        ? split.isComplete && activeMethods.length > 0
        : selectedMethod != null)

  function buildTicket(result: CreateSaleResultDTO): SaleTicketData {
    const customer = selectedCustomer
    const cf = isCfCustomer(customer)
    const descById = new Map(cart.map((l) => [l.article.id, l.article.description]))
    const lines: SaleTicketLine[] = result.lines.map((l) => ({
      description: descById.get(l.articleId) ?? '—',
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    }))
    const ticketPayments: SaleTicketPayment[] = result.payments.map((p) => ({
      methodName: methodNameById.get(p.paymentMethodId) ?? 'Medio de pago',
      amount: p.amount,
    }))
    return {
      company: companyQuery.data ?? FALLBACK_COMPANY,
      sale: result.sale,
      priceMode,
      lines,
      customerName:
        cf || !customer ? null : `${customer.lastName}${customer.firstName ? `, ${customer.firstName}` : ''}`,
      customerDoc: !cf && customer?.docNumber ? `${customer.docType ?? ''} ${customer.docNumber}`.trim() : null,
      isAccountSale: result.sale.isAccountSale,
      payments: ticketPayments,
    }
  }

  async function confirmar(): Promise<void> {
    if (!effectiveCustomerId || !canConfirm) return
    // Si el modo mono-medio elige MercadoPago QR, derivar al modal de cobro QR.
    if (!accountSale && !mixedMode && selectedMethod?.type === 'mp' && canCobrarQr) {
      setQrModalOpen(true)
      return
    }
    const monoPayments =
      !accountSale && !mixedMode && selectedMethod
        ? [{ paymentMethodId: selectedMethod.id, amount: totalNum.toFixed(4) }]
        : null
    const paymentsToSend = accountSale ? [] : (monoPayments ?? split.payments)
    try {
      const result = await createSale.mutateAsync({
        type: voucherType,
        customerId: effectiveCustomerId,
        isAccountSale: accountSale,
        payments: paymentsToSend,
        discount: parseCurrencyInput(globalDiscount),
        notes: null,
        lines: cart.map((l) => ({
          articleId: l.article.id,
          quantity: parseCurrencyInput(l.quantity),
          unitPrice: parseCurrencyInput(l.unitPrice),
          discount: parseCurrencyInput(l.discount),
          vatRate: l.article.vatRate,
        })),
      })
      const ticketData = buildTicket(result)
      const printerCfg = printerConfigQuery.data ?? null
      let printedViaHardware = false
      if (printerCfg) {
        const company = companyQuery.data ?? FALLBACK_COMPANY
        const hwTicket: SaleTicketDataDTO = {
          number: result.sale.number,
          voucherType: result.sale.type,
          createdAt: result.sale.createdAt,
          company: {
            name: company.name,
            cuit: company.cuit,
            address: company.address,
            phone: company.phone,
            ingBrutos: company.ingBrutos,
          },
          customer: ticketData.customerName
            ? { name: ticketData.customerName, docNumber: ticketData.customerDoc }
            : null,
          lines: result.lines.map((l) => ({
            description: ticketData.lines.find((tl) => tl.unitPrice === l.unitPrice && tl.quantity === l.quantity)?.description ?? '—',
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            total: l.lineTotal,
          })),
          subtotal: totals.subtotal,
          vatTotal: totals.vatAmount,
          total: result.sale.total,
          payments: result.payments.map((p) => ({
            method: methodNameById.get(p.paymentMethodId) ?? 'Medio de pago',
            amount: p.amount,
          })),
          accountSale: result.sale.isAccountSale,
        }
        try {
          await api.hardware.printer.printSaleTicket(hwTicket)
          printedViaHardware = true
        } catch {
          toast.warning('Impresora no disponible — usá "Imprimir" para imprimir desde pantalla')
        }
        if (printerCfg.autoOpenDrawer && !result.sale.isAccountSale) {
          const cashMethodId = activeMethods.find((m) => m.type === 'cash')?.id
          const hasCash = cashMethodId != null && result.payments.some((p) => p.paymentMethodId === cashMethodId && Number(p.amount) > 0)
          if (hasCash) {
            api.hardware.cashDrawer.open().catch(() => {})
          }
        }
      }
      toast.success(
        `Venta ${result.sale.type} #${result.sale.number} registrada — Total ${formatCurrency(result.sale.total)}`,
        printedViaHardware ? undefined : { action: { label: 'Imprimir', onClick: () => printSaleTicket(ticketData) } },
      )
      if (!printedViaHardware && AUTO_PRINT_TICKET) printSaleTicket(ticketData)
      clearSale()
      void numberQuery.refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar la venta')
    }
  }

  async function confirmarConQrAprobado(orderId: string, mpPaymentId: string | null): Promise<void> {
    if (!effectiveCustomerId || !mpMethod) {
      setQrModalOpen(false)
      return
    }
    try {
      const result = await createSale.mutateAsync({
        type: voucherType,
        customerId: effectiveCustomerId,
        isAccountSale: false,
        payments: [{ paymentMethodId: mpMethod.id, amount: totalNum.toFixed(4) }],
        discount: parseCurrencyInput(globalDiscount),
        notes: mpPaymentId ? `MP Payment ID: ${mpPaymentId}` : null,
        lines: cart.map((l) => ({
          articleId: l.article.id,
          quantity: parseCurrencyInput(l.quantity),
          unitPrice: parseCurrencyInput(l.unitPrice),
          discount: parseCurrencyInput(l.discount),
          vatRate: l.article.vatRate,
        })),
      })
      await api.mpQr.linkOrderToSale(orderId, result.sale.id).catch(() => {})
      toast.success(
        `Venta ${result.sale.type} #${result.sale.number} cobrada con MercadoPago QR — ${formatCurrency(result.sale.total)}`,
      )
      clearSale()
      void numberQuery.refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar la venta')
    } finally {
      setQrModalOpen(false)
    }
  }

  // Atajos globales del PDV (fase de captura, para ganarle al handler de F-keys del Layout).
  // Sin deps: se re-suscribe en cada render para que el closure vea siempre el estado vigente.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return
      if (e.key === 'F2') {
        e.preventDefault()
        e.stopPropagation()
        if (canConfirm) void confirmar()
        return
      }
      if (e.key === 'F4' && !mixedMode && !accountSale && activeMethods.length > 1) {
        e.preventDefault()
        e.stopPropagation()
        const idx = activeMethods.findIndex((m) => m.id === selectedMethodId)
        const next = activeMethods[(idx + 1) % activeMethods.length]
        if (next) setSelectedMethodId(next.id)
        return
      }
      if (e.key === 'F12' && !accountSale && activeMethods.length > 1) {
        e.preventDefault()
        e.stopPropagation()
        setMixedMode((m) => !m)
        return
      }
      if (e.key === 'Escape' && barcode.trim() === '' && cart.length > 0) {
        if (window.confirm('¿Vaciar la venta actual?')) clearSale()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  })

  return (
    <div className="flex h-full flex-col gap-3">
      {/* ── Zona superior: encabezado de la venta ── */}
      <div className="grid grid-cols-4 gap-3 rounded-lg border bg-card p-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Label>Cliente</Label>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="flex-1 justify-between" onClick={() => setCustomerPickerOpen(true)}>
              <span className="truncate">
                {selectedCustomer ? `${selectedCustomer.lastName}${selectedCustomer.firstName ? `, ${selectedCustomer.firstName}` : ''}` : 'Cargando…'}
              </span>
              <Search className="h-4 w-4 shrink-0 opacity-60" />
            </Button>
          </div>
          {selectedCustomer && (selectedCustomer.docNumber || Number(customerDebt) > 0) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {selectedCustomer.docNumber && <span>{selectedCustomer.docType} {selectedCustomer.docNumber}</span>}
              {Number(customerDebt) > 0 && <Badge variant="warning">Saldo {formatCurrency(customerDebt)}</Badge>}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label>Comprobante</Label>
          <Select value={voucherType} onChange={(e) => setVoucherType(e.target.value as VoucherType)}>
            {VOUCHER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label>N°</Label>
            <Input readOnly value={numberQuery.data?.number ?? '—'} className="bg-muted tabular-nums" />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Fecha</Label>
            <Input readOnly value={today} className="bg-muted" />
          </div>
        </div>
        <div className="col-span-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>Vendedor: {currentUser?.fullName}</span>
          <Badge variant={priceMode === 'gross' ? 'outline' : 'warning'}>
            Modo: Precios {priceMode === 'gross' ? 'con IVA incluido' : 'netos + IVA'}
          </Badge>
        </div>
      </div>

      {/* ── Zona central: carrito ── */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="relative">
          <ShoppingCart className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={barcodeRef}
            className="h-11 pl-10 text-base"
            placeholder="Código o nombre del producto — escaneá o escribí y Enter"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitBarcode()
              if (e.key === 'Escape' && barcode.trim() !== '') setBarcode('')
            }}
          />
          {suggestions.length > 0 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
              {suggestions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    addArticle(a)
                    setBarcode('')
                    barcodeRef.current?.focus()
                  }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">
                    <span className="font-mono text-xs text-muted-foreground">{a.barcode}</span> · {a.description}
                  </span>
                  <span className="ml-2 shrink-0 tabular-nums">{formatCurrency(resolvePrice(a, selectedCustomer, '1'))}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5">Producto</th>
                <th className="w-24 px-2 py-1.5 text-right">Cantidad</th>
                <th className="w-28 px-2 py-1.5 text-right">{priceMode === 'gross' ? 'P. unit. (c/IVA)' : 'P. unit. (neto)'}</th>
                <th className="w-24 px-2 py-1.5 text-right">Desc.</th>
                <th className="w-28 px-2 py-1.5 text-right">{priceMode === 'gross' ? 'Subtotal' : 'Subtotal neto'}</th>
                <th className="w-8 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {cart.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    Carrito vacío — escaneá o buscá un producto para empezar.
                  </td>
                </tr>
              ) : (
                cart.map((l, i) => {
                  const overStock = Number(l.quantity) > Number(l.article.stock)
                  return (
                    <tr key={l.article.id} className="border-t">
                      <td className="px-2 py-1">
                        <div className="font-medium">{l.article.description}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {l.article.barcode}
                          {overStock && <span className="ml-2 text-destructive">Stock: {formatNumber(l.article.stock, 3)}</span>}
                        </div>
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          className="h-8 text-right tabular-nums"
                          inputMode="decimal"
                          value={l.quantity}
                          onChange={(e) => setLineQty(i, e.target.value)}
                          onBlur={() => setLineQty(i, parseCurrencyInput(l.quantity))}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          className="h-8 text-right tabular-nums"
                          inputMode="decimal"
                          value={l.unitPrice}
                          onChange={(e) => setLinePrice(i, e.target.value)}
                          onBlur={() => setLinePrice(i, parseCurrencyInput(l.unitPrice))}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          className="h-8 text-right tabular-nums"
                          inputMode="decimal"
                          value={l.discount}
                          onChange={(e) => setLineDiscount(i, e.target.value)}
                          onBlur={() => setLineDiscount(i, parseCurrencyInput(l.discount))}
                        />
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums font-medium">
                        {formatCurrency(lineTotal(l))}
                        {priceMode === 'net' && (
                          <div className="text-[10px] font-normal text-muted-foreground">
                            c/IVA {formatCurrency(vatBreakdown(lineTotal(l), l.article.vatRate, 'net').gross.toFixed(4))}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(i)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Zona inferior: totales + pago ── */}
      <div className="grid grid-cols-3 gap-3 rounded-lg border bg-card p-3">
        {/* totales */}
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{priceMode === 'gross' ? 'Subtotal (con IVA)' : 'Subtotal neto'}</span>
            <span className="tabular-nums">{formatCurrency(totals.subtotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Descuento</span>
            <Input
              className="h-7 w-28 text-right tabular-nums"
              inputMode="decimal"
              value={globalDiscount}
              onChange={(e) => setGlobalDiscount(e.target.value)}
              onBlur={() => setGlobalDiscount(parseCurrencyInput(globalDiscount))}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{priceMode === 'gross' ? 'IVA contenido' : 'IVA'}</span>
            <span className="tabular-nums">{formatCurrency(totals.vatAmount)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between border-t pt-1">
            <span className="font-semibold">TOTAL</span>
            <span className="text-2xl font-bold tabular-nums">{formatCurrency(totals.total)}</span>
          </div>
        </div>

        {/* pago */}
        <div className="flex flex-col gap-2">
          {!isCF && (
            <label className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input"
                checked={isAccountSale}
                onChange={(e) => setIsAccountSale(e.target.checked)}
              />
              <span>Venta a cuenta corriente</span>
            </label>
          )}
          {accountSale ? (
            <div className="text-xs">
              {!accountEligible ? (
                <p className="text-destructive">El cliente no puede operar en cuenta corriente (falta documento identificatorio).</p>
              ) : overCredit ? (
                <p className="text-destructive">Se supera el límite de crédito ({formatCurrency(selectedCustomer!.creditLimit)}).</p>
              ) : (
                <p className="text-muted-foreground">
                  Queda en cuenta corriente. Saldo actual: {formatCurrency(customerDebt)} → {formatCurrency((Number(customerDebt) + totalNum).toFixed(4))}.
                </p>
              )}
            </div>
          ) : noMethods ? (
            <p className="text-xs text-destructive">
              No hay medios de pago configurados.{' '}
              <Link to="/medios-de-pago" className="font-medium underline">
                Configurar medios de pago
              </Link>
            </p>
          ) : mixedMode ? (
            <>
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Pago mixto
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => {
                    setMixedMode(false)
                    split.reset()
                  }}
                >
                  Volver a pago único
                </Button>
              </div>
              <PaymentSplitInput methods={activeMethods} split={split} />
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="pdv-method">Forma de pago</Label>
                <PaymentMethodSelect
                  id="pdv-method"
                  methods={activeMethods}
                  value={selectedMethodId}
                  onChange={setSelectedMethodId}
                />
              </div>
              {activeMethods.length > 1 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setMixedMode(true)}
                >
                  Pago mixto (F12)
                </Button>
              )}
            </>
          )}
        </div>

        {/* confirmar */}
        <div className="flex flex-col justify-end gap-2">
          {canCobrarQr && (
            <Button
              className="h-11 bg-sky-500 text-white hover:bg-sky-600"
              onClick={() => setQrModalOpen(true)}
            >
              <QrCode className="mr-2 h-5 w-5" />
              Cobrar con QR MercadoPago — {formatCurrency(totals.total)}
            </Button>
          )}
          <Button
            variant="success"
            className="h-14 text-lg"
            disabled={!canConfirm}
            onClick={() => void confirmar()}
          >
            {createSale.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
            Confirmar venta (F2) — {formatCurrency(totals.total)}
          </Button>
          {cart.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearSale} disabled={createSale.isPending}>
              <X className="h-4 w-4" />
              Vaciar venta
            </Button>
          )}
        </div>
      </div>

      <CustomerPicker open={customerPickerOpen} customers={customers} onClose={() => setCustomerPickerOpen(false)} onSelect={pickCustomer} />
      <WeightDialog
        open={pendingWeightArticle != null}
        articleDescription={pendingWeightArticle?.description}
        onClose={() => setPendingWeightArticle(null)}
        onConfirm={(weightKg) => {
          if (pendingWeightArticle) addArticleWithQty(pendingWeightArticle, weightKg)
        }}
      />
      {qrModalOpen && currentCashRegisterId && (
        <CobroQrModal
          open={qrModalOpen}
          amount={totals.total}
          cashRegisterId={currentCashRegisterId}
          description={`Venta ${voucherType} #${numberQuery.data?.number ?? '?'}`}
          onApproved={(orderId, mpPaymentId) => void confirmarConQrAprobado(orderId, mpPaymentId)}
          onCancelled={() => setQrModalOpen(false)}
          onClose={() => setQrModalOpen(false)}
        />
      )}
    </div>
  )
}

export function Ventas() {
  const current = useCurrentCash()
  if (current.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return current.data ? <PDV /> : <NoCash />
}
