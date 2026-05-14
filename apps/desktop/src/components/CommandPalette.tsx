/**
 * CommandPalette — búsqueda global tipo Cmd+K (P-BUSQUEDA).
 *
 * - Usa `cmdk` envuelto en un Dialog de Radix.
 * - Modo 'all': lista resultados de artículos, clientes, proveedores, ventas y
 *   compras (provistos por `useGlobalSearch`) + acciones rápidas que matcheen.
 * - Modo 'actions' (Cmd+Shift+P): sólo acciones.
 * - Al abrirse con query vacía muestra el historial reciente + acciones.
 * - Al seleccionar: guarda en localStorage, cierra, navega con deep link y
 *   muestra toast 'Mostrando: <label>' (excepto para acciones).
 */
import { useEffect, useMemo, useState } from 'react'
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
  ShoppingCart,
  Tag,
  Trash2,
  Truck,
  Users,
  Wallet,
} from 'lucide-react'

import { api } from '@/lib/api'
import { useGlobalSearch } from '@/lib/hooks'
import { addRecent, clearRecents, getRecents, type RecentSearch } from '@/lib/recentSearches'
import { useCommandPalette, type PaletteMode } from '@/contexts/CommandPaletteContext'
import { useAuth } from '@/contexts/AuthContext'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/format'

interface ActionItem {
  slug: string
  label: string
  hint?: string
  perform: () => void | Promise<void>
}

function customerName(c: { lastName: string; firstName: string | null }): string {
  return c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName
}

export function CommandPalette() {
  const { open, mode, close } = useCommandPalette()
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [input, setInput] = useState('')
  const [recents, setRecents] = useState<RecentSearch[]>([])

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInput('')
      setRecents(getRecents())
    }
  }, [open])

  const search = useGlobalSearch(input, 150)
  const data = search.data
  const showData = mode === 'all'

  // -- Acciones disponibles (filtradas en cliente por `input`) ---
  const actions = useMemo<ActionItem[]>(() => {
    const list: ActionItem[] = [
      { slug: 'new-article', label: 'Nuevo artículo', hint: 'Crear artículo', perform: () => navigate('/articulos?action=new') },
      { slug: 'new-sale', label: 'Nueva venta', perform: () => navigate('/ventas') },
      { slug: 'open-cash', label: 'Abrir caja', perform: () => navigate('/caja?action=open') },
      { slug: 'close-cash', label: 'Cerrar caja', perform: () => navigate('/caja?action=close') },
      { slug: 'update-prices', label: 'Actualizar precios', perform: () => navigate('/precios/actualizar') },
      { slug: 'cash-history', label: 'Historial de cajas', perform: () => navigate('/consultas/caja') },
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
    ]
    return list
  }, [navigate, logout])

  function selectAndClose(label: string, kind: RecentSearch['kind'] | null, id: string | null, perform: () => void | Promise<void>, suppressToast = false): void {
    if (kind && id) addRecent({ kind, id, label })
    close()
    setTimeout(() => {
      void perform()
      if (!suppressToast) toast.success(`Mostrando: ${label}`)
    }, 0)
  }

  function handleRecent(r: RecentSearch): void {
    switch (r.kind) {
      case 'article':
        selectAndClose(r.label, 'article', r.id, () => navigate(`/articulos?articleId=${r.id}`))
        break
      case 'customer':
        selectAndClose(r.label, 'customer', r.id, () => navigate(`/clientes?customerId=${r.id}`))
        break
      case 'supplier':
        selectAndClose(r.label, 'supplier', r.id, () => navigate(`/proveedores?supplierId=${r.id}`))
        break
      case 'sale':
        selectAndClose(r.label, 'sale', r.id, () => navigate(`/ventas/historial?saleId=${r.id}`))
        break
      case 'purchase':
        selectAndClose(r.label, 'purchase', r.id, () => navigate(`/compras/historial?purchaseId=${r.id}`))
        break
      case 'action': {
        const act = actions.find((a) => a.slug === r.id)
        if (act) selectAndClose(act.label, 'action', act.slug, act.perform, true)
        break
      }
    }
  }

  const hasQuery = input.trim().length > 0
  const headerTitle = mode === 'actions' ? 'Acciones' : 'Buscar artículos, clientes, ventas, acciones…'

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogTitle className="sr-only">Búsqueda global</DialogTitle>
        <Command shouldFilter={false} className="flex max-h-[70vh] flex-col">
          <div className="border-b px-3 py-2">
            <Command.Input
              value={input}
              onValueChange={setInput}
              placeholder={headerTitle}
              autoFocus
              className="w-full bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="flex-1 overflow-y-auto p-1">
            {!hasQuery && recents.length > 0 && mode === 'all' && (
              <Command.Group heading="Recientes" className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {recents.map((r) => (
                  <Command.Item
                    key={`recent-${r.kind}-${r.id}`}
                    value={`recent-${r.kind}-${r.id}-${r.label}`}
                    onSelect={() => handleRecent(r)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent"
                  >
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{r.label}</span>
                    <span className="text-[10px] uppercase text-muted-foreground">{r.kind}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {showData && data && (
              <>
                {data.articles.length > 0 && (
                  <Command.Group heading="📦 Artículos" className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {data.articles.map((a) => (
                      <Command.Item
                        key={`a-${a.id}`}
                        value={`article-${a.id}-${a.barcode}-${a.description}`}
                        onSelect={() => selectAndClose(
                          a.description,
                          'article',
                          a.id,
                          () => navigate(`/articulos?articleId=${a.id}`),
                        )}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent"
                      >
                        <Package className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-xs text-muted-foreground">{a.barcode}</span>
                        <span className="flex-1 truncate">{a.description}</span>
                        <Badge variant="outline" className="text-[10px]">Stock {a.stock}</Badge>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.customers.length > 0 && (
                  <Command.Group heading="👥 Clientes" className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {data.customers.map((c) => (
                      <Command.Item
                        key={`c-${c.id}`}
                        value={`customer-${c.id}-${c.lastName}-${c.firstName ?? ''}`}
                        onSelect={() => selectAndClose(
                          customerName(c),
                          'customer',
                          c.id,
                          () => navigate(`/clientes?customerId=${c.id}`),
                        )}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent"
                      >
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">{customerName(c)}</span>
                        {c.docNumber && <span className="text-xs text-muted-foreground">{c.docType ?? ''} {c.docNumber}</span>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.suppliers.length > 0 && (
                  <Command.Group heading="🏭 Proveedores" className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {data.suppliers.map((s) => (
                      <Command.Item
                        key={`s-${s.id}`}
                        value={`supplier-${s.id}-${s.name}-${s.cuit ?? ''}`}
                        onSelect={() => selectAndClose(
                          s.name,
                          'supplier',
                          s.id,
                          () => navigate(`/proveedores?supplierId=${s.id}`),
                        )}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent"
                      >
                        <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">{s.name}</span>
                        {s.cuit && <span className="text-xs text-muted-foreground">{s.cuit}</span>}
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.sales.length > 0 && (
                  <Command.Group heading="🧾 Ventas" className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {data.sales.map((sale) => (
                      <Command.Item
                        key={`v-${sale.id}`}
                        value={`sale-${sale.id}-${sale.number}-${sale.type}`}
                        onSelect={() => selectAndClose(
                          `Venta ${sale.type} #${sale.number}`,
                          'sale',
                          sale.id,
                          () => navigate(`/ventas/historial?saleId=${sale.id}`),
                        )}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent"
                      >
                        <Receipt className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">Venta {sale.type} #{sale.number}</span>
                        <span className="text-xs text-muted-foreground">{formatDateTime(sale.date)}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
                {data.purchases.length > 0 && (
                  <Command.Group heading="📥 Compras" className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {data.purchases.map((p) => (
                      <Command.Item
                        key={`p-${p.id}`}
                        value={`purchase-${p.id}-${p.number}-${p.supplierInvoiceNumber ?? ''}`}
                        onSelect={() => selectAndClose(
                          `Compra ${p.type} #${p.number}`,
                          'purchase',
                          p.id,
                          () => navigate(`/compras/historial?purchaseId=${p.id}`),
                        )}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent"
                      >
                        <ShoppingCart className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">Compra {p.type} #{p.number}{p.supplierInvoiceNumber ? ` · ${p.supplierInvoiceNumber}` : ''}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}
              </>
            )}

            <Command.Group heading="⚙️ Acciones" className="px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {actions
                .filter((a) => (hasQuery ? a.label.toLowerCase().includes(input.trim().toLowerCase()) : true))
                .map((a) => (
                  <Command.Item
                    key={`act-${a.slug}`}
                    value={`action-${a.slug}-${a.label}`}
                    onSelect={() => selectAndClose(a.label, 'action', a.slug, a.perform, true)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground aria-selected:bg-accent"
                  >
                    <ActionIcon slug={a.slug} />
                    <span className="flex-1 truncate">{a.label}</span>
                    {a.hint && <span className="text-xs text-muted-foreground">{a.hint}</span>}
                  </Command.Item>
                ))}
            </Command.Group>

            {hasQuery && showData && data && data.articles.length === 0 && data.customers.length === 0 && data.suppliers.length === 0 && data.sales.length === 0 && data.purchases.length === 0 && (
              <Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
                Sin resultados para "{input}"
              </Command.Empty>
            )}
          </Command.List>
          <div className="flex items-center justify-between border-t px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>↑↓ navegar · ↵ seleccionar · esc cerrar</span>
            {!hasQuery && recents.length > 0 && mode === 'all' && (
              <button
                type="button"
                onClick={() => { clearRecents(); setRecents([]) }}
                className="inline-flex items-center gap-1 rounded hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" />
                Limpiar historial
              </button>
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function ActionIcon({ slug }: { slug: string }) {
  const cls = 'h-3.5 w-3.5 text-muted-foreground'
  switch (slug) {
    case 'new-article':
      return <Plus className={cls} />
    case 'new-sale':
      return <Receipt className={cls} />
    case 'open-cash':
    case 'close-cash':
      return <Wallet className={cls} />
    case 'update-prices':
      return <Tag className={cls} />
    case 'cash-history':
    case 'sales-history':
    case 'purchases-history':
      return <ClipboardList className={cls} />
    case 'company':
      return <Building2 className={cls} />
    case 'logout':
      return <LogOut className={cls} />
    default:
      return <ArrowLeftRight className={cls} />
  }
}

export type { PaletteMode }
