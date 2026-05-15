/**
 * QuickAccessToolbar (P-MDI-TOOLBAR).
 *
 * Barra horizontal con 10 botones grandes de acceso rápido a las pantallas
 * más usadas. Cada botón abre la window correspondiente vía WindowManager.
 *
 * Atajos F-keys mostrados como chip text-[10px]. Items deshabilitados (no
 * ocultos) cuando el usuario no tiene permisos.
 *
 * Responsive (Tailwind only):
 *  - <1200px (xl:): w-16 en vez de w-20
 *  - <900px  (lg:): oculta label, solo icon + F-key
 *  - <700px  (md:): overflow-x-auto para scroll horizontal
 */
import {
  BarChart3,
  BookUser,
  Calculator,
  History,
  Package,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { useWindowManager } from '@/contexts/WindowManagerContext'
import { hasPermission, type PermissionAction } from '@/lib/permissions'
import type { Role } from '@/types/api'
import { WINDOWS } from '@/windows/registry'
import { cn } from '@/lib/utils'

interface QuickButton {
  pageKey: string
  label: string
  fKey?: string
  Icon: LucideIcon
}

const BUTTONS: QuickButton[] = [
  { pageKey: 'articulos', label: 'Artículos', fKey: 'F1', Icon: Package },
  { pageKey: 'proveedores', label: 'Proveedores', fKey: 'F2', Icon: Truck },
  { pageKey: 'clientes', label: 'Clientes', fKey: 'F3', Icon: Users },
  { pageKey: 'ventas', label: 'Ventas', fKey: 'F6', Icon: ShoppingCart },
  { pageKey: 'compras', label: 'Compras', fKey: 'F5', Icon: ShoppingBag },
  { pageKey: 'caja', label: 'Caja', fKey: 'F7', Icon: Wallet },
  { pageKey: 'historial-ventas', label: 'Historial Ventas', fKey: 'F8', Icon: History },
  { pageKey: 'cuentas-corrientes', label: 'Ctas. Cte.', Icon: BookUser },
  { pageKey: 'estadisticas', label: 'Estadísticas', Icon: BarChart3 },
  { pageKey: 'contabilidad', label: 'Contabilidad', fKey: 'F10', Icon: Calculator },
]

export function QuickAccessToolbar() {
  const { currentUser } = useAuth()
  const wm = useWindowManager()
  const focusedKey = wm.windows.find((w) => w.id === wm.focusedId)?.pageKey ?? null

  function isEnabled(pageKey: string): boolean {
    const def = WINDOWS[pageKey]
    if (!def) return false
    const role: Role | undefined = currentUser?.role
    if (def.roles && (!role || !def.roles.includes(role))) return false
    if (def.requires && !hasPermission(role, def.requires as PermissionAction)) return false
    return true
  }

  return (
    <div data-chrome="toolbar" className="flex h-20 shrink-0 items-center gap-2 overflow-x-auto border-b bg-card px-3 md:overflow-x-visible">
      {BUTTONS.map((btn) => {
        const enabled = isEnabled(btn.pageKey)
        const active = focusedKey === btn.pageKey
        const Icon = btn.Icon
        return (
          <button
            key={btn.pageKey + btn.label}
            type="button"
            disabled={!enabled}
            onClick={() => {
              if (!enabled) return
              wm.openWindow({ pageKey: btn.pageKey })
            }}
            title={btn.fKey ? `${btn.label} (${btn.fKey})` : btn.label}
            className={cn(
              'group flex h-full w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-transparent px-1.5 py-1 transition-colors xl:w-20',
              '[@media(max-width:1199px)]:w-16',
              'hover:bg-accent focus:outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-primary/30',
              active && 'bg-accent ring-2 ring-primary/30',
              !enabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            <Icon className="h-7 w-7 text-foreground/80 group-hover:text-foreground" strokeWidth={1.75} />
            <span className="text-center text-[11px] leading-tight text-foreground/90 [@media(max-width:899px)]:hidden">
              {btn.label}
            </span>
            {btn.fKey && (
              <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                {btn.fKey}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
