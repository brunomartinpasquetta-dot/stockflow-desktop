/**
 * QuickAccessToolbar (P-MDI-TOOLBAR).
 *
 * Barra horizontal con 13 botones grandes de acceso rápido a las pantallas
 * más usadas. Cada botón abre la window correspondiente vía WindowManager.
 * F-keys secuenciales F1..F12 en orden de la barra (Configuración sin atajo).
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
  Settings,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Truck,
  Users,
  Banknote,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { useWindowManager } from '@/contexts/WindowManagerContext'
import { useWhatsAppPanel } from '@/contexts/WhatsAppPanelContext'
import { WhatsAppGlyph } from '@/components/WhatsAppGlyph'
import { hasPermissionFor, type PermissionAction } from '@/lib/permissions'
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
  { pageKey: 'compras', label: 'Compras', fKey: 'F2', Icon: ShoppingBag },
  { pageKey: 'proveedores', label: 'Proveedores', fKey: 'F3', Icon: Truck },
  { pageKey: 'caja', label: 'Caja diaria', fKey: 'F4', Icon: Wallet },
  { pageKey: 'ventas', label: 'Ventas', fKey: 'F5', Icon: ShoppingCart },
  { pageKey: 'clientes', label: 'Clientes', fKey: 'F6', Icon: Users },
  { pageKey: 'historial-ventas', label: 'Historial Ventas', fKey: 'F7', Icon: History },
  { pageKey: 'cuentas-corrientes', label: 'Ctas. Cte.', fKey: 'F9', Icon: BookUser },
  { pageKey: 'contabilidad', label: 'Contabilidad', fKey: 'F10', Icon: Calculator },
  { pageKey: 'estadisticas', label: 'Estadísticas', fKey: 'F11', Icon: BarChart3 },
  { pageKey: 'caja-general', label: 'Caja General', fKey: 'F8', Icon: Banknote },
  { pageKey: 'usuarios', label: 'Usuarios', fKey: 'F12', Icon: ShieldCheck },
  { pageKey: 'configuracion', label: 'Configuración', Icon: Settings },
]

export function QuickAccessToolbar() {
  const { currentUser } = useAuth()
  const wm = useWindowManager()
  const wa = useWhatsAppPanel()
  const focusedKey = wm.windows.find((w) => w.id === wm.focusedId)?.pageKey ?? null

  function isEnabled(pageKey: string): boolean {
    const def = WINDOWS[pageKey]
    if (!def) return false
    const role: Role | undefined = currentUser?.role
    if (def.roles && (!role || !def.roles.includes(role))) return false
    if (def.requires && !hasPermissionFor(currentUser?.permissions, def.requires as PermissionAction)) return false
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
              // min-w y no ancho fijo: "Caja General" u "Historial Ventas" en
              // DOS renglones desalineaba los íconos entre sí.
              'group flex h-full min-w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-transparent px-2 py-1 transition-colors',
              'hover:bg-accent focus:outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-primary/30',
              active && 'bg-accent text-accent-foreground ring-2 ring-primary/30 [&_.rounded.bg-muted]:bg-white/25 [&_.rounded.bg-muted]:text-inherit',
              !enabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            <Icon className="h-7 w-7 text-foreground/80 group-hover:text-foreground" strokeWidth={1.75} />
            <span className="whitespace-nowrap text-center text-[11px] leading-tight text-foreground/90 [@media(max-width:899px)]:hidden">
              {btn.label}
            </span>
            {btn.fKey ? (
              // Sobre el foco/hover azul (bg-accent) el chip pasa a fondo
              // translúcido blanco para seguir legible.
              <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground group-hover:bg-white/25 group-hover:text-inherit group-focus-visible:bg-white/25 group-focus-visible:text-inherit">
                {btn.fKey}
              </span>
            ) : (
              <span aria-hidden className="invisible rounded px-1 text-[10px] font-medium">F</span>
            )}
          </button>
        )
      })}

      {/* Toggle del panel de WhatsApp (POC) */}
      <button
        type="button"
        onClick={() => wa.toggle()}
        title="WhatsApp"
        className={cn(
          'group flex h-full w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-transparent px-1.5 py-1 transition-colors xl:w-20',
          '[@media(max-width:1199px)]:w-16',
          'hover:bg-accent focus:outline-none focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-primary/30',
          wa.state !== 'hidden' && 'bg-accent ring-2 ring-primary/30',
        )}
      >
        <WhatsAppGlyph className="h-7 w-7 text-foreground/80 group-hover:text-foreground" strokeWidth={1.75} />
        <span className="text-center text-[11px] leading-tight text-foreground/90 [@media(max-width:899px)]:hidden">
          WhatsApp
        </span>
        <span aria-hidden className="invisible rounded px-1 text-[10px] font-medium">F</span>
      </button>
    </div>
  )
}
