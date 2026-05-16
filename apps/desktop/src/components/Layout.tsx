/**
 * Layout (P-MDI-LAYOUT)
 *
 * Reemplaza el sidebar vertical por un MenuBar horizontal + StatusBar + Desktop
 * MDI + Taskbar. Las páginas se renderizan dentro de ventanas flotantes; el
 * `<Outlet />` original ya no se usa (las rutas internas se "absorben" como
 * ventanas — ver `useDeepLinkRouter`).
 */
import { useLicenseStatus } from '@/contexts/LicenseContext'
import { CommandPalette } from '@/components/CommandPalette'
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext'
import { WindowManagerProvider } from '@/contexts/WindowManagerContext'
import { useGlobalShortcuts } from '@/lib/useGlobalShortcuts'
import { useMdiShortcuts } from '@/lib/useMdiShortcuts'
import { useDeepLinkRouter } from '@/lib/useDeepLinkRouter'
import { MenuBar } from '@/components/MenuBar'
import { OutdatedBanner } from '@/components/OutdatedBanner'
import { QuickAccessToolbar } from '@/components/QuickAccessToolbar'
import { StatusBar } from '@/components/StatusBar'
import { Desktop } from '@/components/Desktop'
import { Taskbar } from '@/components/Taskbar'

export function Layout() {
  return (
    <WindowManagerProvider>
      <CommandPaletteProvider>
        <LayoutInner />
      </CommandPaletteProvider>
    </WindowManagerProvider>
  )
}

function LayoutInner() {
  useGlobalShortcuts()
  useMdiShortcuts()
  useDeepLinkRouter()
  const licenseStatus = useLicenseStatus()

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {licenseStatus === 'readOnly' && (
        <div data-chrome="readonly-banner" className="shrink-0 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-destructive-foreground">
          ⚠ Suscripción suspendida — regularizá el pago para volver a operar. Sólo lectura.
        </div>
      )}
      <OutdatedBanner />
      <MenuBar />
      <QuickAccessToolbar />
      <StatusBar />
      <Desktop />
      <Taskbar />
      <CommandPalette />
    </div>
  )
}
