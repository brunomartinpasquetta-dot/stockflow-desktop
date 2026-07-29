/**
 * Buscador global INLINE (no invasivo).
 *
 * Input compacto en la barra superior con un desplegable justo debajo: busca
 * artículos, clientes, proveedores, ventas, compras y acciones rápidas.
 * El asistente Flowy vive en su propio botón, al lado (ver StatusBar).
 * Se abre al enfocar, se cierra al elegir, con Escape o al hacer clic afuera.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import { toast } from 'sonner'
import {
  ArrowLeftRight,
  Building2,
  ClipboardList,
  History,
  LogOut,
  Package,
  Plus,
  Receipt,
  Search,
  ShoppingCart,
  Tag,
  Truck,
  Users,
  Wallet,
} from 'lucide-react'

import { api } from '@/lib/api'
import { useGlobalSearch } from '@/lib/hooks'
import { addRecent, getRecents, type RecentSearch } from '@/lib/recentSearches'
import { useAuth } from '@/contexts/AuthContext'
import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/format'

const HOTKEY_LABEL = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'

function customerName(c: { lastName: string; firstName: string | null }): string {
  return c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName
}
function money(v: string): string {
  const n = Number(v)
  return Number.isFinite(n) ? `$${n.toLocaleString('es-AR', { maximumFractionDigits: 0 })}` : ''
}

const itemCls = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent'
const groupCls = 'px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground'

export function GlobalSearchBar() {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentSearch[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  const search = useGlobalSearch(input, 150)
  const data = search.data
  const hasQuery = input.trim().length > 0

  useEffect(() => {
    if (open) setRecents(getRecents())
  }, [open])

  // Cerrar al hacer clic afuera.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const actions = useMemo(
    () => [
      { slug: 'new-article', label: 'Nuevo artículo', hint: 'Crear artículo', perform: () => navigate('/articulos?action=new') },
      { slug: 'new-sale', label: 'Nueva venta', perform: () => navigate('/ventas') },
      { slug: 'open-cash', label: 'Abrir caja', perform: () => navigate('/caja?action=open') },
      { slug: 'close-cash', label: 'Cerrar caja', perform: () => navigate('/caja?action=close') },
      { slug: 'update-prices', label: 'Actualizar precios', perform: () => navigate('/precios/actualizar') },
      { slug: 'cash-history', label: 'Caja General', perform: () => navigate('/caja-general') },
      { slug: 'sales-history', label: 'Historial de ventas', perform: () => navigate('/ventas/historial') },
      { slug: 'purchases-history', label: 'Historial de compras', perform: () => navigate('/compras/historial') },
      { slug: 'company', label: 'Mi empresa', perform: () => navigate('/empresa') },
      {
        slug: 'logout',
        label: 'Salir',
        perform: async () => {
          try {
            await api.auth.logout()
          } catch {
            /* ignore */
          }
          await logout()
          navigate('/login')
        },
      },
    ],
    [navigate, logout],
  )

  function closeDropdown(): void {
    setOpen(false)
    setInput('')
  }
  function pick(label: string, kind: RecentSearch['kind'] | null, id: string | null, perform: () => void | Promise<void>, suppressToast = false): void {
    if (kind && id) addRecent({ kind, id, label })
    closeDropdown()
    setTimeout(() => {
      void perform()
      if (!suppressToast) toast.success(`Mostrando: ${label}`)
    }, 0)
  }
  function handleRecent(r: RecentSearch): void {
    switch (r.kind) {
      case 'article': pick(r.label, 'article', r.id, () => navigate(`/articulos?articleId=${r.id}`)); break
      case 'customer': pick(r.label, 'customer', r.id, () => navigate(`/clientes?customerId=${r.id}`)); break
      case 'supplier': pick(r.label, 'supplier', r.id, () => navigate(`/proveedores?supplierId=${r.id}`)); break
      case 'sale': pick(r.label, 'sale', r.id, () => navigate(`/ventas/historial?saleId=${r.id}`)); break
      case 'purchase': pick(r.label, 'purchase', r.id, () => navigate(`/compras/historial?purchaseId=${r.id}`)); break
      case 'action': {
        const act = actions.find((a) => a.slug === r.id)
        if (act) pick(act.label, 'action', act.slug, act.perform, true)
        break
      }
    }
  }
  return (
    <div ref={containerRef} className="relative w-64 shrink-0">
      <Command shouldFilter={false} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
        {/* Barra */}
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
          <Command.Input
            id="global-search-input"
            value={input}
            onValueChange={setInput}
            onFocus={() => setOpen(true)}
            placeholder="Buscar…"
            className="h-8 w-full rounded-md border bg-background pl-7 pr-11 text-xs outline-none transition-colors placeholder:text-muted-foreground hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span className="pointer-events-none absolute right-2 hidden rounded border px-1 text-[10px] text-muted-foreground lg:inline">{HOTKEY_LABEL}</span>
        </div>

        {/* Desplegable (solo si hay algo para mostrar) */}
        {open && (hasQuery || recents.length > 0) && (
          <Command.List className="absolute left-0 top-full z-50 mt-1 max-h-[65vh] w-[540px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
            {!hasQuery && recents.length > 0 && (
              <Command.Group heading="Recientes" className={groupCls}>
                {recents.map((r) => (
                  <Command.Item key={`recent-${r.kind}-${r.id}`} value={`recent-${r.kind}-${r.id}-${r.label}`} onSelect={() => handleRecent(r)} className={itemCls}>
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{r.label}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{r.kind}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {data && (
              <>
                {data.articles.length > 0 && (
                  <Command.Group heading="📦 Artículos" className={groupCls}>
                    {data.articles.map((a) => (
                      <Command.Item key={`a-${a.id}`} value={`article-${a.id}-${a.barcode}-${a.description}`} onSelect={() => pick(a.description, 'article', a.id, () => navigate(`/articulos?articleId=${a.id}`))} className={itemCls}>
                        <Package className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{a.description}</span>
                        {a.brand && <Badge variant="primary" className="shrink-0 text-[10px] font-semibold">{a.brand}</Badge>}
                        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{money(a.listPrice1)}</span>
                        <Badge variant="outline" className="shrink-0 text-[10px]">Stock {a.stock}</Badge>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.customers.length > 0 && (
                  <Command.Group heading="👥 Clientes" className={groupCls}>
                    {data.customers.map((c) => (
                      <Command.Item key={`c-${c.id}`} value={`customer-${c.id}-${c.lastName}-${c.firstName ?? ''}`} onSelect={() => pick(customerName(c), 'customer', c.id, () => navigate(`/clientes?customerId=${c.id}`))} className={itemCls}>
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">{customerName(c)}</span>
                        {c.docNumber && <span className="text-xs text-muted-foreground">{c.docType ?? ''} {c.docNumber}</span>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.suppliers.length > 0 && (
                  <Command.Group heading="🏭 Proveedores" className={groupCls}>
                    {data.suppliers.map((s) => (
                      <Command.Item key={`s-${s.id}`} value={`supplier-${s.id}-${s.name}`} onSelect={() => pick(s.name, 'supplier', s.id, () => navigate(`/proveedores?supplierId=${s.id}`))} className={itemCls}>
                        <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">{s.name}</span>
                        {s.cuit && <span className="text-xs text-muted-foreground">{s.cuit}</span>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.sales.length > 0 && (
                  <Command.Group heading="🧾 Ventas" className={groupCls}>
                    {data.sales.map((sale) => (
                      <Command.Item key={`v-${sale.id}`} value={`sale-${sale.id}-${sale.number}`} onSelect={() => pick(`Venta ${sale.type} #${sale.number}`, 'sale', sale.id, () => navigate(`/ventas/historial?saleId=${sale.id}`))} className={itemCls}>
                        <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">Venta {sale.type} #{sale.number}</span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(sale.date)}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.purchases.length > 0 && (
                  <Command.Group heading="📥 Compras" className={groupCls}>
                    {data.purchases.map((p) => (
                      <Command.Item key={`p-${p.id}`} value={`purchase-${p.id}-${p.number}`} onSelect={() => pick(`Compra ${p.type} #${p.number}`, 'purchase', p.id, () => navigate(`/compras/historial?purchaseId=${p.id}`))} className={itemCls}>
                        <ShoppingCart className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">Compra {p.type} #{p.number}{p.supplierInvoiceNumber ? ` · ${p.supplierInvoiceNumber}` : ''}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
              </>
            )}

            {hasQuery && (
              <Command.Group heading="⚙️ Acciones" className={groupCls}>
                {actions
                  .filter((a) => a.label.toLowerCase().includes(input.trim().toLowerCase()))
                  .map((a) => (
                    <Command.Item key={`act-${a.slug}`} value={`action-${a.slug}-${a.label}`} onSelect={() => pick(a.label, 'action', a.slug, a.perform, true)} className={itemCls}>
                      <ActionIcon slug={a.slug} />
                      <span className="flex-1 truncate">{a.label}</span>
                      {a.hint && <span className="text-xs text-muted-foreground">{a.hint}</span>}
                    </Command.Item>
                  ))}
              </Command.Group>
            )}
          </Command.List>
        )}
      </Command>
    </div>
  )
}

function ActionIcon({ slug }: { slug: string }) {
  const cls = 'h-3.5 w-3.5 text-muted-foreground'
  switch (slug) {
    case 'new-article': return <Plus className={cls} />
    case 'new-sale': return <Receipt className={cls} />
    case 'open-cash':
    case 'close-cash': return <Wallet className={cls} />
    case 'update-prices': return <Tag className={cls} />
    case 'cash-history':
    case 'sales-history':
    case 'purchases-history': return <ClipboardList className={cls} />
    case 'company': return <Building2 className={cls} />
    case 'logout': return <LogOut className={cls} />
    default: return <ArrowLeftRight className={cls} />
  }
}
