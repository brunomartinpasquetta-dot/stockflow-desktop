/**
 * Layout (v0.1.17 — ventana principal)
 *
 * La ventana principal de StockFlow: MenuBar + QuickAccessToolbar + StatusBar +
 * WelcomeScreen a pantalla completa + Taskbar. Cada pantalla (Artículos, Ventas,
 * etc.) abre como una `BrowserWindow` nativa del SO independiente — ya no hay un
 * área MDI con divs flotantes. Las rutas internas siguen "absorbiéndose" como
 * ventanas nativas vía `useDeepLinkRouter`.
 */
import { type CSSProperties } from 'react'

import { useLicenseStatus } from '@/contexts/LicenseContext'
import { CommandPalette } from '@/components/CommandPalette'
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext'
import { WindowManagerProvider } from '@/contexts/WindowManagerContext'
import { WhatsAppPanelProvider } from '@/contexts/WhatsAppPanelContext'
import { useGlobalShortcuts } from '@/lib/useGlobalShortcuts'
import { useMdiShortcuts } from '@/lib/useMdiShortcuts'
import { useDeepLinkRouter } from '@/lib/useDeepLinkRouter'
import { MenuBar } from '@/components/MenuBar'
import { OutdatedBanner } from '@/components/OutdatedBanner'
import { QuickAccessToolbar } from '@/components/QuickAccessToolbar'
import { StatusBar } from '@/components/StatusBar'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { Taskbar } from '@/components/Taskbar'

export function Layout() {
  return (
    <WindowManagerProvider>
      <CommandPaletteProvider>
        <WhatsAppPanelProvider>
          <LayoutInner />
        </WhatsAppPanelProvider>
      </CommandPaletteProvider>
    </WindowManagerProvider>
  )
}

function LayoutInner() {
  useGlobalShortcuts()
  useMdiShortcuts()
  useDeepLinkRouter()
  const licenseStatus = useLicenseStatus()
  // Barra de título propia SÓLO en macOS (en Windows queda la nativa, con sus
  // botones de min/max/cerrar).
  const isMac = navigator.userAgent.includes('Mac')

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {isMac && (
        // Barra de título azul StockFlow. Arrastrable; los traffic lights de
        // macOS se dibujan encima a la izquierda (titleBarStyle hiddenInset).
        <div
          data-chrome="titlebar"
          className="relative flex h-8 shrink-0 items-center bg-primary text-primary-foreground"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] font-semibold">
            StockFlow — Sistema de Gestión Comercial
          </span>
        </div>
      )}
      {licenseStatus === 'readOnly' && (
        <div data-chrome="readonly-banner" className="shrink-0 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-destructive-foreground">
          ⚠ Suscripción suspendida — regularizá el pago para volver a operar. Sólo lectura.
        </div>
      )}
      <OutdatedBanner />
      <MenuBar />
      <QuickAccessToolbar />
      <StatusBar />
      <div className="min-h-0 flex-1 overflow-hidden">
        <WelcomeScreen />
      </div>
      <Taskbar />
      <CommandPalette />
    </div>
  )
}
