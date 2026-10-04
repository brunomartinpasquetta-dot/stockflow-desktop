import { useEffect, useMemo, useRef, useState } from 'react'

import { useWindowSelf } from '@/contexts/WindowManagerContext'
import { useWindowNav } from '@/lib/useWindowNav'
import { toast } from 'sonner'
import { Loader2, ScanLine, Search, ShoppingCart, Smartphone, Trash2, Wallet, X } from 'lucide-react'

import { api } from '@/lib/api'
import { cargaTelefonoVisible, intervaloEstadoCompras, type PrefillDeFactura } from '@/lib/facturaACompra'
import { CargaTelefonoCompras } from '@/components/CargaTelefonoCompras'
import {
  useArticles,
  useCompany,
  useCurrentCash,
  useCashGeneralBalance,
  useFamilies,
  usePaymentMethods,
  useSuppliers,
} from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
import { calculateSaleTotals, lineTotal, vatBreakdown } from '@/lib/pricing'
import { formatCurrency, formatDate, parseCurrencyInput } from '@/lib/format'
import { todayIso } from '@/lib/periodPresets'
import { articleMatches, buildSearchContext } from '@/lib/articleSearch'
import { CurrencyInput } from '@/components/ui/currency-input'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PaymentSplitInput } from '@/components/PaymentSplitInput'
import { PaymentMethodSelect } from '@/components/PaymentMethodSelect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { SupplierPicker } from '@/components/SupplierPicker'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { hasPermissionFor } from '@/lib/permissions'
import type { ArticleDTO, PriceMode, VoucherType } from '@/types/api'

interface CompraLine {
  article: ArticleDTO
  quantity: string
  costPrice: string
  vatRate: string
  /**
   * Precio nuevo POR LISTA, editable en pantalla. En modo manual arranca con
   * el precio vigente; en modo utilidad, con costo × margen (redondeado). El
   * usuario puede pisar cualquiera —por ejemplo si el redondeo no le sirve—
   * y `editado` recuerda cuáles tocó para no recalcularle encima.
   */
  nl1: string
  nl2: string
  nl3: string
  editado1: boolean
  editado2: boolean
  editado3: boolean
  /** Vino de una factura escaneada con el artículo sugerido por el sistema (por parecido): hay que controlarlo. */
  sugerido?: boolean
  /**
   * Renglón precargado desde la factura escaneada. Al registrar la compra, la
   * factura se marca «Cargada» sólo si queda alguno de ESTOS renglones: una
   * compra armada a mano después de quitarlos no es esa factura.
   */
  deFactura?: boolean
}

/** Identificador de ESTA pantalla de Compras, para que la revisión le devuelva su factura y no la de otro puesto. */
function nuevaPantalla(): string {
  return `compras-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Lo que puede llegar precargado: desde "Generador de compras" (P-CONSULTAS) o
 * desde una factura escaneada (que trae además el encabezado del comprobante,
 * sus avisos y un `lote` distinto en cada pasaje).
 */
type Prefill = {
  prefilledLines?: Array<{ articleId: string; quantity: string; unitPrice?: string; vatRate?: string; sugerido?: boolean }>
  /** Factura escaneada de la que sale el pasaje, y sus códigos de proveedor → artículo. */
  facturaId?: string
  vinculos?: Array<{ code: string; articleId: string; unitsPerPack?: number }>
  header?: {
    supplierId?: string | null
    voucherType?: VoucherType
    invoiceNumber?: string | null
    dateIso?: string | null
    /** Descuento global, en la misma base que los costos. */
    discount?: string | null
  }
  /** Avisos de la factura escaneada ("Esta factura ya fue cargada el …"). */
  avisos?: string[]
  from?: string
  lote?: number | string
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

function isoToTs(iso: string): number | undefined {
  if (!iso) return undefined
  const ts = new Date(`${iso}T12:00:00`).getTime()
  return Number.isFinite(ts) ? ts : undefined
}

export function Compras() {
  const { currentUser } = useAuth()
  const canWrite = useCanWrite()
  const openInWindow = useWindowNav()
  const windowSelf = useWindowSelf()
  const articlesQuery = useArticles()
  const suppliersQuery = useSuppliers()
  const familiesQuery = useFamilies()
  const searchCtx = useMemo(
    () => buildSearchContext(familiesQuery.data, suppliersQuery.data),
    [familiesQuery.data, suppliersQuery.data],
  )
  const paymentMethodsQuery = usePaymentMethods()
  const companyQuery = useCompany()
  const currentCash = useCurrentCash()
  const cashGeneralBalance = useCashGeneralBalance()
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

  // Facturas por teléfono: los botones aparecen sólo con la opción activa. Si
  // la consulta falla (función no disponible en esta PC) no se muestra nada.
  // El contador sale del mismo estado (un número, no la lista entera) y sólo
  // se sondea con la opción activa: apagada, Compras queda como siempre.
  const facturasEstado = useQuery({
    queryKey: ['facturas', 'estado'],
    queryFn: () => api.facturas.estado(),
    retry: false,
    staleTime: 30_000,
    refetchInterval: (q) => intervaloEstadoCompras(q.state.data),
  })
  const facturasActivas = cargaTelefonoVisible(facturasEstado.data)
  const facturasListas = facturasEstado.data?.listas ?? 0
  const [cargaTelefono, setCargaTelefono] = useState(false)
  /** Avisos de la factura escaneada que precargó esta compra ("Esta factura ya fue cargada el …"). */
  const [avisosFactura, setAvisosFactura] = useState<string[]>([])
  /**
   * La factura escaneada que precargó esta compra. Recién cuando la compra se
   * REGISTRA se la marca como cargada y se recuerdan los códigos del proveedor
   * (antes sigue «Lista»: si la compra no se confirma, no se pierde de vista).
   */
  const facturaOrigenRef = useRef<{ id: string; vinculos: { code: string; articleId: string; unitsPerPack?: number }[] } | null>(null)
  /** Identificador de esta pantalla (ver `nuevaPantalla`). */
  const pantallaRef = useRef<string | null>(null)
  pantallaRef.current ??= nuevaPantalla()
  /** Pasaje que llegó con una compra a medio armar: se pregunta antes de reemplazarla. */
  const [prefillPendiente, setPrefillPendiente] = useState<Prefill | null>(null)

  const [cart, setCart] = useState<CompraLine[]>([])
  const cartLength = cart.length
  // Lo último que hay en el carrito, para quien pregunta DESPUÉS de un await
  // (el diálogo del teléfono): una prop capturada antes puede estar vieja.
  const cartLengthRef = useRef(0)
  cartLengthRef.current = cartLength
  const [globalDiscount, setGlobalDiscount] = useState('0')
  /**
   * Cómo impacta la compra en los precios de venta:
   *  - 'none'   → no toca nada (default).
   *  - 'manual' → lo que el usuario ponga en cada renglón (histórico).
   *  - 'margin' → recalcula TODAS las listas con el % de utilidad guardado en
   *    cada artículo (costo nuevo × margen), redondeado a peso entero.
   * Es UN selector y no dos tildes: dos tildes que se pisan son una trampa.
   */
  const [priceMode2, setPriceMode2] = useState<'none' | 'manual' | 'margin'>('none')
  const updatePrices = priceMode2 !== 'none'
  const [isAccountPurchase, setIsAccountPurchase] = useState(false)
  const [fundingSource, setFundingSource] = useState<'daily' | 'general'>('daily')
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false)
  const [barcode, setBarcode] = useState('')
  const barcodeRef = useRef<HTMLInputElement>(null)
  const [today] = useState(() => formatDate(Date.now()))
  // Pago mono-medio (default) + toggle a mixto.
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null)
  const [mixedMode, setMixedMode] = useState(false)

  // Inicializar / corregir el medio de pago mono-medio default (efectivo).
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

  const selectedMethod = useMemo(
    () => activeMethods.find((m) => m.id === selectedMethodId) ?? null,
    [activeMethods, selectedMethodId],
  )

  useEffect(() => {
    barcodeRef.current?.focus()
  }, [])

  const totals = calculateSaleTotals(
    cart.map((l) => ({ quantity: l.quantity, unitPrice: l.costPrice, vatRate: l.vatRate })),
    parseCurrencyInput(globalDiscount),
    priceMode,
  )
  const totalNum = Number(totals.total)
  const split = usePaymentSplit(activeMethods, totalNum)

  const noCash = !isAccountPurchase && fundingSource === 'daily' && !currentCash.data
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
        // El campo de precio de venta arranca con el precio VIGENTE: se ve y
        // se pisa ahí mismo. Si queda igual, al guardar no se toca (ver submit).
        {
          article, quantity: '1', costPrice: article.costPrice, vatRate: article.vatRate,
          ...preciosIniciales(article, article.costPrice, priceMode2),
          editado1: false, editado2: false, editado3: false,
        },
      ]
    })
  }
  function removeLine(i: number): void {
    const next = cart.filter((_, idx) => idx !== i)
    setCart(next)
    // Quitó todo lo que precargó la factura escaneada: la próxima compra que
    // arme acá no es esa factura (no se la marca «Cargada» por error).
    if (!next.some((l) => l.deFactura)) {
      facturaOrigenRef.current = null
      setAvisosFactura([])
    }
  }
  function setLine<K extends keyof CompraLine>(i: number, key: K, value: CompraLine[K]): void {
    setCart((prev) => {
      // El renglón puede ya no existir: la cantidad se vuelve a guardar al
      // perder el foco (onBlur), y si la línea se quitó justo antes el índice
      // llega viejo. En Ventas eso tiraba la pantalla entera (Denver, 27-sep).
      if (!prev[i]) return prev
      const next = [...prev]
      const linea = { ...next[i]!, [key]: value }
      // En modo utilidad, un costo nuevo recalcula las listas que el usuario
      // NO pisó a mano — lo editado a mano se respeta siempre.
      if (key === 'costPrice' && priceMode2 === 'margin') {
        if (!linea.editado1) linea.nl1 = precioPorUtilidad(String(value), linea.article.margin1)
        if (!linea.editado2) linea.nl2 = precioPorUtilidad(String(value), linea.article.margin2)
        if (!linea.editado3) linea.nl3 = precioPorUtilidad(String(value), linea.article.margin3)
      }
      next[i] = linea
      return next
    })
  }

  /** costo × (1 + margen%) redondeado a peso entero; '' si no hay margen. */
  function precioPorUtilidad(costo: string, margen: string | null | undefined): string {
    if (margen == null || String(margen).trim() === '') return ''
    const m = Number(String(margen).replace(',', '.'))
    const c = Number(parseCurrencyInput(costo))
    if (!Number.isFinite(m) || !(c > 0)) return ''
    return String(Math.round(c * (1 + m / 100)))
  }
  /** Precios iniciales de las 3 listas para un artículo, según el modo. */
  function preciosIniciales(a: ArticleDTO, costo: string, modo: 'none' | 'manual' | 'margin') {
    if (modo === 'margin') {
      return {
        nl1: precioPorUtilidad(costo, a.margin1),
        nl2: precioPorUtilidad(costo, a.margin2),
        nl3: precioPorUtilidad(costo, a.margin3),
      }
    }
    return { nl1: a.listPrice1, nl2: a.listPrice2, nl3: a.listPrice3 }
  }

  function clearCompra(): void {
    facturaOrigenRef.current = null
    setAvisosFactura([])
    setCart([])
    setGlobalDiscount('0')
    setPriceMode2('none')
    setIsAccountPurchase(false)
    setInvoiceNumber('')
    setDateIso(todayIso())
    setMixedMode(false)
    split.reset()
    barcodeRef.current?.focus()
  }

  /**
   * Pone en el formulario lo que llega precargado (reemplaza los renglones).
   * `articulos` = la lista de artículos a usar si la de esta ventana puede
   * estar atrasada (la revisión de la factura pudo crear uno recién).
   * Devuelve false si no quedó ningún renglón para cargar.
   */
  function aplicarPrefill(st: Prefill, articulos: ArticleDTO[] = allArticles): boolean {
    const byId = new Map(articulos.filter((a) => a.active).map((a) => [a.id, a]))
    const lines: CompraLine[] = []
    const supplierIds = new Set<string | null>()
    const deFactura = st.from === 'facturaEscaneada' && typeof st.facturaId === 'string' && st.facturaId !== ''
    for (const p of st.prefilledLines ?? []) {
      const art = byId.get(p.articleId)
      if (!art) continue
      lines.push({
        article: art,
        quantity: String(Number(p.quantity)),
        costPrice: p.unitPrice ?? art.costPrice,
        // La alícuota que trae la factura manda sobre la del artículo.
        vatRate: p.vatRate && VAT_OPTIONS.some((o) => o.value === p.vatRate) ? p.vatRate : art.vatRate,
        ...preciosIniciales(art, p.unitPrice ?? art.costPrice, priceMode2),
        editado1: false,
        editado2: false,
        editado3: false,
        ...(p.sugerido === true ? { sugerido: true } : {}),
        ...(deFactura ? { deFactura: true } : {}),
      })
      supplierIds.add(art.supplierId ?? null)
    }
    if (lines.length === 0) return false
    setCart(lines)
    facturaOrigenRef.current = deFactura ? { id: st.facturaId!, vinculos: Array.isArray(st.vinculos) ? st.vinculos : [] } : null
    setAvisosFactura(deFactura && Array.isArray(st.avisos) ? st.avisos.filter((a): a is string => typeof a === 'string' && a !== '') : [])
    const h = st.header
    if (h) {
      // El encabezado manda: el proveedor es el de la factura, no el de los
      // artículos (un artículo puede comprarse a más de un proveedor).
      if (h.supplierId) setSupplierId(h.supplierId)
      if (h.voucherType && VOUCHER_OPTIONS.some((o) => o.value === h.voucherType)) setVoucherType(h.voucherType)
      setInvoiceNumber(h.invoiceNumber ?? '')
      if (h.dateIso && /^\d{4}-\d{2}-\d{2}$/.test(h.dateIso)) setDateIso(h.dateIso)
      const descuento = Number(h.discount ?? 0)
      setGlobalDiscount(Number.isFinite(descuento) && descuento > 0 ? String(h.discount) : '0')
    } else {
      // Si todos los artículos comparten proveedor → preseleccionar.
      const uniqueSuppliers = [...supplierIds].filter((s): s is string => s != null)
      if (supplierIds.size === 1 && uniqueSuppliers.length === 1) {
        setSupplierId(uniqueSuppliers[0]!)
      } else {
        toast.warning('Hay artículos de varios proveedores. Arme una orden por proveedor.')
      }
    }
    return true
  }

  // Prefill desde "Generador de compras" (P-CONSULTAS) y desde "Facturas
  // escaneadas". Este último trae además el encabezado del comprobante
  // (`header`) y un `lote` distinto en cada pasaje, para poder recibir otra
  // factura con la ventana ya abierta (los `extras` llegan sin recargarla:
  // `extrasEnVivo` en el registry).
  const prefillAppliedRef = useRef<string | null>(null)
  useEffect(() => {
    const st = windowSelf?.extras as Prefill | undefined
    if (!st || !Array.isArray(st.prefilledLines) || st.prefilledLines.length === 0) return
    const clave = String(st.lote ?? 'unico')
    if (prefillAppliedRef.current === clave) return
    if (allArticles.length === 0) return // esperar a que carguen los artículos
    prefillAppliedRef.current = clave
    // Llegó otro pasaje con una compra a medio armar: se pregunta antes de pisarla.
    if (cartLength > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPrefillPendiente(st)
      return
    }
    aplicarPrefillAvisando(st)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allArticles, windowSelf?.extras, cartLength])

  function aplicarPrefillAvisando(st: Prefill): void {
    if (aplicarPrefill(st) && st.header && st.from === 'facturaEscaneada') {
      toast.success('Factura escaneada cargada. Revise los datos y confirme la compra.')
    }
  }

  /** «Cargar con el teléfono»: la factura llega con la ventana abierta (sin recargarla). */
  function cargarDelTelefono(prefill: PrefillDeFactura, articulos: ArticleDTO[]): void {
    if (!aplicarPrefill(prefill, articulos)) {
      toast.error('La factura no tiene renglones vinculados con artículos activos.')
      return
    }
    barcodeRef.current?.focus()
  }

  const exactByBarcode = useMemo(() => {
    const v = barcode.trim()
    return v ? (allArticles.find((a) => a.barcode === v) ?? null) : null
  }, [barcode, allArticles])
  const suggestions = useMemo(() => {
    const v = barcode.trim().toLowerCase()
    // Vista previa SIEMPRE que haya texto (aunque exista match exacto): al escribir
    // NÚMEROS deben verse los resultados, igual que el resto de los buscadores.
    // Match por SUBSTRING en código + descripción + marca; orden por relevancia.
    if (v.length < 1) return []
    const matches = allArticles.filter((a) => articleMatches(a, v, searchCtx))
    const rank = (a: ArticleDTO): number => {
      const bc = a.barcode.toLowerCase()
      return bc === v ? 0 : bc.startsWith(v) ? 1 : 2
    }
    // Mostramos TODOS los que matchean (tope de seguridad alto); el desplegable scrollea.
    return [...matches].sort((a, b) => rank(a) - rank(b)).slice(0, 300)
  }, [barcode, allArticles, searchCtx])
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
    mutationFn: () => {
      const monoPayments =
        !isAccountPurchase && !mixedMode && selectedMethod
          ? [{ paymentMethodId: selectedMethod.id, amount: totalNum.toFixed(4) }]
          : null
      const paymentsToSend = isAccountPurchase ? [] : (monoPayments ?? split.payments)
      return api.purchases.create({
        type: voucherType,
        supplierId: supplierId!,
        supplierInvoiceNumber: invoiceNumber.trim() || null,
        date: isoToTs(dateIso),
        isAccountPurchase,
        fundingSource: isAccountPurchase ? undefined : fundingSource,
        payments: paymentsToSend,
        updatePrices,
        priceUpdateMode: priceMode2 === 'none' ? undefined : priceMode2,
        discount: parseCurrencyInput(globalDiscount),
        notes: null,
        lines: cart.map((l) => {
          // Qué viaja por lista (hallazgos de la revisión multi-agente):
          //  - $0 NUNCA es un precio nuevo: el campo de moneda emite '0' al
          //    vaciarlo (no ''), y sin este guard "borrar para no tocar"
          //    dejaba el precio de góndola en cero.
          //  - Modo utilidad: se manda SIEMPRE lo que está en pantalla (y si
          //    el campo quedó sin valor, el vigente). Si se omitiera, el
          //    servidor rellenaría con el cálculo por margen y pisaría en
          //    silencio un precio tipeado igual al vigente.
          //  - Modo manual: viaja sólo lo que difiere del vigente.
          const lista = (valor: string, vigente: string): string | undefined => {
            if (!updatePrices) return undefined
            const n = valor.trim() === '' ? 0 : Number(parseCurrencyInput(valor))
            if (priceMode2 === 'margin') {
              if (n > 0) return parseCurrencyInput(valor)
              return Number(vigente) > 0 ? vigente : undefined
            }
            if (!(n > 0) || n === Number(vigente)) return undefined
            return parseCurrencyInput(valor)
          }
          const n1 = lista(l.nl1, l.article.listPrice1)
          return {
            articleId: l.article.id,
            quantity: parseCurrencyInput(l.quantity),
            costPrice: parseCurrencyInput(l.costPrice),
            salePrice: n1,
            newListPrice1: n1,
            newListPrice2: lista(l.nl2, l.article.listPrice2),
            newListPrice3: lista(l.nl3, l.article.listPrice3),
            vatRate: l.vatRate,
          }
        }),
      })
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['cashGeneral'] })
      void qc.invalidateQueries({ queryKey: ['supplierBalances'] })
      toast.success(`Compra ${result.purchase.type} #${result.purchase.number} registrada — Total ${formatCurrency(result.purchase.total)}`)
      // La compra salió de una factura escaneada: ahora sí queda «Cargada» y
      // se recuerdan los códigos del proveedor (el de ESTA compra, que puede
      // no ser el de la factura), sólo de los renglones precargados que
      // quedaron en la compra. Si no quedó ninguno, no era esa factura.
      const origen = facturaOrigenRef.current
      if (origen) {
        const enCompra = new Set(cart.filter((l) => l.deFactura).map((l) => l.article.id))
        if (enCompra.size > 0) {
          api.facturas
            .marcarCargada(origen.id, origen.vinculos.filter((v) => enCompra.has(v.articleId)), supplierId ?? undefined)
            .then(() => qc.invalidateQueries({ queryKey: ['facturas'] }))
            .catch(() => toast.warning('La compra se registró, pero la factura escaneada no se pudo marcar como Cargada.'))
        }
      }
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
    (isAccountPurchase
      ? true
      : mixedMode
        ? split.isComplete && activeMethods.length > 0
        : selectedMethod != null)

  // F2 = confirmar; F4 cicla medio; F12 toggle mixto.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return
      if (e.key === 'F2') {
        e.preventDefault()
        e.stopPropagation()
        if (canConfirm) createMutation.mutate()
        return
      }
      if (e.key === 'F4' && !mixedMode && !isAccountPurchase && activeMethods.length > 1) {
        e.preventDefault()
        e.stopPropagation()
        const idx = activeMethods.findIndex((m) => m.id === selectedMethodId)
        const next = activeMethods[(idx + 1) % activeMethods.length]
        if (next) setSelectedMethodId(next.id)
        return
      }
      if (e.key === 'F12' && !isAccountPurchase && activeMethods.length > 1) {
        e.preventDefault()
        e.stopPropagation()
        setMixedMode((m) => !m)
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  })

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="grid shrink-0 grid-cols-4 gap-3 rounded-lg border bg-card p-3">
        <div className="col-span-2 flex flex-col gap-1">
          <Label>Proveedor</Label>
          <Button variant="outline" className="justify-between" onClick={() => setSupplierPickerOpen(true)}>
            <span className="truncate">{selectedSupplier ? `${selectedSupplier.code} — ${selectedSupplier.name}` : 'Elegir proveedor…'}</span>
            <Search className="h-4 w-4 shrink-0 opacity-60" />
          </Button>
          {selectedSupplier?.cuit && <span className="text-xs text-muted-foreground">CUIT: {selectedSupplier.cuit}</span>}
        </div>
        <div className="flex flex-col gap-1">
          <Label>Comprobante</Label>
          <Select value={voucherType} onChange={(e) => setVoucherType(e.target.value as VoucherType)}>
            {VOUCHER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label>N° Factura</Label>
            <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="0001-00012345" />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Fecha</Label>
            <Input type="date" value={dateIso} onChange={(e) => setDateIso(e.target.value)} />
          </div>
        </div>
        <div className="col-span-4 flex items-center justify-between text-xs text-muted-foreground">
          <span>Usuario: {currentUser?.fullName} · N° interno {numberQuery.data?.number ?? '—'} · {today}</span>
          <div className="flex items-center gap-2">
            <Badge variant={priceMode === 'gross' ? 'outline' : 'warning'}>
              Modo: Precios {priceMode === 'gross' ? 'con IVA incluido' : 'netos + IVA'}
            </Badge>
            {facturasActivas && (
              <Button
                size="sm"
                disabled={!canWrite}
                title="Fotografíe la factura con el teléfono: al leerla, completa este formulario. La compra la confirma usted."
                onClick={() => setCargaTelefono(true)}
              >
                <Smartphone className="mr-1 h-4 w-4" />
                Cargar con el teléfono
              </Button>
            )}
            {facturasActivas && (
              <Button variant="outline" size="sm" onClick={() => openInWindow('facturasEscaneadas')}>
                <ScanLine className="mr-1 h-4 w-4" />
                Facturas escaneadas
                {facturasListas > 0 && (
                  <Badge variant="success" className="ml-1.5" title="Facturas listas para revisar">
                    {facturasListas}
                  </Badge>
                )}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => openInWindow('historial-compras')}>
              Ver historial
            </Button>
          </div>
        </div>
      </div>

      {facturasActivas && (
        <CargaTelefonoCompras
          abierto={cargaTelefono}
          onCerrar={() => setCargaTelefono(false)}
          hayRenglones={() => cartLengthRef.current > 0}
          onCargar={cargarDelTelefono}
          pantalla={pantallaRef.current}
          puedeConfigurar={hasPermissionFor(currentUser?.permissions, 'manage_hardware')}
        />
      )}

      <AlertDialog open={prefillPendiente != null} onOpenChange={(o) => { if (!o) setPrefillPendiente(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Reemplazar la compra en curso?</AlertDialogTitle>
            <AlertDialogDescription>
              {prefillPendiente?.from === 'facturaEscaneada'
                ? 'Llegó una factura escaneada y el formulario ya tiene renglones. Si continúa, se reemplazan por los de la factura.'
                : 'Llegó una compra para precargar y el formulario ya tiene renglones. Si continúa, se reemplazan.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                const era = prefillPendiente
                setPrefillPendiente(null)
                toast.info(era?.from === 'facturaEscaneada' ? 'La factura quedó en «Facturas escaneadas».' : 'Se conserva la compra en curso.')
              }}
            >
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const st = prefillPendiente
                setPrefillPendiente(null)
                if (st) aplicarPrefillAvisando(st)
              }}
            >
              Reemplazar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {avisosFactura.length > 0 && cart.length > 0 && (
        <div className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
          {avisosFactura.map((a) => (
            <div key={a}>{a} Controle que no se registre dos veces.</div>
          ))}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="relative">
          <ShoppingCart className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={barcodeRef}
            className="h-11 pl-10 text-base"
            placeholder="Código o nombre del producto — escanear o escribir y Enter"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitBarcode()
              if (e.key === 'Escape' && barcode.trim() !== '') setBarcode('')
            }}
          />
          {suggestions.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
              {suggestions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => { addArticle(a); setBarcode(''); barcodeRef.current?.focus() }}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-muted-foreground">{a.barcode}</span> · {a.description}
                  </span>
                  {a.brand && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">{a.brand}</span>}
                  <span className="shrink-0 tabular-nums text-muted-foreground">costo {formatCurrency(a.costPrice)}</span>
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
                <th className="w-32 px-2 py-1.5">Marca</th>
                <th className="w-24 px-2 py-1.5 text-right">Cantidad</th>
                <th className="w-28 px-2 py-1.5 text-right">{priceMode === 'gross' ? 'Costo (c/IVA)' : 'Costo (neto)'}</th>
                <th className="w-20 px-2 py-1.5 text-right">IVA</th>
                {updatePrices && (
                  <>
                    <th className="w-28 px-2 py-1.5 text-right">P. Lista 1</th>
                    <th className="w-28 px-2 py-1.5 text-right">P. Lista 2</th>
                    <th className="w-28 px-2 py-1.5 text-right">P. Lista 3</th>
                  </>
                )}
                <th className="w-28 px-2 py-1.5 text-right">Subtotal</th>
                <th className="w-8 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {cart.length === 0 ? (
                <tr>
                  <td colSpan={updatePrices ? 10 : 7} className="py-10 text-center text-sm text-muted-foreground">
                    Sin líneas — escanee o busque un producto para empezar.
                  </td>
                </tr>
              ) : (
                cart.map((l, i) => (
                  <tr key={l.article.id} className="border-t">
                    <td className="px-2 py-1">
                      <div className="font-medium">{l.article.description}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {l.article.barcode}
                        {l.sugerido && (
                          <Badge
                            variant="warning"
                            className="ml-1.5 font-sans"
                            title="El sistema eligió este artículo por parecido con la descripción de la factura: contrólelo."
                          >
                            Sugerido
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1 text-sm text-muted-foreground">{l.article.brand ?? ''}</td>
                    <td className="px-2 py-1">
                      <Input className="h-8 text-right tabular-nums" inputMode="decimal" value={l.quantity}
                        onChange={(e) => setLine(i, 'quantity', e.target.value)} onBlur={() => setLine(i, 'quantity', parseCurrencyInput(l.quantity))} />
                    </td>
                    <td className="px-2 py-1">
                      <CurrencyInput className="h-8 text-right tabular-nums" value={l.costPrice}
                        onChange={(v) => setLine(i, 'costPrice', v)} />
                    </td>
                    <td className="px-2 py-1">
                      <Select className="h-8" value={l.vatRate} onChange={(e) => setLine(i, 'vatRate', e.target.value)}>
                        {VAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    </td>
                    {updatePrices && ([1, 2, 3] as const).map((n) => {
                      const campo = `nl${n}` as 'nl1'
                      const editado = `editado${n}` as 'editado1'
                      const vigente = l.article[`listPrice${n}` as 'listPrice1']
                      const cambia = l[campo].trim() !== '' && Number(parseCurrencyInput(l[campo])) !== Number(vigente)
                      return (
                        <td key={n} className="px-2 py-1">
                          {/* Editable SIEMPRE, en los dos modos: si el redondeo
                              automático no le sirve al comercio, lo pisa acá.
                              Vacío = esa lista no se toca. */}
                          <CurrencyInput
                            className={cambia ? 'h-8 border-primary/60 text-right font-medium tabular-nums' : 'h-8 text-right tabular-nums'}
                            value={l[campo]}
                            onChange={(v) => {
                              setCart((prev) => {
                                if (!prev[i]) return prev
                                const next = [...prev]
                                next[i] = { ...next[i]!, [campo]: v, [editado]: true }
                                return next
                              })
                            }}
                          />
                          <div className="mt-0.5 text-right text-[10px] tabular-nums text-muted-foreground">
                            {Number(vigente) > 0 ? `hoy ${formatCurrency(vigente)}` : 'sin precio'}
                          </div>
                        </td>
                      )
                    })}
                    <td className="px-2 py-1 text-right tabular-nums font-medium">
                      {formatCurrency(lineTotal({ quantity: l.quantity, unitPrice: l.costPrice }))}
                      {priceMode === 'net' && (
                        <div className="text-[10px] font-normal text-muted-foreground">
                          c/IVA {formatCurrency(vatBreakdown(lineTotal({ quantity: l.quantity, unitPrice: l.costPrice }), l.vatRate, 'net').gross.toFixed(4))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(i)} title="Quitar producto de la compra">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">Actualizar precios al guardar:</span>
          <Select
            className="h-8 w-72"
            value={priceMode2}
            onChange={(e) => {
              const modo = e.target.value as 'none' | 'manual' | 'margin'
              setPriceMode2(modo)
              // Cambiar el modo re-precarga los precios de TODAS las líneas
              // con la base del modo nuevo (vigentes o costo × utilidad) y
              // olvida las ediciones a mano: eran del modo anterior.
              setCart((prev) =>
                prev.map((l) => ({
                  ...l,
                  ...preciosIniciales(l.article, l.costPrice, modo),
                  editado1: false,
                  editado2: false,
                  editado3: false,
                })),
              )
            }}
          >
            <option value="none">No actualizar precios</option>
            <option value="manual">Actualización manual por renglón</option>
            <option value="margin">Actualización automática por % de utilidad</option>
          </Select>
          {priceMode2 === 'margin' && (
            <span className="text-xs text-muted-foreground">
              Recalcula todas las listas de precios con utilidad definida: costo nuevo × % de utilidad, redondeado sin centavos.
            </span>
          )}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-3 rounded-lg border bg-card p-3">
        <div className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{priceMode === 'gross' ? 'Subtotal (con IVA)' : 'Subtotal neto'}</span>
            <span className="tabular-nums">{formatCurrency(totals.subtotal)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Descuento</span>
            <CurrencyInput className="h-7 w-28 text-right tabular-nums" value={globalDiscount}
              onChange={setGlobalDiscount} />
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
            <>
              <div className="flex flex-col gap-1">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">El dinero sale de</Label>
                <Select value={fundingSource} onChange={(e) => setFundingSource(e.target.value as 'daily' | 'general')}>
                  <option value="daily">Caja diaria</option>
                  <option value="general">Caja General{cashGeneralBalance.data ? ` (saldo ${formatCurrency(cashGeneralBalance.data.balance)})` : ''}</option>
                </Select>
              </div>
              <p className="text-xs text-destructive">No hay caja diaria abierta. Abra la caja (F7), pague desde Caja General o registre la compra a cuenta del proveedor.</p>
            </>
          ) : noMethods ? (
            <p className="text-xs text-destructive">No hay medios de pago configurados.</p>
          ) : mixedMode ? (
            <>
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Pago mixto</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => { setMixedMode(false); split.reset() }}
                >
                  Volver a pago único
                </Button>
              </div>
              <PaymentSplitInput methods={activeMethods} split={split} />
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">El dinero sale de</Label>
                <Select value={fundingSource} onChange={(e) => setFundingSource(e.target.value as 'daily' | 'general')}>
                  <option value="daily">Caja diaria</option>
                  <option value="general">Caja General{cashGeneralBalance.data ? ` (saldo ${formatCurrency(cashGeneralBalance.data.balance)})` : ''}</option>
                </Select>
              </div>
              {fundingSource === 'general' && (
                <p className="text-xs text-muted-foreground">El egreso baja el saldo de Caja General, no la caja diaria.</p>
              )}
              <div className="flex flex-col gap-1">
                <Label htmlFor="compra-method">Forma de pago</Label>
                <PaymentMethodSelect
                  id="compra-method"
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

        <div className="flex flex-col justify-end gap-2">
          <Button variant="success" className="h-14 text-lg" disabled={!canConfirm} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Wallet className="h-5 w-5" />}
            {isAccountPurchase
              ? `Confirmar compra a cuenta (F2) — ${formatCurrency(totals.total)}`
              : `Pagar (F2) — ${formatCurrency(totals.total)}`}
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
