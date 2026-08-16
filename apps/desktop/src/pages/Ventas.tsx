import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BadgePercent, List, Loader2, Printer, QrCode, Search, ShoppingCart, Trash2, Undo2, Wallet, X, Zap } from 'lucide-react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  useArticles,
  useCompany,
  useCreateSale,
  useCurrentCash,
  useCustomerBalances,
  useCustomers,
  useFamilies,
  usePaymentMethods,
  usePromotions,
  useSuppliers,
} from '@/lib/hooks'
import { useAuth, usePermission } from '@/contexts/AuthContext'
import { useWindowNav } from '@/lib/useWindowNav'
import { useCanWrite } from '@/contexts/LicenseContext'
import { printSaleTicketSilent } from '@/lib/printSaleTicket'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
import { calculateSaleTotals, lineTotal, resolvePrice, vatBreakdown } from '@/lib/pricing'
import { formatCurrency, formatDate, formatDateTime, parseCurrencyInput, formatQty } from '@/lib/format'
import { articleMatches, buildSearchContext } from '@/lib/articleSearch'
import { CurrencyInput } from '@/components/ui/currency-input'
import { type SaleTicketData, type SaleTicketLine, type SaleTicketPayment } from '@/print/SaleTicket'
import { ArticuloRapidoDialog, type ArticuloRapido } from '@/components/ArticuloRapidoDialog'
import { VAT_CONDITION_LABELS } from '@/lib/fiscalDoc'
import { PaymentSplitInput } from '@/components/PaymentSplitInput'
import { ReturnSaleDialog } from '@/components/ReturnDialogs'
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
import type { ArticleDTO, CompanyDTO, CreateSaleResultDTO, CustomerDTO, PriceMode, PrinterConfigDTO, VoucherType } from '@/types/api'

interface CartLine {
  /**
   * Falta en el ARTÍCULO RÁPIDO: se está cobrando algo que no está en el
   * catálogo. En ese caso la línea se describe sola con `description`.
   */
  article?: ArticleDTO
  /** Descripción escrita a mano. Sólo en el artículo rápido. */
  description?: string
  /** IVA de la línea: del artículo, o el elegido a mano en el rápido. */
  vatRate: string
  quantity: string
  unitPrice: string
  discount: string
  priceManuallySet: boolean
}

/** Cómo se muestra una línea, venga del catálogo o escrita a mano. */
function cartLineLabel(l: CartLine): string {
  return l.article?.description ?? l.description ?? 'Artículo rápido'
}

// Opciones del comprobante. Cuando la facturación electrónica está configurada
// y activa, las facturas se emiten con CAE real; si no, quedan marcadas
// "requiere ARCA" y solo el Remito X (no fiscal) es utilizable.
function voucherOptions(fiscalEnabled: boolean): { value: VoucherType; label: string }[] {
  // Sin facturación electrónica ACTIVA sólo se puede emitir Remito X. Antes se
  // ofrecían A/B/C igual y la venta salía impresa como "FACTURA A" SIN CAE: un
  // papel que parece fiscal y no lo es. Le pasó a Leo Citzia — creyó que estaba
  // facturando y no había ni un comprobante emitido.
  if (!fiscalEnabled) return [{ value: 'X', label: 'Remito X (no fiscal)' }]
  return [
    { value: 'X', label: 'Remito X (no fiscal)' },
    { value: 'A', label: 'Factura A (con CAE)' },
    { value: 'B', label: 'Factura B (con CAE)' },
    { value: 'C', label: 'Factura C (con CAE)' },
  ]
}

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

/**
 * Listado completo de artículos con filtros (patrón "listado de artículos"
 * del StockFacil legacy). Doble click en una fila → carga el artículo al
 * carrito. El modal queda abierto para cargar varios; se cierra con Escape
 * o con el botón de cerrar.
 */
function ArticlePicker({
  open,
  articles,
  families,
  suppliers,
  onClose,
  onPick,
}: {
  open: boolean
  articles: ArticleDTO[]
  families: { id: string; name: string }[]
  suppliers: { id: string; name: string; code: string }[]
  onClose: () => void
  onPick: (a: ArticleDTO) => void
}) {
  const [q, setQ] = useState('')
  const [familyId, setFamilyId] = useState('')
  const [brand, setBrand] = useState('')
  const [supplierId, setSupplierId] = useState('')

  const familyName = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of families) map.set(f.id, f.name)
    return map
  }, [families])

  // Marcas presentes en los artículos (para el Select de marca).
  const brands = useMemo(() => {
    const set = new Set<string>()
    for (const a of articles) if (a.brand) set.add(a.brand)
    return [...set].sort((x, y) => x.localeCompare(y, 'es'))
  }, [articles])

  const pickerSearchCtx = useMemo(() => buildSearchContext(families, suppliers), [families, suppliers])
  const filtered = useMemo(() => {
    const term = q.trim()
    return articles
      .filter((a) => {
        if (familyId && a.familyId !== familyId) return false
        if (brand && a.brand !== brand) return false
        if (supplierId && a.supplierId !== supplierId) return false
        if (term && !articleMatches(a, term, pickerSearchCtx)) return false
        return true
      })
      .sort((x, y) => x.description.localeCompare(y.description, 'es'))
      .slice(0, 300)
  }, [articles, q, familyId, brand, supplierId, pickerSearchCtx])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[85vh] w-[92vw] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle>Listado de artículos</DialogTitle>
        </DialogHeader>

        {/* Filtros */}
        <div className="grid grid-cols-4 gap-2">
          <Input
            autoFocus
            placeholder="Buscar por código, marca, familia, proveedor…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Select value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
            <option value="">Todas las familias</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
          <Select value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">Todas las marcas</option>
            {brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Todos los proveedores</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="text-xs text-muted-foreground">
          Doble click en una fila para agregarla a la venta · {filtered.length} artículo(s)
        </div>

        {/* Tabla */}
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5">Código</th>
                <th className="px-2 py-1.5">Descripción</th>
                <th className="px-2 py-1.5">Marca</th>
                <th className="px-2 py-1.5">Familia</th>
                <th className="px-2 py-1.5 text-right">Stock</th>
                <th className="px-2 py-1.5 text-right">Precio</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-muted-foreground">
                    Sin resultados
                  </td>
                </tr>
              ) : (
                filtered.map((a) => (
                  <tr
                    key={a.id}
                    onDoubleClick={() => onPick(a)}
                    className="cursor-pointer border-t hover:bg-accent"
                    title="Doble click para agregar a la venta"
                  >
                    <td className="px-2 py-1 font-mono text-xs">{a.barcode}</td>
                    <td className="px-2 py-1">{a.description}</td>
                    <td className="px-2 py-1 text-muted-foreground">{a.brand ?? ''}</td>
                    <td className="px-2 py-1 text-muted-foreground">
                      {a.familyId ? (familyName.get(a.familyId) ?? '—') : '—'}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {formatQty(a.stock)}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {formatCurrency(a.listPrice1)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Picker de PROMOCIONES para el PDV: lista las promos ACTIVAS y al elegir una
 * agrega su artículo espejo al carrito (misma ruta que cualquier artículo).
 * No muestra costos ni márgenes (lo ve el vendedor).
 */
/** Selector de venta reciente para lanzar una devolución desde el PDV. */
function DevolucionPicker({
  open,
  customers,
  onClose,
  onPick,
}: {
  open: boolean
  customers: CustomerDTO[]
  onClose: () => void
  onPick: (saleId: string) => void
}) {
  const [busca, setBusca] = useState('')
  const salesQuery = useQuery({
    queryKey: ['ventasDevolucionRecientes'],
    queryFn: () => api.sales.listByDateRange(Date.now() - 30 * 86_400_000, Date.now() + 3_600_000),
    enabled: open,
  })
  const customerName = useMemo(() => {
    const m = new Map(customers.map((c) => [c.id, `${c.lastName}${c.firstName ? ', ' + c.firstName : ''}`]))
    return (id: string) => m.get(id) ?? '—'
  }, [customers])
  const rows = useMemo(() => {
    const completadas = (salesQuery.data ?? []).filter((v) => v.status === 'completed')
    completadas.sort((a, b) => b.date - a.date)
    const q = busca.trim().toLowerCase()
    if (!q) return completadas.slice(0, 30)
    return completadas
      .filter((v) => String(v.number).includes(q) || customerName(v.customerId).toLowerCase().includes(q))
      .slice(0, 30)
  }, [salesQuery.data, busca, customerName])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Devolución — elegí la venta</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="Buscar por N° de comprobante o cliente…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <div className="max-h-80 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5">Fecha</th>
                <th className="px-2 py-1.5 text-right">N°</th>
                <th className="px-2 py-1.5">Cliente</th>
                <th className="px-2 py-1.5 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {salesQuery.isLoading ? (
                <tr><td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">Cargando…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">Sin ventas completadas en los últimos 30 días.</td></tr>
              ) : (
                rows.map((v) => (
                  <tr
                    key={v.id}
                    className="cursor-pointer border-t hover:bg-accent"
                    onClick={() => onPick(v.id)}
                  >
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">{formatDateTime(v.date)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{v.number}</td>
                    <td className="px-2 py-1.5">{customerName(v.customerId)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCurrency(v.total)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">Ventas más viejas: buscalas desde el Historial de Ventas (botón Devolución en el detalle).</p>
      </DialogContent>
    </Dialog>
  )
}

function PromoPicker({
  open,
  articles,
  onClose,
  onPick,
}: {
  open: boolean
  articles: ArticleDTO[]
  onClose: () => void
  onPick: (a: ArticleDTO) => void
}) {
  const promosQuery = usePromotions()
  const activas = (promosQuery.data ?? []).filter((p) => p.active)

  function pick(articleId: string, name: string): void {
    const mirror = articles.find((a) => a.id === articleId)
    if (!mirror) {
      toast.error(`No se encontró el artículo de la promo "${name}" — recargá la pantalla de Ventas`)
      return
    }
    onPick(mirror)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgePercent className="h-5 w-5 text-primary" />
            Promociones activas
          </DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
          {promosQuery.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Cargando…</p>}
          {!promosQuery.isLoading && activas.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No hay promociones activas. Se crean desde Gestión → Promociones.
            </p>
          )}
          {activas.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pick(p.articleId, p.name)}
              className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <BadgePercent className="h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {p.items.map((i) => `${Number(i.quantity)}× ${i.description}`).join(' + ')}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{p.code}</span>
              <b className="shrink-0 tabular-nums">{formatCurrency(p.price)}</b>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function NoCash() {
  // Se abre la VENTANA de Caja, no `navigate('/caja')`: esa ruta no existe en
  // el router —el mapeo /caja→caja es del registro de ventanas— así que el
  // botón no hacía absolutamente nada, y el cajero quedaba trabado sin poder
  // vender. Con el gestor de ventanas funciona igual en la app y en las
  // terminales por navegador.
  const abrirVentana = useWindowNav()
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 pt-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Wallet className="h-7 w-7" />
          </div>
          <p className="text-base font-medium">No hay caja abierta</p>
          <p className="text-sm text-muted-foreground">Para registrar ventas primero hay que abrir la caja.</p>
          <Button onClick={() => abrirVentana('caja')}>Ir a Caja</Button>
        </CardContent>
      </Card>
    </div>
  )
}

const FALLBACK_COMPANY: CompanyDTO = {
  id: '', name: 'StockFlow', address: null, phone: null, email: null, cuit: null, ingBrutos: null, priceMode: 'gross', allowNegativeStock: true, createdAt: 0, updatedAt: 0,
}

function PDV() {
  const { currentUser } = useAuth()
  const canWrite = useCanWrite()
  const openWindow = useWindowNav()
  const articlesQuery = useArticles()
  const familiesQuery = useFamilies()
  const suppliersQuery = useSuppliers()
  const customersQuery = useCustomers()
  const balancesQuery = useCustomerBalances()
  const paymentMethodsQuery = usePaymentMethods()
  const companyQuery = useCompany()
  const createSale = useCreateSale()
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

  const [voucherType, setVoucherType] = useState<VoucherType>('X')
  // El usuario tocó el desplegable a propósito: a partir de ahí manda él y el
  // sistema deja de cambiarlo solo.
  const [tipoForzado, setTipoForzado] = useState(false)
  // Facturación electrónica: si está activa, al confirmar se pide el CAE.
  const fiscalConfigQuery = useQuery({
    queryKey: ['fiscal', 'configPublic'],
    queryFn: () => api.fiscal.getConfigPublic(),
    staleTime: 60_000,
  })
  const salePointsQuery = useQuery({
    queryKey: ['fiscal', 'salePoints'],
    queryFn: () => api.fiscal.listSalePoints(),
    staleTime: 60_000,
  })
  const fiscalEnabled = fiscalConfigQuery.data?.enabled === true

  // ── El tipo de comprobante lo decide el CLIENTE ──────────────────────────
  // Emisor Responsable Inscripto: cliente RI → A, el resto → B.
  // Emisor Monotributo: siempre C.
  // El comercio factura decenas de ventas por día; elegir el tipo en cada una
  // es fricción pura y se presta a error. El desplegable queda como override
  // manual: si el usuario lo toca, manda él.
  const tipoSugerido: VoucherType = useMemo(() => {
    if (!fiscalEnabled) return 'X'
    const emisor = fiscalConfigQuery.data?.vatCondition ?? 'RI'
    if (emisor === 'MT') return 'C'
    return selectedCustomer?.category === 'RI' ? 'A' : 'B'
  }, [fiscalEnabled, fiscalConfigQuery.data, selectedCustomer])

  if (!tipoForzado && voucherType !== tipoSugerido) {
    setVoucherType(tipoSugerido)
  }
  const activeSalePoints = useMemo(
    () => (salePointsQuery.data ?? []).filter((p) => p.active),
    [salePointsQuery.data],
  )
  const [salePoint, setSalePoint] = useState<number | null>(null)
  const effectiveSalePoint = salePoint ?? activeSalePoints[0]?.number ?? null
  const numberQuery = useQuery({
    queryKey: ['sales', 'nextNumber', voucherType],
    queryFn: () => api.sales.getNextNumber(voucherType),
  })

  const [cart, setCart] = useState<CartLine[]>([])
  const [globalDiscount, setGlobalDiscount] = useState('0')
  // El descuento global puede ingresarse como importe ($) o como porcentaje (%).
  // En modo %, se traduce a importe sobre el subtotal antes de calcular/enviar.
  const [discountIsPct, setDiscountIsPct] = useState(false)
  const [isAccountSale, setIsAccountSale] = useState(false)
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false)
  const [articlePickerOpen, setArticlePickerOpen] = useState(false)
  const [promoPickerOpen, setPromoPickerOpen] = useState(false)
  const [rapidoOpen, setRapidoOpen] = useState(false)
  const canDevolver = usePermission('void_sale') && canWrite
  const [devolucionPickerOpen, setDevolucionPickerOpen] = useState(false)
  const [returningSaleId, setReturningSaleId] = useState<string | null>(null)
  const [barcode, setBarcode] = useState('')
  const barcodeRef = useRef<HTMLInputElement>(null)
  /**
   * Renglón marcado del desplegable, para moverse con las flechas.
   * -1 = ninguno: Enter usa el criterio de siempre (código exacto, o el primer
   * resultado), que es lo que necesita el lector de códigos.
   */
  const [highlight, setHighlight] = useState(-1)
  const suggestionsRef = useRef<HTMLDivElement>(null)
  // Medio de pago seleccionado en modo mono-medio (default: efectivo).
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  // Modo mixto explícito (toggle "Pago Mixto"): expone el split N-filas.
  const [mixedMode, setMixedMode] = useState(false)
  // Lista de precios activa del PDV (override del selector). Default Lista 1.
  // Manda sobre la lista del cliente cuando el operador la cambia a mano.
  const [selectedPriceList, setSelectedPriceList] = useState<1 | 2 | 3>(1)
  // Última venta confirmada (para "Imprimir último ticket" manual).
  const [lastSaleResult, setLastSaleResult] = useState<{
    ticketData: SaleTicketData
    printerCfg: PrinterConfigDTO | null
  } | null>(null)
  // Toggle "Imprimir ticket automáticamente". Valor inicial = config; al
  // cambiarlo se persiste en la config (se recuerda entre sesiones).
  const [autoPrintOnSale, setAutoPrintOnSale] = useState(true)
  const [autoPrintSeeded, setAutoPrintSeeded] = useState(false)
  // Sembrar el toggle desde la config persistida una sola vez (undefined→true).
  if (!autoPrintSeeded && printerConfigQuery.data !== undefined) {
    setAutoPrintSeeded(true)
    setAutoPrintOnSale(printerConfigQuery.data?.autoPrintOnSale !== false)
  }
  function toggleAutoPrint(next: boolean): void {
    setAutoPrintOnSale(next)
    const cfg = printerConfigQuery.data
    if (cfg) {
      // Persistir el cambio en la config (mismo flag que Configuración).
      api.hardware.printer
        .setConfig({ ...cfg, autoPrintOnSale: next })
        .then(() => printerConfigQuery.refetch())
        .catch(() => {})
    }
  }

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

  const lineInputs = cart.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, vatRate: l.vatRate }))
  // Subtotal sin descuento global, base para traducir el % a importe.
  const subtotalBase = Number(calculateSaleTotals(lineInputs, '0', priceMode).subtotal)
  const globalDiscountAbs = discountIsPct
    ? ((subtotalBase * (Number(parseCurrencyInput(globalDiscount)) || 0)) / 100).toFixed(4)
    : parseCurrencyInput(globalDiscount)
  const totals = calculateSaleTotals(lineInputs, globalDiscountAbs, priceMode)
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
      const idx = prev.findIndex((l) => l.article?.id === article.id)
      if (idx >= 0) {
        const next = [...prev]
        const line = next[idx]!
        const newQty = (Number(line.quantity) + Number(qty)).toString()
        next[idx] = {
          ...line,
          quantity: newQty,
          unitPrice: line.priceManuallySet ? line.unitPrice : resolvePrice(article, selectedCustomer, newQty, selectedPriceList),
        }
        return next
      }
      return [
        ...prev,
        {
          article,
          vatRate: article.vatRate,
          quantity: qty,
          unitPrice: resolvePrice(article, selectedCustomer, qty, selectedPriceList),
          discount: '0',
          priceManuallySet: false,
        },
      ]
    })
  }
  /**
   * Agrega una línea escrita a mano. No busca ni crea artículo: la descripción
   * y el precio son los que puso el cajero, y el precio NUNCA se recalcula por
   * lista de cliente (no hay ficha de la que sacarlo).
   */
  function addArticuloRapido(r: ArticuloRapido): void {
    setCart((prev) => [
      ...prev,
      {
        description: r.description,
        vatRate: r.vatRate,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
        discount: '0',
        priceManuallySet: true,
      },
    ])
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
        unitPrice:
          line.priceManuallySet || !line.article
            ? line.unitPrice
            : resolvePrice(line.article, selectedCustomer, value, selectedPriceList),
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
  /** Cambiar de cliente vuelve a dejar que el tipo lo decida el sistema. */
  function elegirCliente(id: string | null): void {
    setCustomerId(id)
    setTipoForzado(false)
  }

  function clearSale(): void {
    setCart([])
    setGlobalDiscount('0')
    setDiscountIsPct(false)
    setIsAccountSale(false)
    setMixedMode(false)
    split.reset()
    // La búsqueda SÍ se limpia acá: durante la venta el desplegable queda
    // abierto para cargar varios del mismo resultado, pero terminada la venta
    // la siguiente arranca de cero, sin la lista de la anterior tapando.
    setBarcode('')
    barcodeRef.current?.focus()
  }
  function pickCustomer(c: CustomerDTO): void {
    elegirCliente(c.id)
    setCustomerPickerOpen(false)
    // Autocompletar la lista de precios con la ASIGNADA al cliente (sin lista
    // válida → Lista 1). Vale también para clientes con documento "Consumidor
    // Final": si tienen lista asignada, esa manda. Se puede cambiar a mano después.
    const rawList = Number(c.priceList)
    const list: 1 | 2 | 3 = rawList === 2 ? 2 : rawList === 3 ? 3 : 1
    setSelectedPriceList(list)
    setCart((prev) =>
      prev.map((l) =>
        l.priceManuallySet || !l.article
          ? l
          : { ...l, unitPrice: resolvePrice(l.article, c, l.quantity, list) },
      ),
    )
    if (isCfCustomer(c)) setIsAccountSale(false)
    barcodeRef.current?.focus()
  }

  // Cambio manual del selector de lista: re-resolver las líneas NO editadas a mano.
  function changePriceList(list: 1 | 2 | 3): void {
    setSelectedPriceList(list)
    setCart((prev) =>
      prev.map((l) =>
        l.priceManuallySet || !l.article
          ? l
          : { ...l, unitPrice: resolvePrice(l.article, selectedCustomer, l.quantity, list) },
      ),
    )
  }

  // --- búsqueda de productos ---
  const pdvSearchCtx = useMemo(
    () => buildSearchContext(familiesQuery.data, suppliersQuery.data),
    [familiesQuery.data, suppliersQuery.data],
  )
  const exactByBarcode = useMemo(() => {
    const v = barcode.trim()
    return v ? allArticles.find((a) => a.barcode === v) ?? null : null
  }, [barcode, allArticles])
  const suggestions = useMemo(() => {
    const v = barcode.trim().toLowerCase()
    // Vista previa SIEMPRE que haya texto (aunque exista match exacto): al escribir
    // NÚMEROS deben verse los resultados, igual que el resto de los buscadores.
    // Match por SUBSTRING en código + descripción + marca (mismo criterio que el
    // buscador completo); orden por relevancia: exacto → empieza con → contiene.
    if (v.length < 1) return []
    const matches = allArticles.filter((a) => articleMatches(a, v, pdvSearchCtx))
    const rank = (a: ArticleDTO): number => {
      const bc = a.barcode.toLowerCase()
      return bc === v ? 0 : bc.startsWith(v) ? 1 : 2
    }
    // Sin recorte agresivo: mostramos TODOS los que matchean (con tope de
    // seguridad alto, igual que "Ver todos") y el desplegable scrollea.
    return [...matches].sort((a, b) => rank(a) - rank(b)).slice(0, 300)
  }, [barcode, allArticles, pdvSearchCtx])

  // Con 300 resultados la marca se va de pantalla enseguida: la lista la sigue.
  // `block: 'nearest'` mueve lo mínimo, sin saltos molestos.
  useEffect(() => {
    if (highlight < 0) return
    const fila = suggestionsRef.current?.children[highlight]
    if (fila instanceof HTMLElement) fila.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  function commitBarcode(): void {
    const v = barcode.trim()
    if (!v) return
    // Si el cajero se movió con las flechas, manda lo que eligió.
    const marcado = highlight >= 0 ? suggestions[highlight] : undefined
    if (marcado) {
      addArticle(marcado)
    } else if (exactByBarcode) {
      addArticle(exactByBarcode)
    } else if (suggestions.length > 0) {
      addArticle(suggestions[0]!)
    } else {
      toast.error('No se encontró el producto')
      return
    }
    // La búsqueda NO se borra: la lista queda abierta y se puede seguir
    // cargando de los mismos resultados, igual que haciendo clic.
    //
    // El texto queda SELECCIONADO para que el lector de códigos siga andando:
    // el próximo escaneo lo pisa entero en vez de encadenarse al anterior.
    // Escribiendo a mano pasa lo mismo, y con Escape se cierra la lista.
    barcodeRef.current?.focus()
    barcodeRef.current?.select()
  }

  // --- cuenta corriente ---
  // Cualquier cliente cargado puede comprar en cuenta corriente: fiar no es
  // emitir un comprobante fiscal. El documento se valida al FACTURAR, que es
  // donde de verdad hace falta.
  const accountEligible = selectedCustomer != null
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

  // ── Comisión del medio de pago (FEATURE #1, sólo informativo para el vendedor) ──
  // El comercio ABSORBE la comisión; el cliente paga el total normal. Acá se
  // muestra al vendedor cuánto se lleva el medio y cuánto NETO entra a caja.
  // NUNCA se agrega al ticket ni al total que paga el cliente.
  const commissionByPct = useMemo(() => new Map(activeMethods.map((m) => [m.id, Number(m.commissionPct)])), [activeMethods])
  const commissionTotal = useMemo(() => {
    if (accountSale) return 0
    let sum = 0
    if (mixedMode) {
      for (const p of split.payments) {
        const pct = commissionByPct.get(p.paymentMethodId) ?? 0
        if (pct > 0) sum += (Number(p.amount) * pct) / 100
      }
    } else if (selectedMethod) {
      const pct = Number(selectedMethod.commissionPct)
      if (pct > 0) sum += (totalNum * pct) / 100
    }
    return sum
  }, [accountSale, mixedMode, split.payments, selectedMethod, commissionByPct, totalNum])
  const netToCash = totalNum - commissionTotal

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

  /**
   * El QR de ARCA como imagen. Se dibuja LOCALMENTE: el comprobante tiene que
   * poder imprimirse aunque no haya internet en el momento.
   */
  async function qrComoImagen(url: string): Promise<string | null> {
    try {
      const QR = await import('qrcode')
      return await QR.toDataURL(url, { margin: 0, width: 220 })
    } catch {
      return null
    }
  }

  function buildTicket(result: CreateSaleResultDTO): SaleTicketData {
    const customer = selectedCustomer
    const cf = isCfCustomer(customer)
    const artById = new Map(
      cart.filter((l) => l.article).map((l) => [l.article!.id, l.article!]),
    )
    const lines: SaleTicketLine[] = result.lines.map((l) => {
      // Artículo rápido: no hay ficha que consultar, la línea se describe sola.
      const art = l.articleId ? artById.get(l.articleId) : undefined
      return {
        description: art?.description ?? l.description ?? '—',
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        code: art?.barcode ?? null,
        vatRate: l.vatRate,
        discount: l.discount,
      }
    })
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
      customerVatCondition: cf || !customer ? null : VAT_CONDITION_LABELS[customer.category] ?? null,
      sellerName: currentUser?.fullName ?? null,
      isAccountSale: result.sale.isAccountSale,
      payments: ticketPayments,
    }
  }

  /**
   * Imprime el ticket de una venta ya registrada. El ticket SIEMPRE sale
   * (salvo que no haya ninguna impresora). Respeta el toggle de Configuración:
   *  - `silentPrint === false` → el usuario eligió "Imprimir con diálogo del
   *    sistema": se imprime con `printNode` (window.print + diálogo del SO),
   *    exactamente el mismo mecanismo que "Probar impresión".
   *  - cualquier otro valor (default) → impresión automática vía `lp` (sin
   *    diálogo). Si el PDF o `lp` fallan, cae automáticamente al diálogo del SO
   *    para que el ticket salga igual. Si no hay NINGUNA impresora, el PDF
   *    queda en el Escritorio.
   * Si la impresión falla por completo, NO revierte la venta — sólo avisa.
   */
  async function printSaleTicket(
    ticketData: SaleTicketData,
    _result: CreateSaleResultDTO,
    printerCfg: PrinterConfigDTO | null,
  ): Promise<void> {
    // Delegado al helper compartido: térmica del sistema → ESC/POS crudo al
    // spooler (silent real); si no, o si falla, diálogo del SO. Mismo camino que
    // "Reimprimir" en Historial → comportamiento consistente.
    await printSaleTicketSilent(ticketData, printerCfg)
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
        discount: globalDiscountAbs,
        notes: null,
        lines: cart.map((l) => ({
          articleId: l.article?.id,
          description: l.article ? undefined : l.description,
          quantity: parseCurrencyInput(l.quantity),
          unitPrice: parseCurrencyInput(l.unitPrice),
          discount: parseCurrencyInput(l.discount),
          vatRate: l.vatRate,
        })),
      })
      // La venta YA quedó registrada y pegó en caja. Avisamos al operador y
      // reseteamos el form ANTES de imprimir: el aviso + el reset NO deben
      // depender del ticket. Si la impresión falla o se CUELGA (diálogo sin
      // cerrar, lp trabado), la venta igual está hecha y el operador no queda
      // trabado ni con riesgo de vender 2 veces (BUG-OP-03b).
      toast.success(
        `Venta ${result.sale.type} #${result.sale.number} registrada — ${formatCurrency(result.sale.total)}`,
      )

      // Facturación electrónica: si está activa y el comprobante es fiscal, se
      // pide el CAE a ARCA. La VENTA ya está registrada, así que un fallo acá no
      // la pierde: se avisa y queda para reintentar desde el Historial.
      // Se ESPERA el CAE antes de imprimir. Antes se pedía en paralelo y el
      // ticket salía sin CAE ni QR —un comprobante fiscal así no es válido—
      // porque cuando se imprimía la respuesta de ARCA todavía no había
      // llegado. Si ARCA falla, la venta YA está registrada: se avisa y se
      // imprime igual, para reintentar después desde el Historial.
      let fiscal: SaleTicketData['fiscal'] = null
      // Comprobante fiscal sin poder emitirlo: se avisa fuerte. Imprimir una
      // "FACTURA A" sin CAE es entregar un documento inválido.
      if (voucherType !== 'X' && (!fiscalEnabled || effectiveSalePoint == null)) {
        toast.error(
          !fiscalEnabled
            ? 'La facturación electrónica está DESACTIVADA: la venta quedó como comprobante interno, sin CAE. Activala en Contabilidad → Facturación Electrónica.'
            : 'Falta elegir el punto de venta: la venta quedó sin CAE.',
          { duration: 15_000 },
        )
      }
      if (fiscalEnabled && voucherType !== 'X' && effectiveSalePoint != null) {
        try {
          const v = await api.fiscal.issueInvoice({
            saleId: result.sale.id,
            salePoint: effectiveSalePoint,
            letter: voucherType,
          })
          fiscal = {
            cae: v.cae,
            caeExpiry: v.caeExpiry,
            qrDataUrl: v.qrUrl ? await qrComoImagen(v.qrUrl) : null,
            letter: v.letter,
          }
          toast.success(
            `${v.label} ${String(v.salePoint).padStart(5, '0')}-${String(v.number).padStart(8, '0')} — CAE ${v.cae}`,
            { duration: 10_000 },
          )
          if (v.observations.length > 0) {
            toast.warning(`ARCA observó: ${v.observations.join(' · ')}`, { duration: 12_000 })
          }
        } catch (err: unknown) {
          toast.error(
            `La venta quedó registrada pero ARCA no la autorizó: ${
              err instanceof Error ? err.message : 'error desconocido'
            }. Podés reintentar desde el Historial de Ventas.`,
            { duration: 15_000 },
          )
        }
      }

      clearSale()
      void numberQuery.refetch()

      const printerCfg = printerConfigQuery.data ?? null
      // Cajón de dinero (fire-and-forget) si la venta llevó efectivo.
      if (printerCfg?.autoOpenDrawer && !result.sale.isAccountSale) {
        const cashMethodId = activeMethods.find((m) => m.type === 'cash')?.id
        const hasCash =
          cashMethodId != null &&
          result.payments.some((p) => p.paymentMethodId === cashMethodId && Number(p.amount) > 0)
        if (hasCash) {
          api.hardware.cashDrawer.open().catch(() => {})
        }
      }
      // Guardamos SIEMPRE el último ticket para "Imprimir último ticket".
      const ticketData = { ...buildTicket(result), fiscal }
      setLastSaleResult({ ticketData, printerCfg })
      // Impresión AISLADA: no se await-ea → nunca bloquea el reset.
      // Sólo se imprime si el toggle "Imprimir ticket automáticamente" está ON.
      if (autoPrintOnSale) {
        void printSaleTicket(ticketData, result, printerCfg).catch((e) => {
          console.warn('[venta] impresión del ticket falló:', e)
        })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar la venta')
    }
  }

  // Imprime manualmente la ÚLTIMA venta confirmada (útil con auto-print apagado).
  async function imprimirUltimoTicket(): Promise<void> {
    if (!lastSaleResult) return
    try {
      await printSaleTicketSilent(lastSaleResult.ticketData, lastSaleResult.printerCfg)
    } catch (e) {
      console.warn('[venta] reimpresión del último ticket falló:', e)
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
        discount: globalDiscountAbs,
        notes: mpPaymentId ? `MP Payment ID: ${mpPaymentId}` : null,
        lines: cart.map((l) => ({
          articleId: l.article?.id,
          description: l.article ? undefined : l.description,
          quantity: parseCurrencyInput(l.quantity),
          unitPrice: parseCurrencyInput(l.unitPrice),
          discount: parseCurrencyInput(l.discount),
          vatRate: l.vatRate,
        })),
      })
      await api.mpQr.linkOrderToSale(orderId, result.sale.id).catch(() => {})
      toast.success(
        `Venta ${result.sale.type} #${result.sale.number} cobrada con MercadoPago QR — ${formatCurrency(result.sale.total)}`,
      )
      // Reset ANTES de imprimir (mismo criterio que confirmar): el ticket no
      // bloquea. La venta ya quedó registrada y avisada arriba.
      clearSale()
      void numberQuery.refetch()
      const ticketData = buildTicket(result)
      const printerCfg = printerConfigQuery.data ?? null
      setLastSaleResult({ ticketData, printerCfg })
      if (autoPrintOnSale) {
        void printSaleTicket(ticketData, result, printerCfg).catch((e) => {
          console.warn('[venta] impresión del ticket falló:', e)
        })
      }
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
      if (e.key === 'F10') {
        e.preventDefault()
        e.stopPropagation()
        setRapidoOpen(true)
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
      <div className="grid grid-cols-5 gap-3 rounded-lg border bg-card p-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Label>Cliente</Label>
          <Button variant="outline" className="w-full justify-between" onClick={() => setCustomerPickerOpen(true)}>
            <span className="truncate">
              {selectedCustomer ? `${selectedCustomer.lastName}${selectedCustomer.firstName ? `, ${selectedCustomer.firstName}` : ''}` : 'Cargando…'}
            </span>
            <Search className="h-4 w-4 shrink-0 opacity-60" />
          </Button>
          {selectedCustomer && (selectedCustomer.docNumber || Number(customerDebt) > 0) && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {selectedCustomer.docNumber && <span>{selectedCustomer.docType} {selectedCustomer.docNumber}</span>}
              {Number(customerDebt) > 0 && <Badge variant="warning">Saldo {formatCurrency(customerDebt)}</Badge>}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="pdv-pricelist">Lista de precios</Label>
          <Select
            id="pdv-pricelist"
            value={String(selectedPriceList)}
            onChange={(e) => changePriceList(Number(e.target.value) as 1 | 2 | 3)}
          >
            <option value="1">Lista 1</option>
            <option value="2">Lista 2</option>
            <option value="3">Lista 3</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>Comprobante</Label>
          <Select
            value={voucherType}
            onChange={(e) => {
              setVoucherType(e.target.value as VoucherType)
              setTipoForzado(true)
            }}
          >
            {voucherOptions(fiscalEnabled).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {fiscalEnabled && voucherType !== 'X' && activeSalePoints.length > 1 && (
            <Select
              value={String(effectiveSalePoint ?? '')}
              onChange={(e) => setSalePoint(Number(e.target.value))}
              className="mt-1"
            >
              {activeSalePoints.map((p) => (
                <option key={p.id} value={p.number}>
                  Pto. venta {String(p.number).padStart(5, '0')} — {p.description}
                </option>
              ))}
            </Select>
          )}
          {!fiscalEnabled && voucherType !== 'X' && (
            <span className="text-xs text-destructive">
              La facturación electrónica no está activa: se registrará sin CAE.
            </span>
          )}
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
        <div className="col-span-5 flex items-center justify-between text-xs text-muted-foreground">
          <span>Vendedor: {currentUser?.fullName}</span>
          <Badge variant={priceMode === 'gross' ? 'outline' : 'warning'}>
            Modo: Precios {priceMode === 'gross' ? 'con IVA incluido' : 'netos + IVA'}
          </Badge>
        </div>
      </div>

      {/* ── Zona central: carrito ── */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          <div className="relative w-1/2">
            <ShoppingCart className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={barcodeRef}
              className="h-11 pl-10 text-base"
              placeholder="Código o nombre del producto — escaneá o escribí y Enter"
              value={barcode}
              onChange={(e) => {
                setBarcode(e.target.value)
                // Otra búsqueda, otra lista: la marca vuelve a cero.
                setHighlight(-1)
              }}
              onKeyDown={(e) => {
                // Flechas para recorrer el desplegable sin soltar el teclado.
                if (e.key === 'ArrowDown' && suggestions.length > 0) {
                  e.preventDefault()
                  setHighlight((h) => (h + 1 >= suggestions.length ? 0 : h + 1))
                  return
                }
                if (e.key === 'ArrowUp' && suggestions.length > 0) {
                  e.preventDefault()
                  setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
                  return
                }
                if (e.key === 'Enter') commitBarcode()
                if (e.key === 'Escape' && barcode.trim() !== '') {
                  setBarcode('')
                  setHighlight(-1)
                }
              }}
            />
            {suggestions.length > 0 && (
              <div
                ref={suggestionsRef}
                className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-md border bg-popover shadow-md"
              >
                {suggestions.map((a, idx) => (
                  <button
                    key={a.id}
                    type="button"
                    // Al pasar el mouse la marca lo sigue: si después usa las
                    // flechas, arrancan de donde está mirando.
                    onMouseEnter={() => setHighlight(idx)}
                    // La lista NO se cierra al agregar: buscando "lapicera" se
                    // cargan tres seguidas sin volver a escribir la búsqueda.
                    // Se cierra con Escape, o escribiendo otra cosa.
                    //
                    // Se comporta igual por clic que por Enter (`commitBarcode`).
                    onClick={() => {
                      addArticle(a)
                      barcodeRef.current?.focus()
                      barcodeRef.current?.select()
                    }}
                    // SIN `hover:` del CSS a propósito: si el mouse pintara su
                    // propio renglón, con el teclado en otro se verían DOS
                    // marcados y no se sabría cuál carga el Enter. El resaltado
                    // sale sólo de `highlight`, y el mouse lo mueve al entrar
                    // (onMouseEnter), así teclado y mouse son la misma marca.
                    className={cn(
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm',
                      idx === highlight && 'bg-accent text-accent-foreground',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-xs text-muted-foreground">{a.barcode}</span> · {a.description}
                    </span>
                    {a.brand && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">{a.brand}</span>}
                    <span className="shrink-0 tabular-nums">{formatCurrency(resolvePrice(a, selectedCustomer, '1', selectedPriceList))}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => setArticlePickerOpen(true)}
          >
            <List className="mr-2 h-4 w-4" />
            Ver todos
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 border-primary/30 text-primary hover:bg-primary/10"
            onClick={() => setPromoPickerOpen(true)}
            title="Agregar una promoción al carrito"
          >
            <BadgePercent className="mr-2 h-4 w-4" />
            Promos
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => setRapidoOpen(true)}
            title="Cobrar algo que no está en el catálogo (F10)"
          >
            <Zap className="mr-2 h-4 w-4" />
            Rápido [F10]
          </Button>
          {canDevolver && (
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => setDevolucionPickerOpen(true)}
              title="Registrar la devolución de una venta reciente"
            >
              <Undo2 className="mr-2 h-4 w-4" />
              Devolución
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-1.5">Producto</th>
                <th className="w-32 px-2 py-1.5">Marca</th>
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
                  <td colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                    Carrito vacío — escaneá o buscá un producto para empezar.
                  </td>
                </tr>
              ) : (
                cart.map((l, i) => {
                  // El artículo rápido no tiene stock que controlar: no está en
                  // el inventario, por definición.
                  const overStock = l.article ? Number(l.quantity) > Number(l.article.stock) : false
                  return (
                    <tr key={l.article?.id ?? `rapido-${i}`} className="border-t">
                      <td className="px-2 py-1">
                        <div className="font-medium">{cartLineLabel(l)}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {l.article ? (
                            l.article.barcode
                          ) : (
                            <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-700 dark:text-amber-400">
                              artículo rápido
                            </span>
                          )}
                          {overStock && l.article && (
                            <span className="ml-2 text-destructive">Stock: {formatQty(l.article.stock)}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-1 text-sm text-muted-foreground">{l.article?.brand ?? ''}</td>
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
                        <CurrencyInput
                          className="h-8 text-right tabular-nums"
                          value={l.unitPrice}
                          onChange={(v) => setLinePrice(i, v)}
                        />
                      </td>
                      <td className="px-2 py-1">
                        <CurrencyInput
                          className="h-8 text-right tabular-nums"
                          value={l.discount}
                          onChange={(v) => setLineDiscount(i, v)}
                        />
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums font-medium">
                        {formatCurrency(lineTotal(l))}
                        {priceMode === 'net' && (
                          <div className="text-[10px] font-normal text-muted-foreground">
                            c/IVA {formatCurrency(vatBreakdown(lineTotal(l), l.vatRate, 'net').gross.toFixed(4))}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(i)} title="Quitar producto de la venta">
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
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => { setDiscountIsPct((v) => !v); setGlobalDiscount('0') }}
                className="h-7 w-7 shrink-0 rounded-md border text-xs font-semibold hover:bg-accent"
                title={discountIsPct ? 'Cambiar a importe ($)' : 'Cambiar a porcentaje (%)'}
              >
                {discountIsPct ? '%' : '$'}
              </button>
              {discountIsPct ? (
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={globalDiscount}
                  onChange={(e) => setGlobalDiscount(e.target.value)}
                  className="h-7 w-28 rounded-md border bg-background px-2 text-right text-sm tabular-nums"
                />
              ) : (
                <CurrencyInput
                  className="h-7 w-28 text-right tabular-nums"
                  value={globalDiscount}
                  onChange={setGlobalDiscount}
                />
              )}
            </div>
          </div>
          {discountIsPct && (Number(parseCurrencyInput(globalDiscount)) || 0) > 0 && (
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{parseCurrencyInput(globalDiscount)}% sobre subtotal</span>
              <span className="tabular-nums">−{formatCurrency(globalDiscountAbs)}</span>
            </div>
          )}
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
              {overCredit ? (
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
              <button
                type="button"
                onClick={() => openWindow('medios-de-pago')}
                className="font-medium underline"
              >
                Configurar medios de pago
              </button>
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

          {/* Detalle de comisión del medio de pago (SOLO para el vendedor).
              El comercio absorbe la comisión; el cliente paga el TOTAL normal. */}
          {!accountSale && commissionTotal > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs dark:border-amber-700 dark:bg-amber-950">
              <div className="flex justify-between text-amber-700 dark:text-amber-300">
                <span>Comisión del medio de pago</span>
                <span className="tabular-nums">− {formatCurrency(commissionTotal.toFixed(4))}</span>
              </div>
              <div className="flex justify-between font-medium">
                <span>Neto que entra a caja</span>
                <span className="tabular-nums">{formatCurrency(netToCash.toFixed(4))}</span>
              </div>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                El cliente paga el total; la comisión la absorbe el comercio (no se discrimina en el ticket).
              </p>
            </div>
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
          <label className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              checked={autoPrintOnSale}
              onChange={(e) => toggleAutoPrint(e.target.checked)}
            />
            <span>Imprimir ticket automáticamente</span>
          </label>
          <Button
            variant="success"
            className="h-14 text-lg"
            disabled={!canConfirm}
            onClick={() => void confirmar()}
          >
            {createSale.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
            Confirmar venta (F2) — {formatCurrency(totals.total)}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!lastSaleResult}
            onClick={() => void imprimirUltimoTicket()}
            title={lastSaleResult ? undefined : 'Todavía no hay ninguna venta confirmada en esta sesión'}
          >
            <Printer className="h-4 w-4" />
            Imprimir último ticket
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
      <DevolucionPicker
        open={devolucionPickerOpen}
        customers={customersQuery.data ?? []}
        onClose={() => setDevolucionPickerOpen(false)}
        onPick={(saleId) => {
          setDevolucionPickerOpen(false)
          setReturningSaleId(saleId)
        }}
      />
      {returningSaleId && (
        <ReturnSaleDialog
          saleId={returningSaleId}
          open
          onClose={() => setReturningSaleId(null)}
          onDone={() => {
            void articlesQuery.refetch()
          }}
        />
      )}
      {rapidoOpen && (
        <ArticuloRapidoDialog
          onAdd={addArticuloRapido}
          onClose={() => {
            setRapidoOpen(false)
            barcodeRef.current?.focus()
          }}
        />
      )}
      <PromoPicker
        open={promoPickerOpen}
        articles={allArticles}
        onClose={() => {
          setPromoPickerOpen(false)
          barcodeRef.current?.focus()
        }}
        onPick={(a) => addArticle(a)}
      />
      <ArticlePicker
        open={articlePickerOpen}
        articles={allArticles}
        families={familiesQuery.data ?? []}
        suppliers={suppliersQuery.data ?? []}
        onClose={() => {
          setArticlePickerOpen(false)
          barcodeRef.current?.focus()
        }}
        onPick={(a) => addArticle(a)}
      />
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
