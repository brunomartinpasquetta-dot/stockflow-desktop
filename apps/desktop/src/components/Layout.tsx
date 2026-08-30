/**
 * Layout (v0.1.17 — ventana principal)
 *
 * La ventana principal de StockFlow: MenuBar + QuickAccessToolbar + StatusBar +
 * WelcomeScreen a pantalla completa + Taskbar. Cada pantalla (Artículos, Ventas,
 * etc.) abre como una `BrowserWindow` nativa del SO independiente — ya no hay un
 * área MDI con divs flotantes. Las rutas internas siguen "absorbiéndose" como
 * ventanas nativas vía `useDeepLinkRouter`.
 */
import { type CSSProperties, useEffect, useState } from 'react'

import { api } from '@/lib/api'
import { useLicense, useLicenseStatus } from '@/contexts/LicenseContext'
import { CommandPaletteProvider } from '@/contexts/CommandPaletteContext'
import { WindowManagerProvider } from '@/contexts/WindowManagerContext'
import { WhatsAppPanelProvider } from '@/contexts/WhatsAppPanelContext'
import { AssistantProvider } from '@/contexts/AssistantContext'
import { AssistantPanel } from '@/components/AssistantPanel'
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
          <AssistantProvider>
            <LayoutInner />
          </AssistantProvider>
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
  const { state: licenseState } = useLicense()
  const isTrial = licenseState?.trial === true
  // Barra de título propia en las DOS plataformas. En Windows el sistema sigue
  // dibujando los botones de min/max/cerrar sobre la derecha (titleBarOverlay),
  // así que el título se corre para no quedar debajo de ellos.
  const isMac = navigator.userAgent.includes('Mac')
  const esWeb = Boolean((window as { __stockflowWeb?: boolean }).__stockflowWeb)
  // Versión de la app, para mostrarla al final del título de la ventana.
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    void api.system
      .getVersion()
      .then((r) => {
        setAppVersion(r.version)
        // Título nativo (Windows/Linux, y el nombre en la barra de tareas).
        document.title = `StockFlow - Sistema de Gestión Comercial v${r.version}`
      })
      .catch(() => undefined)
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {!esWeb && (
        // Barra de título azul StockFlow. Arrastrable. En mac los traffic
        // lights van encima a la izquierda; en Windows los controles del
        // sistema van a la derecha, por eso el título se centra dejándoles
        // lugar. En el navegador NO va: ahí manda la ventana de Chrome.
        <div
          data-chrome="titlebar"
          className="relative flex h-8 shrink-0 items-center bg-primary text-primary-foreground"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
          <span
            className="pointer-events-none absolute inset-y-0 flex items-center justify-center text-[13px] font-semibold"
            style={isMac ? { left: 0, right: 0 } : { left: 0, right: 140 }}
          >
            StockFlow — Sistema de Gestión Comercial{appVersion ? ` v${appVersion}` : ''}
          </span>
        </div>
      )}
      {licenseStatus === 'readOnly' && (
        <div data-chrome="readonly-banner" className="shrink-0 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-destructive-foreground">
          {isTrial
            ? '⏳ Tu prueba gratis de 30 días terminó — tus datos están intactos, pero el sistema quedó en sólo lectura. Escribinos por WhatsApp al +54 342 584 7340 y lo activamos en el día.'
            : '⚠ Suscripción suspendida — regularizá el pago para volver a operar. Sólo lectura.'}
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
      <AssistantPanel screen="principal" />
    </div>
  )
}
