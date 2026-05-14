import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { useWindowSelf } from '@/contexts/WindowManagerContext'
import { useWindowNav } from '@/lib/useWindowNav'
import { toast } from 'sonner'
import { Loader2, Search, ShoppingCart, Trash2, Wallet, X } from 'lucide-react'

import { api } from '@/lib/api'
import {
  useArticles,
  useCompany,
  useCurrentCash,
  usePaymentMethods,
  useSuppliers,
} from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
import { calculateSaleTotals, lineTotal, vatBreakdown } from '@/lib/pricing'
import { formatCurrency, formatDate, parseCurrencyInput } from '@/lib/format'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PaymentSplitInput } from '@/components/PaymentSplitInput'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ArticleDTO, PriceMode, SupplierDTO, VoucherType } from '@/types/api'

interface CompraLine {
  article: ArticleDTO
  quantity: string
  costPrice: string
  vatRate: string
  /** Nuevo precio de venta (vacío = no cambia listPrice1). */
  newSalePrice: string
}

const VOUCHER_OPTIONS: { value: VoucherType; label: string }[] = [
  { value: 'A', label: 'Factura A' },
  { value: 'B', label: 'Factura B' },
  { value: 'C', label: 'Factura C' },
  { value: 'X', label: 'Comprobante X' },
]
const VAT_OPTIONS = [
  { value: '0.00', label: '0%' },
  { value: '10.50', label: '10,5%' },
  { value: '21.00', label: '21%' },
  { value: '27.00', label: '27%' },
]

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isoToTs(iso: string): number | undefined {
  if (!iso) return undefined
  const ts = new Date(`${iso}T12:00:00`).getTime()
  return Number.isFinite(ts) ? ts : undefined
}

function SupplierPicker({
  open,
  suppliers,
  onClose,
  onSelect,
}: {
  open: boolean
  suppliers: SupplierDTO[]
  onClose: () => void
  onSelect: (s: SupplierDTO) => void
}) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    const base = [...suppliers].sort((a, b) => a.name.localeCompare(b.name))
    if (!term) return base.slice(0, 50)
    return base
      .filter((s) => `${s.code} ${s.name} ${s.cuit ?? ''}`.toLowerCase().includes(term))
      .slice(0, 50)
  }, [suppliers, q])
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Seleccionar proveedor</DialogTitle>
        </DialogHeader>
        <Input autoFocus placeholder="Buscar por código, nombre o CUIT…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-72 overflow-auto rounded-md border">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Sin resultados</div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span>
                  <span className="font-mono text-xs text-muted-foreground">{s.code}</span> · {s.name}
                </span>
                <span className="text-xs text-muted-foreground">{s.cuit ?? ''}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Compras() {
  const { currentUser } = useAuth()
  const canWrite = useCanWrite()
  const openInWindow = useWindowNav()
  const windowSelf = useWindowSelf()
  const articlesQuery = useArticles()
  const suppliersQuery = useSuppliers()
  const paymentMethodsQuery = usePaymentMethods()
  const companyQuery = useCompany()
  const currentCash = useCurrentCash()
  const qc = useQueryClient()

  const priceMode: PriceMode = companyQuery.data?.priceMode ?? 'gross'
  const allArticles = useMemo(() => (articlesQuery.data ?? []).filter((a) => a.active), [articlesQuery.data])
  const suppliers = useMemo(() => suppliersQuery.data ?? [], [suppliersQuery.data])
  const activeMethods = useMemo(() => (paymentMethodsQuery.data ?? []).filter((m) => m.active), [paymentMethodsQuery.data])

  const [supplierId, setSupplierId] = useState<string | null>(null)
  const selectedSupplier = supplierId != null ? (suppliers.find((s) => s.id === supplierId) ?? null) : null
  const [voucherType, setVoucherType] = useState<VoucherType>('A')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [dateIso, setDateIso] = useState(() => todayIso())
  const numberQuery = useQuery({
    queryKey: ['purchases', 'nextNumber', voucherType],
    queryFn: () => api.purchases.getNextNumber(voucherType),
  })

  const [cart, setCart] = useState<CompraLine[]>([])
  const [globalDiscount, setGlobalDiscount] = useState('0')
  const [updatePrices, setUpdatePrices] = useState(false)
  const [isAccountPurchase, setIsAccountPurchase] = useState(false)
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false)
  const [barcode, setBarcode] = useState('')
  const barcodeRef = useRef<HTMLInputElement>(null)
  const [today] = useState(() => formatDate(Date.now()))

  useEffect(() => {
    barcodeRef.current?.focus()
  }, [])

  // Prefill desde "Generador de compras" (P-CONSULTAS).
  const location = useLocation()
  const prefillAppliedRef = useRef(false)
  useEffect(() => {
    if (prefillAppliedRef.current) return
    const fromExtras = windowSelf?.extras as
      | { prefilledLines?: Array<{ articleId: string; quantity: string; unitPrice?: string }>; from?: string }
      | undefined
    const fromState = location.state as
      | { prefilledLines?: Array<{ articleId: string; quantity: string; unitPrice?: string }>; from?: string }
      | null
    const st = fromExtras ?? fromState
    if (!st || !Array.isArray(st.prefilledLines) || st.prefilledLines.length === 0) return
    if (allArticles.length === 0) return // esperar a que carguen los artículos
    prefillAppliedRef.current = true
    const byId = new Map(allArticles.map((a) => [a.id, a]))
    const lines: CompraLine[] = []
    const supplierIds = new Set<string | null>()
    for (const p of st.prefilledLines) {
      const art = byId.get(p.articleId)
      if (!art) continue
      lines.push({
        article: art,
        quantity: String(Number(p.quantity)),
        costPrice: p.unitPrice ?? art.costPrice,
        vatRate: art.vatRate,
        newSalePrice: '',
      })
      supplierIds.add(art.supplierId ?? null)
    }
    if (lines.length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCart(lines)
    // Si todos los artículos comparten proveedor → preseleccionar.
    const uniqueSuppliers = [...supplierIds].filter((s): s is string => s != null)
    if (supplierIds.size === 1 && uniqueSuppliers.length === 1) {
      setSupplierId(uniqueSuppliers[0]!)
    } else {
      toast.warning('Hay artículos de varios proveedores — armá una orden por proveedor')
    }
    // Limpiar el state de la ruta para que un refresco no reaplique.
    window.history.replaceState({}, '')
  }, [location.state, allArticles, windowSelf?.extras])

  const totals = calculateSaleTotals(
    cart.map((l) => ({ quantity: l.quantity, unitPrice: l.costPrice, vatRate: l.vatRate })),
    parseCurrencyInput(globalDiscount),
    priceMode,
  )
  const totalNum = Number(totals.total)
  const split = usePaymentSplit(activeMethods, totalNum)

  const noCash = !isAccountPurchase && !currentCash.data
  const noMethods = !isAccountPurchase && activeMethods.length === 0

  function addArticle(article: ArticleDTO): void {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.article.id === article.id)
      if (idx >= 0) {
        const next = [...prev]
        const line = next[idx]!
        next[idx] = { ...line, quantity: (Number(line.quantity) + 1).toString() }
        return next
      }
      return [
        ...prev,
        { article, quantity: '1', costPrice: article.costPrice, vatRate: article.vatRate, newSalePrice: '' },
      ]
    })
  }
  function removeLine(i: number): void {
    setCart((prev) => prev.filter((_, idx) => idx !== i))
  }
  function setLine<K extends keyof CompraLine>(i: number, key: K, value: CompraLine[K]): void {
    setCart((prev) => {
      const next = [...prev]
      next[i] = { ...next[i]!, [key]: value }
      return next
    })
  }
  function clearCompra(): void {
    setCart([])
    setGlobalDiscount('0')
    setUpdatePrices(false)
    setIsAccountPurchase(false)
    setInvoiceNumber('')
    setDateIso(todayIso())
    split.reset()
    barcodeRef.current?.focus()
  }

  const exactByBarcode = useMemo(() => {
    const v = barcode.trim()
    return v ? (allArticles.find((a) => a.barcode === v) ?? null) : null
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
    if (exactByBarcode) addArticle(exactByBarcode)
    else if (suggestions.length > 0) addArticle(suggestions[0]!)
    else {
      toast.error('No se encontró el producto')
      return
    }
    setBarcode('')
    barcodeRef.current?.focus()
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api.purchases.create({
        type: voucherType,
        supplierId: supplierId!,
        supplierInvoiceNumber: invoiceNumber.trim() || null,
        date: isoToTs(dateIso),
        isAccountPurchase,
        payments: isAccountPurchase ? [] : split.payments,
        updatePrices,
        discount: parseCurrencyInput(globalDiscount),
        notes: null,
        lines: cart.map((l) => ({
          articleId: l.article.id,
          quantity: parseCurrencyInput(l.quantity),
          costPrice: parseCurrencyInput(l.costPrice),
          salePrice: updatePrices && l.newSalePrice.trim() !== '' ? parseCurrencyInput(l.newSalePrice) : undefined,
          vatRate: l.vatRate,
        })),
      }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['supplierBalances'] })
      toast.success(`Compra ${result.purchase.type} #${result.purchase.number} registrada — Total ${formatCurrency(result.purchase.total)}`)
      clearCompra()
      void numberQuery.refetch()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'No se pudo registrar la compra'),
  })

  const canConfirm =
    canWrite &&
    cart.length > 0 &&
    totalNum > 0 &&
    supplierId != null &&
    !createMutation.isPending &&
    !noCash &&
    (isAccountPurchase ? true : split.isComplete && activeMethods.length > 0)

  // F2 = confirmar (fase de captura para ganarle al handler de F-keys del Layout)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return
      if (e.key === 'F2') {
        e.preventDefault()
        e.stopPropagation()
        if (canConfirm) createMutation.mutate()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  })

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid grid-cols-4 gap-3 rounded-lg border bg-card p-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Label>Proveedor</Label>
          <Button variant="outline" className="justify-between" onClick={() => setSupplierPickerOpen(true)}>
            <span className="truncate">{selectedSupplier ? `${selectedSupplier.code} — ${selectedSupplier.name}` : 'Elegir proveedor…'}</span>
            <Search className="h-4 w-4 shrink-0 opacity-60" />
          </Button>
          {selectedSupplier?.cuit && <span className="text-xs text-muted-foreground">CUIT: {selectedSupplier.cuit}</span>}
        </div>
        <div className="flex flex-col gap-1">
          <Label>Comprobante recibido</Label>
          <Select value={voucherType} onChange={(e) => setVoucherType(e.target.value as VoucherType)}>
            {VOUCHER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>N° del proveedor</Label>
          <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="0001-00012345" />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Fecha del comprobante</Label>
          <Input type="date" value={dateIso} onChange={(e) => setDateIso(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label>N° interno</Label>
          <Input readOnly value={numberQuery.data?.number ?? '—'} className="bg-muted tabular-nums" />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Cargado</Label>
          <Input readOnly value={today} className="bg-muted" />
        </div>
        <div className="col-span-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>Usuario: {currentUser?.fullName}</span>
          <div className="flex items-center gap-2">
            <Badge variant={priceMode === 'gross' ? 'outline' : 'warning'}>
              Modo: Precios {priceMode === 'gross' ? 'con IVA incluido' : 'netos + IVA'}
            </Badge>
            <Button variant="ghost" size="sm" onClick={() => openInWindow('historial-compras')}>
              Ver historial
            </Button>
          </div>
        </div>
      </div>

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
                  onClick={() => { addArticle(a); setBarcode(''); barcodeRef.current?.focus() }}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">
                    <span className="font-mono text-xs text-muted-foreground">{a.barcode}</span> · {a.description}
                  </span>
                  <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">costo {formatCurrency(a.costPrice)}</span>
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
                <th className="w-28 px-2 py-1.5 text-right">{priceMode === 'gross' ? 'Costo (c/IVA)' : 'Costo (neto)'}</th>
                <th className="w-20 px-2 py-1.5 text-right">IVA</th>
                {updatePrices && <th className="w-28 px-2 py-1.5 text-right">Nuevo P. venta</th>}
                <th className="w-28 px-2 py-1.5 text-right">Subtotal</th>
                <th className="w-8 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {cart.length === 0 ? (
                <tr>
                  <td colSpan={updatePrices ? 7 : 6} className="py-10 text-center text-sm text-muted-foreground">
                    Sin líneas — escaneá o buscá un producto para empezar.
                  </td>
                </tr>
              ) : (
                cart.map((l, i) => (
                  <tr key={l.article.id} className="border-t">
                    <td className="px-2 py-1">
                      <div className="font-medium">{l.article.description}</div>
                      <div className="font-mono text-xs text-muted-foreground">{l.article.barcode}</div>
                    </td>
                    <td className="px-2 py-1">
                      <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={l.quantity}
                        onChange={(e) => setLine(i, 'quantity', e.target.value)} onBlur={() => setLine(i, 'quantity', parseCurrencyInput(l.quantity))} />
                    </td>
                    <td className="px-2 py-1">
                      <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={l.costPrice}
                        onChange={(e) => setLine(i, 'costPrice', e.target.value)} onBlur={() => setLine(i, 'costPrice', parseCurrencyInput(l.costPrice))} />
                    </td>
                    <td className="px-2 py-1">
                      <Select className="h-8" value={l.vatRate} onChange={(e) => setLine(i, 'vatRate', e.target.value)}>
                        {VAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    </td>
                    {updatePrices && (
                      <td className="px-2 py-1">
                        <Input className="h-8 text-right tabular-nums" inputMode="decimal" placeholder="(sin cambio)" value={l.newSalePrice}
                          onChange={(e) => setLine(i, 'newSalePrice', e.target.value)} onBlur={() => l.newSalePrice && setLine(i, 'newSalePrice', parseCurrencyInput(l.newSalePrice))} />
                      </td>
                    )}
                    <td className="px-2 py-1 text-right tabular-nums font-medium">
                      {formatCurrency(lineTotal({ quantity: l.quantity, unitPrice: l.costPrice }))}
                      {priceMode === 'net' && (
                        <div className="text-[10px] font-normal text-muted-foreground">
                          c/IVA {formatCurrency(vatBreakdown(lineTotal({ quantity: l.quantity, unitPrice: l.costPrice }), l.vatRate, 'net').gross.toFixed(4))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(i)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 rounded border-input" checked={updatePrices} onChange={(e) => setUpdatePrices(e.target.checked)} />
          <span>Actualizar costos y precios de venta de los artículos al guardar</span>
        </label>
      </div>

      <div className="grid grid-cols-3 gap-3 rounded-lg border bg-card p-3">
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{priceMode === 'gross' ? 'Subtotal (con IVA)' : 'Subtotal neto'}</span>
            <span className="tabular-nums">{formatCurrency(totals.subtotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Descuento</span>
            <Input className="h-7 w-28 text-right tabular-nums" inputMode="decimal" value={globalDiscount}
              onChange={(e) => setGlobalDiscount(e.target.value)} onBlur={() => setGlobalDiscount(parseCurrencyInput(globalDiscount))} />
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

        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
            <input type="checkbox" className="h-4 w-4 rounded border-input" checked={isAccountPurchase} onChange={(e) => setIsAccountPurchase(e.target.checked)} />
            <span>Compra a cuenta del proveedor</span>
          </label>
          {isAccountPurchase ? (
            <p className="text-xs text-muted-foreground">
              Queda como deuda con el proveedor. {selectedSupplier ? `(${selectedSupplier.name})` : ''} No requiere caja abierta.
            </p>
          ) : noCash ? (
            <p className="text-xs text-destructive">No hay caja abierta. Abrí la caja (F7) o registrá la compra a cuenta del proveedor.</p>
          ) : noMethods ? (
            <p className="text-xs text-destructive">No hay medios de pago configurados.</p>
          ) : (
            <PaymentSplitInput methods={activeMethods} split={split} />
          )}
        </div>

        <div className="flex flex-col justify-end gap-2">
          <Button variant="success" className="h-14 text-lg" disabled={!canConfirm} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
            Confirmar compra (F2) — {formatCurrency(totals.total)}
          </Button>
          {cart.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearCompra} disabled={createMutation.isPending}>
              <X className="h-4 w-4" />
              Vaciar compra
            </Button>
          )}
        </div>
      </div>

      <SupplierPicker
        open={supplierPickerOpen}
        suppliers={suppliers}
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={(s) => { setSupplierId(s.id); setSupplierPickerOpen(false); barcodeRef.current?.focus() }}
      />
    </div>
  )
}
