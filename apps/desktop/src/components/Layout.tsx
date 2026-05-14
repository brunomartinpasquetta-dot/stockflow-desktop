import { useEffect, type ComponentType } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  Building2,
  Calculator,
  CreditCard,
  FileSpreadsheet,
  History,
  Info,
  Landmark,
  LogOut,
  Package,
  PackagePlus,
  Receipt,
  Settings,
  ShieldCheck,
  Tag,
  Tags,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
} from 'lucide-react'

import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { useLicenseStatus } from '@/contexts/LicenseContext'
import { CommandPalette } from '@/components/CommandPalette'
import { GlobalSearchBar } from '@/components/GlobalSearchBar'
import { LanStatusIndicator } from '@/components/LanStatusIndicator'
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext'
import { useGlobalShortcuts } from '@/lib/useGlobalShortcuts'
import { ROLE_LABELS, hasPermission, type PermissionAction } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

type IconType = ComponentType<{ className?: string }>

interface NavItem {
  fkey?: string
  label: string
  icon: IconType
  path?: string
  adminOnly?: boolean
  requires?: PermissionAction
  exit?: boolean
}

const NAV: NavItem[] = [
  { fkey: 'F1', label: 'Artículos', icon: Package, path: '/articulos' },
  { fkey: 'F2', label: 'Proveedores', icon: Truck, path: '/proveedores' },
  { fkey: 'F3', label: 'Clientes', icon: Users, path: '/clientes' },
  { label: 'Cuentas corrientes', icon: Landmark, path: '/cuentas-corrientes' },
  { label: 'Cuentas Prov.', icon: Truck, path: '/cuentas-corrientes-proveedores' },
  { label: 'Medios de pago', icon: CreditCard, path: '/medios-de-pago', requires: 'manage_payment_methods' },
  { fkey: 'F4', label: 'Usuarios', icon: ShieldCheck, path: '/usuarios', adminOnly: true },
  { label: 'Mi Empresa', icon: Building2, path: '/empresa', adminOnly: true },
  { label: 'Configuración', icon: Settings, path: '/configuracion', adminOnly: true },
  { label: 'MercadoPago QR', icon: CreditCard, path: '/configuracion/mercadopago', adminOnly: true },
  { label: 'Importar stock', icon: FileSpreadsheet, path: '/importar-stock', adminOnly: true },
  { fkey: 'F5', label: 'Compras', icon: ShoppingCart, path: '/compras' },
  { fkey: 'F6', label: 'Ventas', icon: Receipt, path: '/ventas' },
  { fkey: 'F7', label: 'Caja', icon: Wallet, path: '/caja' },
  { label: 'Historial de Cajas', icon: History, path: '/consultas/caja', requires: 'view_reports' },
  { label: 'Generador de compras', icon: PackagePlus, path: '/consultas/generador-compras', requires: 'view_reports' },
  { label: 'Inventario de artículos', icon: Boxes, path: '/consultas/inventario', requires: 'view_reports' },
  { label: 'Ventas por vendedor', icon: BarChart3, path: '/consultas/ventas-vendedor', requires: 'view_reports' },
  { label: 'Actualizar precios', icon: Tag, path: '/precios/actualizar', requires: 'manage_prices' },
  { label: 'Historial de precios', icon: Tags, path: '/precios/historial', requires: 'manage_prices' },
  { fkey: 'F8', label: 'Historial de Ventas', icon: BarChart3, path: '/ventas/historial' },
  { fkey: 'F9', label: 'Movimientos', icon: ArrowLeftRight },
  { fkey: 'F10', label: 'Contabilidad', icon: Calculator },
  { label: 'Acerca de', icon: Info, path: '/acerca-de' },
  { fkey: 'F12', label: 'Salir', icon: LogOut, exit: true },
]

function isEditingTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}

export function Layout() {
  return (
    <CommandPaletteProvider>
      <LayoutInner />
    </CommandPaletteProvider>
  )
}

function LayoutInner() {
  useGlobalShortcuts()
  const navigate = useNavigate()
  const location = useLocation()
  const { currentUser, logout } = useAuth()
  const licenseStatus = useLicenseStatus()
  const companyQuery = useQuery({ queryKey: ['company'], queryFn: api.company.get })
  const companyName = companyQuery.data?.name ?? 'StockFlow'

  const items = NAV.filter((it) => {
    if (it.adminOnly) return currentUser?.role === 'admin'
    if (it.requires) return hasPermission(currentUser?.role, it.requires)
    return true
  })

  function activate(item: NavItem): void {
    if (item.exit) {
      window.close()
      return
    }
    if (item.path) {
      navigate(item.path)
      return
    }
    toast.info(`${item.label} — disponible próximamente`)
  }

  // Atajos de teclado globales (no se disparan si el foco está en un input/textarea/select).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        void logout()
        return
      }
      if (/^F([1-9]|1[0-2])$/.test(e.key)) {
        if (isEditingTarget()) return
        const item = NAV.find((it) => it.fkey === e.key)
        if (!item) return
        if (item.adminOnly && currentUser?.role !== 'admin') return
        e.preventDefault()
        activate(item)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, logout, navigate])

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Boxes className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">StockFlow</div>
            <div className="text-xs text-muted-foreground">Gestión comercial</div>
          </div>
        </div>
        <Separator />
        <nav className="flex-1 overflow-y-auto p-2">
          {items.map((item) => {
            const Icon = item.icon
            const active = item.path != null && location.pathname.startsWith(item.path)
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => activate(item)}
                className={cn(
                  'mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                  active
                    ? 'bg-primary/10 font-medium text-primary'
                    : item.exit
                      ? 'text-destructive hover:bg-destructive/10'
                      : 'hover:bg-accent',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{item.label}</span>
                {item.fkey && (
                  <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">{item.fkey}</span>
                )}
              </button>
            )
          })}
        </nav>
        <Separator />
        <div className="px-4 py-2 text-[10px] text-muted-foreground">Ctrl+L para cerrar sesión</div>
      </aside>

      {/* Columna principal */}
      <div className="flex min-w-0 flex-1 flex-col">
        {licenseStatus === 'readOnly' && (
          <div className="shrink-0 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-destructive-foreground">
            ⚠ Suscripción suspendida — regularizá el pago para volver a operar. Sólo lectura.
          </div>
        )}
        <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4">
          <div className="truncate text-sm font-medium">{companyName}</div>
          <div className="flex-1" />
          <GlobalSearchBar />
          <div className="flex items-center gap-3 text-sm">
            <LanStatusIndicator />
            <span className="text-muted-foreground">
              {currentUser?.fullName} ·{' '}
              <span className="font-medium">{currentUser ? ROLE_LABELS[currentUser.role] : ''}</span>
            </span>
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOut className="h-3.5 w-3.5" />
              Cerrar sesión
            </Button>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto bg-secondary/30 p-4">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}
