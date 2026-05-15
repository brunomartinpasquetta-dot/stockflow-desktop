/**
 * MenuBar horizontal con 8 grupos (P-MDI-TOOLBAR).
 *
 * Refinamiento visual del MenuBar de P-MDI-LAYOUT. Grupos:
 *   Archivo · Gestión · Operaciones · Cobros y Pagos · Precios ·
 *   Consultas · Contabilidad · Ayuda
 *
 * Cada grupo es un DropdownMenu de shadcn. Items deshabilitados (no ocultos)
 * cuando el usuario no tiene permisos o el rol requerido.
 *
 * Altura del bar: h-9 (más compacto).
 */
import { BRANDING } from "@/assets/branding"
import { useState } from 'react'
import {
  ArrowLeftRight,
  Boxes,
  Building2,
  Calculator,
  ChevronDown,
  CreditCard,
  FileSpreadsheet,
  HardDrive,
  History,
  Info,
  Landmark,
  LogOut,
  Network,
  Package,
  PackagePlus,
  Power,
  Receipt,
  Save,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Tag,
  Tags,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { useWindowManager } from '@/contexts/WindowManagerContext'
import { hasPermission, ROLE_LABELS, type PermissionAction } from '@/lib/permissions'
import type { Role } from '@/types/api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface MenuItem {
  pageKey?: string
  label: string
  icon?: LucideIcon
  shortcut?: string
  requires?: PermissionAction
  roles?: Role[]
  separator?: boolean
  action?: 'logout' | 'exit'
  /** Tab inicial cuando la página soporte tabs (ej. Configuración). */
  initialTab?: string
}

interface MenuGroup {
  name: string
  items: MenuItem[]
}

const GROUPS: MenuGroup[] = [
  {
    name: 'Archivo',
    items: [
      { pageKey: 'empresa', label: 'Mi Empresa', icon: Building2, roles: ['admin'], requires: 'manage_company' },
      { pageKey: 'configuracion', label: 'Configuración General', icon: Settings, roles: ['admin'] },
      { pageKey: 'configuracion', label: 'Configuración Hardware', icon: HardDrive, roles: ['admin'], initialTab: 'hardware' },
      { pageKey: 'configuracion', label: 'Configuración LAN', icon: Network, roles: ['admin'], initialTab: 'lan' },
      { pageKey: 'configuracion', label: 'Backup / Restaurar', icon: Save, roles: ['admin'], initialTab: 'backup' },
      { pageKey: 'configuracion-mp', label: 'Configuración MercadoPago', icon: CreditCard, roles: ['admin'], requires: 'manage_mp_qr' },
      { separator: true, label: '' },
      { action: 'logout', label: 'Cerrar sesión', icon: LogOut, shortcut: 'Ctrl+L' },
      { action: 'exit', label: 'Salir', icon: Power, shortcut: 'Cmd+Q' },
    ],
  },
  {
    name: 'Gestión',
    items: [
      { pageKey: 'articulos', label: 'Artículos', icon: Package, shortcut: 'F1', requires: 'view_articles' },
      { pageKey: 'proveedores', label: 'Proveedores', icon: Truck, shortcut: 'F2', requires: 'manage_suppliers' },
      { pageKey: 'clientes', label: 'Clientes', icon: Users, shortcut: 'F3' },
      { pageKey: 'familias', label: 'Familias', icon: Tags },
      { pageKey: 'usuarios', label: 'Usuarios', icon: ShieldCheck, shortcut: 'F4', roles: ['admin'], requires: 'manage_users' },
      { separator: true, label: '' },
      { pageKey: 'medios-de-pago', label: 'Medios de Pago', icon: CreditCard, roles: ['admin', 'manager'], requires: 'manage_payment_methods' },
      { separator: true, label: '' },
      { pageKey: 'importar-stock', label: 'Importar Stock', icon: FileSpreadsheet, roles: ['admin'], requires: 'import_data' },
    ],
  },
  {
    name: 'Operaciones',
    items: [
      { pageKey: 'ventas', label: 'Ventas', icon: Receipt, shortcut: 'F6', requires: 'create_sale' },
      { pageKey: 'compras', label: 'Compras', icon: ShoppingCart, shortcut: 'F5', requires: 'manage_purchases' },
      { pageKey: 'caja', label: 'Caja', icon: Wallet, shortcut: 'F7' },
    ],
  },
  {
    name: 'Cobros y Pagos',
    items: [
      { pageKey: 'cuentas-corrientes', label: 'Cuentas Corrientes — Clientes', icon: Landmark },
      { pageKey: 'cuentas-corrientes-proveedores', label: 'Cuentas Corrientes — Proveedores', icon: Truck },
      { separator: true, label: '' },
      { pageKey: 'configuracion-mp', label: 'MercadoPago QR (configuración)', icon: CreditCard, roles: ['admin'], requires: 'manage_mp_qr' },
    ],
  },
  {
    name: 'Precios',
    items: [
      { pageKey: 'precios-actualizar', label: 'Actualización Masiva', icon: Tag, requires: 'manage_prices' },
      { pageKey: 'precios-historial', label: 'Historial de Precios', icon: Tags, requires: 'manage_prices' },
    ],
  },
  {
    name: 'Consultas',
    items: [
      { pageKey: 'historial-ventas', label: 'Historial de Ventas', icon: Receipt, shortcut: 'F8' },
      { pageKey: 'historial-compras', label: 'Historial de Compras', icon: History },
      { pageKey: 'historial-cajas', label: 'Historial de Cajas', icon: History, shortcut: 'F9', requires: 'view_reports' },
      { separator: true, label: '' },
      { pageKey: 'generador-compras', label: 'Generador de Compras', icon: PackagePlus, requires: 'view_reports' },
      { pageKey: 'inventario-articulos', label: 'Inventario de Artículos', icon: Boxes, requires: 'view_reports' },
      { pageKey: 'ventas-vendedor', label: 'Ventas por Vendedor', icon: ArrowLeftRight, requires: 'view_reports' },
    ],
  },
  {
    name: 'Contabilidad',
    items: [
      { pageKey: 'contabilidad', label: 'Resumen', icon: Calculator, shortcut: 'F10', requires: 'view_accounting' },
      { pageKey: 'libro-iva-ventas', label: 'Libro IVA Ventas', icon: Calculator, requires: 'view_accounting' },
      { pageKey: 'libro-iva-compras', label: 'Libro IVA Compras', icon: Calculator, requires: 'view_accounting' },
    ],
  },
  {
    name: 'Ayuda',
    items: [
      { pageKey: 'acerca-de', label: 'Acerca de', icon: Info },
    ],
  },
]

export function MenuBar() {
  const { currentUser, logout } = useAuth()
  const wm = useWindowManager()
  const [openMenu, setOpenMenu] = useState<string | null>(null)

  function isEnabled(item: MenuItem): boolean {
    if (item.separator) return true
    if (item.action) return true
    if (item.roles && (!currentUser || !item.roles.includes(currentUser.role))) return false
    if (item.requires && !hasPermission(currentUser?.role, item.requires)) return false
    return true
  }

  function handleSelect(item: MenuItem) {
    if (item.action === 'logout') {
      void logout()
      return
    }
    if (item.action === 'exit') {
      window.close()
      return
    }
    if (item.pageKey) {
      wm.openWindow({
        pageKey: item.pageKey,
        ...(item.initialTab ? { extras: { initialTab: item.initialTab } } : {}),
      })
    }
  }

  return (
    <div data-chrome="menubar" className="flex h-9 shrink-0 items-center gap-1 border-b bg-background px-3">
      {/* Logo */}
      <div className="mr-3 flex items-center gap-2">
        <img src={BRANDING.iconSvg} alt="StockFlow" className="h-7 w-7" />
        <span className="text-sm font-semibold">StockFlow</span>
      </div>

      {/* Menús */}
      <div className="flex items-center gap-0.5">
        {GROUPS.map((g) => (
          <DropdownMenu
            key={g.name}
            open={openMenu === g.name}
            onOpenChange={(o) => setOpenMenu(o ? g.name : null)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onMouseEnter={() => { if (openMenu) setOpenMenu(g.name) }}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-sm hover:bg-accent data-[state=open]:bg-accent',
                )}
              >
                {g.name}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[240px]">
              {g.items.map((it, idx) => {
                if (it.separator) return <DropdownMenuSeparator key={`sep-${idx}`} />
                const enabled = isEnabled(it)
                const Icon = it.icon
                return (
                  <DropdownMenuItem
                    key={`${g.name}-${it.label}-${idx}`}
                    disabled={!enabled}
                    onSelect={(e) => {
                      if (!enabled) {
                        e.preventDefault()
                        return
                      }
                      handleSelect(it)
                    }}
                    className={cn(
                      'data-[highlighted]:bg-blue-500/15',
                      !enabled && 'opacity-50 cursor-not-allowed',
                    )}
                  >
                    {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" />}
                    <span className="flex-1">{it.label}</span>
                    {it.shortcut && (
                      <kbd className="ml-2 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                        {it.shortcut}
                      </kbd>
                    )}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
      </div>

      <div className="flex-1" />

      {/* Usuario */}
      {currentUser && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                {currentUser.fullName?.charAt(0).toUpperCase() ?? '?'}
              </div>
              <span>{currentUser.fullName}</span>
              <span className="text-xs text-muted-foreground">· {ROLE_LABELS[currentUser.role]}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void logout()}>
              <LogOut className="h-3.5 w-3.5" />
              Cerrar sesión
              <kbd className="ml-auto rounded bg-muted px-1 text-[10px] text-muted-foreground">Ctrl+L</kbd>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
