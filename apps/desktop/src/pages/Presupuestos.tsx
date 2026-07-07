/**
 * Presupuestos (cotizaciones): registro/listado + creación + conversión en venta.
 *
 * - Lista con filtros (texto / estado) y acciones por presupuesto.
 * - Creación: carrito tipo Ventas pero SIN pagos ni caja (no toca stock).
 * - Detalle: imprimir PDF A4 formal, convertir en venta (eligiendo precio
 *   congelado o actual) o eliminar.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FileText, Loader2, Plus, Printer, Search, ShoppingCart, Trash2, X } from 'lucide-react'

import { api } from '@/lib/api'
import { useArticles, useCompany, useCustomers, useFamilies, usePaymentMethods, useSuppliers } from '@/lib/hooks'
import { useCanWrite } from '@/contexts/LicenseContext'
import { calculateSaleTotals, lineTotal, resolvePrice } from '@/lib/pricing'
import { formatCurrency, formatDate, parseCurrencyInput } from '@/lib/format'
import { articleMatches, buildSearchContext } from '@/lib/articleSearch'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
import { usePrintQuote } from '@/lib/usePrint'
import { PaymentSplitInput } from '@/components/PaymentSplitInput'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type {
  ArticleDTO,
  CustomerDTO,
  PriceMode,
  QuoteDTO,
  QuoteStatus,
  VoucherType,
} from '@/types/api'
import type { FormalDocData } from '@/print/FormalDocA4'

const VOUCHER_OPTIONS: { value: VoucherType; label: string }[] = [
  { value: 'B', label: 'Factura B' },
  { value: 'A', label: 'Factura A' },
  { value: 'C', label: 'Factura C' },
  { value: 'X', label: 'Remito X' },
]

const STATUS_LABEL: Record<QuoteStatus, string> = {
  pending: 'Pendiente',
  accepted: 'Aceptado',
  rejected: 'Rechazado',
  converted: 'Convertido',
}

function quoteNumber(n: number): string {
  return `P-${String(n).padStart(4, '0')}`
}

function customerName(c: CustomerDTO | undefined): string {
  if (!c) return '—'
  return `${c.lastName}${c.firstName ? `, ${c.firstName}` : ''}`
}

function isExpired(q: QuoteDTO): boolean {
  if (q.status === 'converted') return false
  return Date.now() > q.date + q.validityDays * 24 * 60 * 60 * 1000
}

interface FormLine {
  article: ArticleDTO
  quantity: string
  unitPrice: string
  discount: string
  /** El descuento de la línea es un porcentaje (true) o un importe en $ (false). */
  discountIsPct: boolean
}

/** Descuento absoluto ($) de una línea, traduciendo el % si corresponde. */
function lineDiscountAbs(l: FormLine): string {
  if (!l.discountIsPct) return parseCurrencyInput(l.discount)
  const pct = Number(parseCurrencyInput(l.discount)) || 0
  const base = Number(parseCurrencyInput(l.quantity)) * Number(parseCurrencyInput(l.unitPrice))
  return ((base * pct) / 100).toFixed(4)
}

/* ===================================================================== */
/* Componente raíz: alterna lista / creación                             */
/* ===================================================================== */
export function Presupuestos() {
  const [view, setView] = useState<'list' | 'create'>('list')
  return view === 'create' ? (
    <QuoteForm onDone={() => setView('list')} onCancel={() => setView('list')} />
  ) : (
    <QuoteList onNew={() => setView('create')} />
  )
}

/* ===================================================================== */
/* Listado / registro                                                    */
/* ===================================================================== */
function QuoteList({ onNew }: { onNew: () => void }) {
  const canWrite = useCanWrite()
  const customersQuery = useCustomers()
  const customerById = useMemo(
    () => new Map((customersQuery.data ?? []).map((c) => [c.id, c])),
    [customersQuery.data],
  )
  // Rango amplio (último año) + filtros en cliente.
  const range = useMemo(() => {
    const to = Date.now() + 24 * 60 * 60 * 1000
    const from = to - 366 * 24 * 60 * 60 * 1000
    return { from, to }
  }, [])
  const quotesQuery = useQuery({
    queryKey: ['quotes', range.from, range.to],
    queryFn: () => api.quotes.listByDateRange(range.from, range.to),
  })
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | QuoteStatus>('all')
  const [selected, setSelected] = useState<QuoteDTO | null>(null)

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (quotesQuery.data ?? []).filter((q) => {
      if (statusFilter !== 'all' && q.status !== statusFilter) return false
      if (!term) return true
      const cn = customerName(customerById.get(q.customerId)).toLowerCase()
      return quoteNumber(q.number).toLowerCase().includes(term) || cn.includes(term)
    })
  }, [quotesQuery.data, search, statusFilter, customerById])

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <FileText className="h-5 w-5" /> Presupuestos
        </h1>
        {canWrite && (
          <Button onClick={onNew}>
            <Plus className="mr-2 h-4 w-4" /> Nuevo presupuesto
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Buscar por número o cliente…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | QuoteStatus)}>
          <option value="all">Todos los estados</option>
          <option value="pending">Pendientes</option>
          <option value="converted">Convertidos</option>
          <option value="rejected">Rechazados</option>
        </Select>
      </div>

      <Card className="min-h-0 flex-1">
        <CardContent className="p-0">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2">N°</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {quotesQuery.isLoading ? (
                  <tr><td colSpan={5} className="py-10 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={5} className="py-10 text-center text-muted-foreground">No hay presupuestos.</td></tr>
                ) : (
                  filtered.map((q) => {
                    const expired = isExpired(q)
                    return (
                      <tr
                        key={q.id}
                        className="cursor-pointer border-t hover:bg-accent/50"
                        onClick={() => setSelected(q)}
                      >
                        <td className="px-3 py-2 font-mono">{quoteNumber(q.number)}</td>
                        <td className="px-3 py-2">{formatDate(q.date)}</td>
                        <td className="px-3 py-2">{customerName(customerById.get(q.customerId))}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{formatCurrency(q.total)}</td>
                        <td className="px-3 py-2">
                          {q.status === 'converted' ? (
                            <Badge variant="outline">Convertido</Badge>
                          ) : expired ? (
                            <Badge variant="warning">Vencido</Badge>
                          ) : (
                            <Badge>{STATUS_LABEL[q.status]}</Badge>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {selected && (
        <QuoteDetailDialog
          quote={selected}
          customer={customerById.get(selected.customerId) ?? null}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

/* ===================================================================== */
/* Detalle + acciones (imprimir / convertir / eliminar)                  */
/* ===================================================================== */
function QuoteDetailDialog({
  quote,
  customer,
  onClose,
}: {
  quote: QuoteDTO
  customer: CustomerDTO | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const canWrite = useCanWrite()
  const companyQuery = useCompany()
  const articlesQuery = useArticles()
  const printQuote = usePrintQuote()
  const detailQuery = useQuery({
    queryKey: ['quote', quote.id],
    queryFn: () => api.quotes.get(quote.id),
  })
  const [converting, setConverting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const articleById = useMemo(
    () => new Map((articlesQuery.data ?? []).map((a) => [a.id, a])),
    [articlesQuery.data],
  )
  const expired = isExpired(quote)
  const canConvert = quote.status !== 'converted'

  function buildDoc(): FormalDocData | null {
    if (!detailQuery.data || !companyQuery.data) return null
    const { quote: q, lines } = detailQuery.data
    return {
      company: companyQuery.data,
      title: 'PRESUPUESTO',
      number: quoteNumber(q.number),
      meta: [
        { label: 'Fecha', value: formatDate(q.date) },
        { label: 'Válido', value: `${q.validityDays} días` },
      ],
      customer: customer ? { name: customerName(customer), doc: customer.docNumber ? `${customer.docType} ${customer.docNumber}` : null } : null,
      lines: lines.map((l) => ({
        description: articleById.get(l.articleId)?.description ?? l.articleId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
      totals: {
        subtotal: q.subtotal,
        discount: q.discount,
        vatAmount: q.vatAmount,
        total: q.total,
      },
      notes: q.notes,
      footerNote: `Presupuesto válido por ${q.validityDays} días desde su emisión.`,
    }
  }

  async function onPrint(): Promise<void> {
    const doc = buildDoc()
    if (!doc) {
      toast.error('Esperá a que cargue el detalle')
      return
    }
    await printQuote(doc)
  }

  async function onDelete(): Promise<void> {
    if (!window.confirm(`¿Eliminar el presupuesto ${quoteNumber(quote.number)}?`)) return
    setDeleting(true)
    try {
      await api.quotes.delete(quote.id)
      toast.success('Presupuesto eliminado')
      void queryClient.invalidateQueries({ queryKey: ['quotes'] })
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo eliminar')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Presupuesto {quoteNumber(quote.number)}
            {quote.status === 'converted' && <Badge variant="outline" className="ml-2">Convertido</Badge>}
            {expired && quote.status !== 'converted' && <Badge variant="warning" className="ml-2">Vencido</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Cliente</span>
            <span>{customerName(customer ?? undefined)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fecha</span>
            <span>{formatDate(quote.date)}</span>
          </div>

          <div className="mt-1 max-h-56 overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1">Producto</th>
                  <th className="px-2 py-1 text-right">Cant.</th>
                  <th className="px-2 py-1 text-right">P. unit.</th>
                  <th className="px-2 py-1 text-right">Importe</th>
                </tr>
              </thead>
              <tbody>
                {detailQuery.data?.lines.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="px-2 py-1">{articleById.get(l.articleId)?.description ?? l.articleId}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{l.quantity}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(l.unitPrice)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCurrency(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between border-t pt-1 text-base font-bold">
            <span>TOTAL</span>
            <span className="tabular-nums">{formatCurrency(quote.total)}</span>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => void onPrint()}>
            <Printer className="mr-2 h-4 w-4" /> Imprimir PDF
          </Button>
          {canWrite && quote.status !== 'converted' && (
            <Button variant="outline" className="text-destructive" disabled={deleting} onClick={() => void onDelete()}>
              {deleting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              Eliminar
            </Button>
          )}
          {canWrite && canConvert && (
            <Button onClick={() => setConverting(true)}>
              <ShoppingCart className="mr-2 h-4 w-4" /> Convertir en venta
            </Button>
          )}
        </DialogFooter>

        {converting && (
          <ConvertDialog
            quote={quote}
            customer={customer}
            onClose={() => setConverting(false)}
            onConverted={() => {
              setConverting(false)
              void queryClient.invalidateQueries({ queryKey: ['quotes'] })
              onClose()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ===================================================================== */
/* Conversión en venta (elige precio congelado/actual + pago)            */
/* ===================================================================== */
function ConvertDialog({
  quote,
  customer,
  onClose,
  onConverted,
}: {
  quote: QuoteDTO
  customer: CustomerDTO | null
  onClose: () => void
  onConverted: () => void
}) {
  const paymentMethodsQuery = usePaymentMethods()
  const activeMethods = useMemo(() => (paymentMethodsQuery.data ?? []).filter((m) => m.active), [paymentMethodsQuery.data])
  const [refreshPrices, setRefreshPrices] = useState(false)
  const [accountSale, setAccountSale] = useState(false)
  const [total, setTotal] = useState<string>(quote.total)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const eligibleAccount =
    customer != null && customer.docType != null && customer.docType !== 'CF' && (customer.docNumber ?? '').trim() !== ''

  // Recalcula el total según se usen precios congelados o actuales.
  useEffect(() => {
    let active = true
    setLoadingPreview(true)
    api.quotes
      .previewConvert(quote.id, refreshPrices)
      .then((p) => { if (active) setTotal(p.total) })
      .catch(() => { if (active) setTotal(quote.total) })
      .finally(() => { if (active) setLoadingPreview(false) })
    return () => { active = false }
  }, [quote.id, refreshPrices])

  const totalNum = Number(total)
  const split = usePaymentSplit(activeMethods, totalNum)

  async function onConfirm(): Promise<void> {
    if (!accountSale && !split.isComplete) {
      toast.error('Los pagos deben sumar exactamente el total')
      return
    }
    setSubmitting(true)
    try {
      const result = await api.quotes.convertToSale({
        quoteId: quote.id,
        isAccountSale: accountSale,
        refreshPrices,
        payments: accountSale ? [] : split.payments,
      })
      toast.success(`Venta ${result.sale.type} #${result.sale.number} generada desde el presupuesto`)
      onConverted()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo convertir el presupuesto')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Convertir {quoteNumber(quote.number)} en venta</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={refreshPrices} onChange={(e) => setRefreshPrices(e.target.checked)} />
            Actualizar a los precios actuales (por defecto usa los precios congelados del presupuesto)
          </label>

          <div className="flex items-center justify-between rounded-md bg-muted px-3 py-2">
            <span className="font-medium">Total a cobrar</span>
            <span className="text-lg font-bold tabular-nums">
              {loadingPreview ? <Loader2 className="h-4 w-4 animate-spin" /> : formatCurrency(total)}
            </span>
          </div>

          {eligibleAccount && (
            <label className="flex items-center gap-2 rounded-md border px-3 py-2">
              <input type="checkbox" checked={accountSale} onChange={(e) => setAccountSale(e.target.checked)} />
              Cargar a cuenta corriente (sin cobro ahora)
            </label>
          )}

          {!accountSale && (
            <div className="rounded-md border p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Composición del pago</span>
                <button type="button" className="text-xs text-primary hover:underline" onClick={() => split.fillAllInCash()}>
                  Todo en efectivo
                </button>
              </div>
              <PaymentSplitInput methods={activeMethods} split={split} />
              <div className="mt-1 text-right text-xs text-muted-foreground">
                Restante: {formatCurrency((totalNum - split.totalPaid).toFixed(2))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button onClick={() => void onConfirm()} disabled={submitting || loadingPreview}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirmar venta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ===================================================================== */
/* Formulario de creación                                                */
/* ===================================================================== */
function QuoteForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const queryClient = useQueryClient()
  const articlesQuery = useArticles()
  const customersQuery = useCustomers()
  const companyQuery = useCompany()
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false)
  const priceMode: PriceMode = companyQuery.data?.priceMode ?? 'gross'

  const customers = useMemo(
    () => [...(customersQuery.data ?? [])].sort((a, b) => a.lastName.localeCompare(b.lastName)),
    [customersQuery.data],
  )
  const [customerId, setCustomerId] = useState<string>('')
  const selectedCustomer = customers.find((c) => c.id === customerId) ?? null
  const [voucherType, setVoucherType] = useState<VoucherType>('B')
  const [validityDays, setValidityDays] = useState('30')
  const [notes, setNotes] = useState('')

  const [search, setSearch] = useState('')
  const [cart, setCart] = useState<FormLine[]>([])
  const [globalDiscount, setGlobalDiscount] = useState('0')
  const [discountIsPct, setDiscountIsPct] = useState(false)
  const [saving, setSaving] = useState(false)

  const familiesQuery = useFamilies()
  const suppliersQuery = useSuppliers()
  const searchCtx = useMemo(
    () => buildSearchContext(familiesQuery.data, suppliersQuery.data),
    [familiesQuery.data, suppliersQuery.data],
  )
  const suggestions = useMemo(() => {
    const term = search.trim()
    if (term.length < 2) return []
    return (articlesQuery.data ?? [])
      .filter((a) => articleMatches(a, term, searchCtx))
      .slice(0, 300)
  }, [articlesQuery.data, search, searchCtx])

  function addArticle(a: ArticleDTO): void {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.article.id === a.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx]!, quantity: (Number(next[idx]!.quantity) + 1).toString() }
        return next
      }
      return [...prev, { article: a, quantity: '1', unitPrice: resolvePrice(a, selectedCustomer, '1'), discount: '0', discountIsPct: false }]
    })
    setSearch('')
  }

  const lineInputs = cart.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: lineDiscountAbs(l), vatRate: l.article.vatRate }))
  const subtotalBase = Number(calculateSaleTotals(lineInputs, '0', priceMode).subtotal)
  const globalDiscountAbs = discountIsPct
    ? ((subtotalBase * (Number(parseCurrencyInput(globalDiscount)) || 0)) / 100).toFixed(4)
    : parseCurrencyInput(globalDiscount)
  const totals = calculateSaleTotals(lineInputs, globalDiscountAbs, priceMode)

  async function onSave(): Promise<void> {
    if (cart.length === 0) {
      toast.error('Agregá al menos un producto')
      return
    }
    if (!customerId) {
      toast.error('Elegí un cliente')
      return
    }
    setSaving(true)
    try {
      const created = await api.quotes.create({
        type: voucherType,
        customerId,
        validityDays: Math.max(1, Number(validityDays) || 30),
        discount: globalDiscountAbs,
        notes: notes.trim() || null,
        lines: cart.map((l) => ({
          articleId: l.article.id,
          quantity: parseCurrencyInput(l.quantity),
          unitPrice: parseCurrencyInput(l.unitPrice),
          discount: lineDiscountAbs(l),
          vatRate: l.article.vatRate,
        })),
      })
      toast.success(`Presupuesto ${quoteNumber(created.quote.number)} guardado`)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar el presupuesto')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <FileText className="h-5 w-5" /> Nuevo presupuesto
        </h1>
        <Button variant="ghost" onClick={onCancel}><X className="mr-2 h-4 w-4" /> Volver</Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-1">
          <Label>Cliente</Label>
          <div className="flex items-center gap-1">
            <Select className="flex-1" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">— Elegir cliente —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{customerName(c)}</option>
              ))}
            </Select>
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Cargar un cliente nuevo"
              onClick={() => setCustomerDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label>Comprobante</Label>
          <Select value={voucherType} onChange={(e) => setVoucherType(e.target.value as VoucherType)}>
            {VOUCHER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>Validez (días)</Label>
          <Input type="number" min="1" value={validityDays} onChange={(e) => setValidityDays(e.target.value)} />
        </div>
      </div>

      <div className="relative">
        <ShoppingCart className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-11 pl-10"
          placeholder="Buscá un producto por nombre, código o marca…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {suggestions.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
            {suggestions.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => addArticle(a)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono text-xs text-muted-foreground">{a.barcode}</span> · {a.description}
                </span>
                {a.brand && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">{a.brand}</span>}
                <span className="shrink-0 tabular-nums">{formatCurrency(resolvePrice(a, selectedCustomer, '1'))}</span>
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
              <th className="w-28 px-2 py-1.5 text-right">P. unit.</th>
              <th className="w-24 px-2 py-1.5 text-right">Desc.</th>
              <th className="w-28 px-2 py-1.5 text-right">Subtotal</th>
              <th className="w-8 px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {cart.length === 0 ? (
              <tr><td colSpan={6} className="py-10 text-center text-muted-foreground">Sin productos — buscá uno arriba.</td></tr>
            ) : (
              cart.map((l, i) => (
                <tr key={l.article.id} className="border-t">
                  <td className="px-2 py-1">
                    <div className="font-medium">
                      {l.article.description}
                      {l.article.brand && <span className="ml-1.5 text-xs font-semibold text-primary">· {l.article.brand}</span>}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{l.article.barcode}</div>
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      className="h-8 text-right tabular-nums"
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) => setCart((p) => p.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <CurrencyInput
                      className="h-8 text-right tabular-nums"
                      value={l.unitPrice}
                      onChange={(v) => setCart((p) => p.map((x, j) => (j === i ? { ...x, unitPrice: v } : x)))}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        title={l.discountIsPct ? 'Descuento en %' : 'Descuento en $'}
                        onClick={() => setCart((p) => p.map((x, j) => (j === i ? { ...x, discountIsPct: !x.discountIsPct, discount: '0' } : x)))}
                        className="h-8 w-6 shrink-0 rounded-md border text-xs font-semibold hover:bg-accent"
                      >
                        {l.discountIsPct ? '%' : '$'}
                      </button>
                      {l.discountIsPct ? (
                        <input
                          type="number" min="0" max="100" step="0.5"
                          value={l.discount}
                          onChange={(e) => setCart((p) => p.map((x, j) => (j === i ? { ...x, discount: e.target.value } : x)))}
                          className="h-8 w-16 rounded-md border bg-background px-1.5 text-right text-sm tabular-nums"
                        />
                      ) : (
                        <CurrencyInput
                          className="h-8 w-20 text-right tabular-nums"
                          value={l.discount}
                          onChange={(v) => setCart((p) => p.map((x, j) => (j === i ? { ...x, discount: v } : x)))}
                        />
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums font-medium">
                    {formatCurrency(lineTotal({ quantity: l.quantity, unitPrice: l.unitPrice, discount: lineDiscountAbs(l) }))}
                  </td>
                  <td className="px-2 py-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => setCart((p) => p.filter((_, j) => j !== i))} title="Quitar producto del presupuesto">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-3 gap-3 rounded-lg border bg-card p-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Label>Observaciones</Label>
          <textarea
            className="h-20 resize-none rounded-md border bg-background px-3 py-2 text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notas para el cliente (opcional)"
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{priceMode === 'gross' ? 'Subtotal (c/IVA)' : 'Subtotal neto'}</span>
            <span className="tabular-nums">{formatCurrency(totals.subtotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Descuento</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => { setDiscountIsPct((v) => !v); setGlobalDiscount('0') }}
                className="h-7 w-7 shrink-0 rounded-md border text-xs font-semibold hover:bg-accent"
              >
                {discountIsPct ? '%' : '$'}
              </button>
              {discountIsPct ? (
                <input
                  type="number" min="0" max="100" step="0.5"
                  value={globalDiscount}
                  onChange={(e) => setGlobalDiscount(e.target.value)}
                  className="h-7 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums"
                />
              ) : (
                <CurrencyInput className="h-7 w-24 text-right tabular-nums" value={globalDiscount} onChange={setGlobalDiscount} />
              )}
            </div>
          </div>
          {discountIsPct && (Number(parseCurrencyInput(globalDiscount)) || 0) > 0 && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{parseCurrencyInput(globalDiscount)}% sobre subtotal</span>
              <span className="tabular-nums">−{formatCurrency(globalDiscountAbs)}</span>
            </div>
          )}
          <div className="mt-1 flex items-baseline justify-between border-t pt-1">
            <span className="font-semibold">TOTAL</span>
            <span className="text-xl font-bold tabular-nums">{formatCurrency(totals.total)}</span>
          </div>
          <Button className="mt-2" disabled={saving} onClick={() => void onSave()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Guardar presupuesto
          </Button>
        </div>
      </div>

      {customerDialogOpen && (
        <QuickCustomerDialog
          onClose={() => setCustomerDialogOpen(false)}
          onCreated={(c) => {
            void queryClient.invalidateQueries({ queryKey: ['customers'] })
            setCustomerId(c.id)
            setCustomerDialogOpen(false)
          }}
        />
      )}
    </div>
  )
}

/* ===================================================================== */
/* Alta rápida de cliente (desde el presupuesto)                         */
/* ===================================================================== */
function QuickCustomerDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (c: CustomerDTO) => void
}) {
  const [lastName, setLastName] = useState('')
  const [firstName, setFirstName] = useState('')
  const [docType, setDocType] = useState<'CF' | 'DNI' | 'CUIT'>('CF')
  const [docNumber, setDocNumber] = useState('')
  const [category, setCategory] = useState<'CF' | 'RI' | 'MT' | 'EX'>('CF')
  const [saving, setSaving] = useState(false)

  async function onSave(): Promise<void> {
    if (lastName.trim() === '') {
      toast.error('Ingresá el nombre o razón social')
      return
    }
    setSaving(true)
    try {
      const created = await api.customers.create({
        lastName: lastName.trim(),
        firstName: firstName.trim() || null,
        docType,
        docNumber: docType === 'CF' ? null : docNumber.trim() || null,
        category,
      })
      toast.success('Cliente cargado')
      onCreated(created)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cargar el cliente')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Nuevo cliente</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-col gap-1">
            <Label>Nombre / Razón social *</Label>
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Nombre de pila (opcional)</Label>
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label>Documento</Label>
              <Select value={docType} onChange={(e) => setDocType(e.target.value as 'CF' | 'DNI' | 'CUIT')}>
                <option value="CF">Sin documento</option>
                <option value="DNI">DNI</option>
                <option value="CUIT">CUIT</option>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Número</Label>
              <Input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} disabled={docType === 'CF'} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Condición fiscal</Label>
            <Select value={category} onChange={(e) => setCategory(e.target.value as 'CF' | 'RI' | 'MT' | 'EX')}>
              <option value="CF">Consumidor Final</option>
              <option value="RI">Responsable Inscripto</option>
              <option value="MT">Monotributo</option>
              <option value="EX">Exento</option>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={() => void onSave()} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Guardar cliente
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
