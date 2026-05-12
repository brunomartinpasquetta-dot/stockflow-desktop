import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, Search, ShoppingCart, Trash2, Wallet, X } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useArticles, useCards, useCreateSale, useCurrentCash, useCustomerBalances, useCustomers } from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { usePrintSaleTicket } from '@/lib/usePrint'
import { calculateSaleTotals, lineTotal, resolvePrice } from '@/lib/pricing'
import { formatCurrency, formatDate, formatNumber, parseCurrencyInput } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { SaleTicketData, SaleTicketLine } from '@/print/SaleTicket'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useQuery } from '@tanstack/react-query'
import type { ArticleDTO, CompanyDTO, CreateSaleResultDTO, CustomerDTO, VoucherType } from '@/types/api'

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

const PAYMENT_LABELS: Record<'cash' | 'card' | 'mixed' | 'account', string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  mixed: 'Mixto',
  account: 'Cuenta corriente',
}

/** Imprimir el ticket automáticamente al confirmar la venta (sin pasar por el toast). */
const AUTO_PRINT_TICKET = false

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

function PDV() {
  const { currentUser } = useAuth()
  const articlesQuery = useArticles()
  const customersQuery = useCustomers()
  const balancesQuery = useCustomerBalances()
  const cardsQuery = useCards()
  const companyQuery = useQuery({ queryKey: ['company'], queryFn: api.company.get })
  const createSale = useCreateSale()
  const printSaleTicket = usePrintSaleTicket()

  const allArticles = useMemo(() => (articlesQuery.data ?? []).filter((a) => a.active), [articlesQuery.data])
  const customers = useMemo(() => customersQuery.data ?? [], [customersQuery.data])
  const activeCards = useMemo(() => (cardsQuery.data ?? []).filter((c) => c.active), [cardsQuery.data])
  const cfCustomer = useMemo(() => customers.find((c) => c.lastName.toUpperCase() === 'CONSUMIDOR FINAL'), [customers])
  const [today] = useState(() => formatDate(Date.now()))

  // null = sin selección explícita → se usa Consumidor Final por defecto
  const [customerId, setCustomerId] = useState<string | null>(null)
  const selectedCustomer = (customerId != null ? customers.find((c) => c.id === customerId) : null) ?? cfCustomer ?? null
  const effectiveCustomerId = selectedCustomer?.id
  const customerDebt = (balancesQuery.data ?? []).find((b) => b.customerId === effectiveCustomerId)?.totalDebt ?? '0'

  const [voucherType, setVoucherType] = useState<VoucherType>('B')
  const numberQuery = useQuery({
    queryKey: ['sales', 'nextNumber', voucherType],
    queryFn: () => api.sales.getNextNumber(voucherType),
  })

  const [cart, setCart] = useState<CartLine[]>([])
  const [globalDiscount, setGlobalDiscount] = useState('0')
  const [paymentType, setPaymentType] = useState<'cash' | 'card' | 'mixed' | 'account'>('cash')
  const [received, setReceived] = useState('')
  const [mixedCard, setMixedCard] = useState('')
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [barcode, setBarcode] = useState('')
  const barcodeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    barcodeRef.current?.focus()
  }, [])

  const totals = calculateSaleTotals(
    cart.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, vatRate: l.article.vatRate })),
    parseCurrencyInput(globalDiscount),
  )
  const totalNum = Number(totals.total)

  // --- carrito ---
  function addArticle(article: ArticleDTO): void {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.article.id === article.id)
      if (idx >= 0) {
        const next = [...prev]
        const line = next[idx]!
        const qty = (Number(line.quantity) + 1).toString()
        next[idx] = {
          ...line,
          quantity: qty,
          unitPrice: line.priceManuallySet ? line.unitPrice : resolvePrice(article, selectedCustomer, qty),
        }
        return next
      }
      return [
        ...prev,
        { article, quantity: '1', unitPrice: resolvePrice(article, selectedCustomer, '1'), discount: '0', priceManuallySet: false },
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
  function pickCustomer(c: CustomerDTO): void {
    setCustomerId(c.id)
    setCustomerPickerOpen(false)
    setCart((prev) => prev.map((l) => (l.priceManuallySet ? l : { ...l, unitPrice: resolvePrice(l.article, c, l.quantity) })))
    if (paymentType === 'account') setPaymentType('cash')
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

  // --- pago ---
  const cardRequired = paymentType === 'card' || paymentType === 'mixed'
  const noCards = cardRequired && activeCards.length === 0
  const effectiveCardId =
    selectedCardId != null && activeCards.some((c) => c.id === selectedCardId)
      ? selectedCardId
      : activeCards[0]?.id ?? null
  const receivedNum = received ? Number(parseCurrencyInput(received)) : 0
  const change = paymentType === 'cash' ? Math.max(0, receivedNum - totalNum) : 0
  const mixedCardNum = mixedCard ? Number(parseCurrencyInput(mixedCard)) : 0
  const mixedCashNum = paymentType === 'mixed' ? Math.max(0, totalNum - mixedCardNum) : 0
  const mixedValid = mixedCardNum > 0 && mixedCardNum < totalNum
  const accountEligible =
    selectedCustomer != null &&
    selectedCustomer.docType != null &&
    selectedCustomer.docType !== 'CF' &&
    !!selectedCustomer.docNumber
  const creditLimitNum = Number(selectedCustomer?.creditLimit ?? '0')
  const overCredit =
    paymentType === 'account' && creditLimitNum > 0 && Number(customerDebt) + totalNum > creditLimitNum

  const canConfirm =
    cart.length > 0 &&
    totalNum > 0 &&
    effectiveCustomerId != null &&
    !createSale.isPending &&
    !(paymentType === 'cash' && receivedNum < totalNum) &&
    !(paymentType === 'account' && (!accountEligible || overCredit)) &&
    !(cardRequired && effectiveCardId == null) &&
    !(paymentType === 'mixed' && !mixedValid)

  const FALLBACK_COMPANY: CompanyDTO = {
    id: '', name: 'StockFlow', address: null, phone: null, email: null, cuit: null, ingBrutos: null, createdAt: 0, updatedAt: 0,
  }

  function buildTicket(result: CreateSaleResultDTO): SaleTicketData {
    const isCF =
      selectedCustomer == null ||
      selectedCustomer.lastName.toUpperCase() === 'CONSUMIDOR FINAL' ||
      selectedCustomer.docType === 'CF'
    const descById = new Map(cart.map((l) => [l.article.id, l.article.description]))
    const lines: SaleTicketLine[] = result.lines.map((l) => ({
      description: descById.get(l.articleId) ?? '—',
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: l.lineTotal,
    }))
    const pt = result.sale.paymentType
    return {
      company: companyQuery.data ?? FALLBACK_COMPANY,
      sale: result.sale,
      lines,
      customerName:
        isCF || !selectedCustomer
          ? null
          : `${selectedCustomer.lastName}${selectedCustomer.firstName ? `, ${selectedCustomer.firstName}` : ''}`,
      customerDoc:
        !isCF && selectedCustomer?.docNumber ? `${selectedCustomer.docType ?? ''} ${selectedCustomer.docNumber}`.trim() : null,
      paymentLabel: PAYMENT_LABELS[pt],
      cardName: pt === 'card' || pt === 'mixed' ? activeCards.find((c) => c.id === result.sale.cardId)?.name ?? null : null,
      received: pt === 'cash' ? receivedNum : null,
      change: pt === 'cash' ? Math.max(0, receivedNum - Number(result.sale.total)) : null,
    }
  }

  async function confirmar(): Promise<void> {
    if (!effectiveCustomerId) return
    try {
      const result = await createSale.mutateAsync({
        type: voucherType,
        customerId: effectiveCustomerId,
        paymentType,
        cardId: cardRequired ? effectiveCardId : null,
        cardAmount:
          paymentType === 'card' ? totals.total : paymentType === 'mixed' ? mixedCardNum.toFixed(4) : '0.0000',
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
      const vuelto = paymentType === 'cash' ? Math.max(0, receivedNum - Number(result.sale.total)) : 0
      // Armamos los datos del ticket ahora (antes de limpiar el estado del PDV).
      const ticketData = buildTicket(result)
      toast.success(
        `Venta ${result.sale.type} #${result.sale.number} registrada — Total ${formatCurrency(result.sale.total)}${vuelto > 0 ? ` — Vuelto ${formatCurrency(vuelto)}` : ''}`,
        { action: { label: 'Imprimir', onClick: () => printSaleTicket(ticketData) } },
      )
      if (AUTO_PRINT_TICKET) printSaleTicket(ticketData)
      setCart([])
      setGlobalDiscount('0')
      setReceived('')
      setMixedCard('')
      setPaymentType('cash')
      void numberQuery.refetch()
      barcodeRef.current?.focus()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION' && err.field === 'cardId') {
        toast.error('Debe seleccionar una tarjeta para este tipo de pago')
        return
      }
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar la venta')
    }
  }

  const PAYMENT_TABS: { value: typeof paymentType; label: string }[] = [
    { value: 'cash', label: 'Efectivo' },
    { value: 'card', label: 'Tarjeta' },
    { value: 'mixed', label: 'Mixto' },
    { value: 'account', label: 'Cuenta corriente' },
  ]

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
        <div className="col-span-4 text-xs text-muted-foreground">Vendedor: {currentUser?.fullName}</div>
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
              if (e.key === 'Escape') setBarcode('')
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
                <th className="w-28 px-2 py-1.5 text-right">P. unitario</th>
                <th className="w-24 px-2 py-1.5 text-right">Desc.</th>
                <th className="w-28 px-2 py-1.5 text-right">Subtotal</th>
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
                      <td className="px-2 py-1 text-right tabular-nums font-medium">{formatCurrency(lineTotal(l))}</td>
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
            <span className="text-muted-foreground">Subtotal</span>
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
            <span>IVA contenido</span>
            <span className="tabular-nums">{formatCurrency(totals.vatAmount)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between border-t pt-1">
            <span className="font-semibold">TOTAL</span>
            <span className="text-2xl font-bold tabular-nums">{formatCurrency(totals.total)}</span>
          </div>
        </div>

        {/* pago */}
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-1">
            {PAYMENT_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setPaymentType(t.value)}
                className={cn(
                  'rounded-md border px-2 py-1.5 text-sm transition-colors',
                  paymentType === t.value ? 'border-primary bg-primary/10 font-medium text-primary' : 'hover:bg-accent',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {paymentType === 'cash' && (
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Recibido</span>
                <Input
                  className="h-8 w-32 text-right tabular-nums"
                  inputMode="decimal"
                  value={received}
                  onChange={(e) => setReceived(e.target.value)}
                  onBlur={() => received && setReceived(parseCurrencyInput(received))}
                />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Vuelto</span>
                <span className="tabular-nums font-medium">{formatCurrency(change)}</span>
              </div>
            </div>
          )}
          {cardRequired && (
            noCards ? (
              <p className="text-xs text-destructive">
                No hay tarjetas configuradas.{' '}
                <Link to="/tarjetas" className="font-medium underline">
                  Crear tarjetas
                </Link>
              </p>
            ) : (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">Tarjeta</span>
                <Select
                  className="h-8 w-44"
                  value={effectiveCardId ?? ''}
                  onChange={(e) => setSelectedCardId(e.target.value || null)}
                >
                  {activeCards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </div>
            )
          )}
          {paymentType === 'card' && !noCards && (
            <p className="text-xs text-muted-foreground">Se cobra {formatCurrency(totals.total)} con tarjeta.</p>
          )}
          {paymentType === 'mixed' && !noCards && (
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">En tarjeta</span>
                <Input
                  className="h-8 w-32 text-right tabular-nums"
                  inputMode="decimal"
                  value={mixedCard}
                  onChange={(e) => setMixedCard(e.target.value)}
                  onBlur={() => mixedCard && setMixedCard(parseCurrencyInput(mixedCard))}
                />
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">En efectivo</span>
                <span className="tabular-nums font-medium">{formatCurrency(mixedCashNum)}</span>
              </div>
              {mixedCard.trim() !== '' && !mixedValid && (
                <p className="text-xs text-destructive">El monto en tarjeta debe ser mayor a 0 y menor al total.</p>
              )}
            </div>
          )}
          {paymentType === 'account' && (
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
          )}
        </div>

        {/* confirmar */}
        <div className="flex flex-col justify-end gap-2">
          <Button
            variant="success"
            className="h-14 text-lg"
            disabled={!canConfirm}
            onClick={() => void confirmar()}
          >
            {createSale.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
            Confirmar venta — {formatCurrency(totals.total)}
          </Button>
          {cart.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setCart([])} disabled={createSale.isPending}>
              <X className="h-4 w-4" />
              Vaciar carrito
            </Button>
          )}
        </div>
      </div>

      <CustomerPicker open={customerPickerOpen} customers={customers} onClose={() => setCustomerPickerOpen(false)} onSelect={pickCustomer} />
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
