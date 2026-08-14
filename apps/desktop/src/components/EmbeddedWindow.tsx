/**
 * EmbeddedWindow (v0.1.17)
 *
 * Renderiza una única página del registry a pantalla completa, SIN el chrome de
 * la app (MenuBar / Toolbar / StatusBar / Taskbar). Es el contenido de cada
 * BrowserWindow nativa: la ruta `#/embedded/:pageKey` la monta.
 *
 * - `:pageKey` → busca el componente en `WINDOWS[pageKey]`.
 * - searchParams → se exponen como `params` vía `WindowSelfProvider`, igual que
 *   hacía el viejo MDI. Los `extras` (objetos como `initialTab` / `prefilledLines`)
 *   viajan JSON-encodeados en el param reservado `__extras`.
 * - Gating de sesión: si no hay usuario logueado, muestra "Sesión cerrada" y un
 *   botón para cerrar la ventana (el login vive en la ventana principal).
 *
 * Los providers globales (QueryClient, Tooltip, Lan, License) ya envuelven a
 * todo el RouterProvider en `main.tsx`, así que esta ruta los hereda. Sólo falta
 * `AuthProvider`, que lo aporta `AuthShell` arriba de las rutas.
 */
import { type CSSProperties, Suspense, useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/contexts/AuthContext'
import { PageSpinner } from '@/components/PageSpinner'
import { WindowManagerProvider, WindowSelfProvider } from '@/contexts/WindowManagerContext'
import { api } from '@/lib/api'
import { hasPermissionFor, type PermissionAction } from '@/lib/permissions'
import { useEmbeddedShortcuts } from '@/lib/useEmbeddedShortcuts'
import { WINDOWS } from '@/windows/registry'

/** Param reservado donde viajan los `extras` no-triviales (JSON-encodeados). */
const EXTRAS_PARAM = '__extras'

function decodeExtras(raw: string | null): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function EmbeddedWindow() {
  const { pageKey } = useParams<{ pageKey: string }>()
  const [searchParams] = useSearchParams()
  const { currentUser, loading } = useAuth()
  useEmbeddedShortcuts()

  const def = pageKey ? WINDOWS[pageKey] : undefined

  // Título nativo por función (cada ventana de módulo tiene su propio título).
  useEffect(() => {
    if (def?.title) document.title = `${def.title} - StockFlow`
  }, [def?.title])

  // Params planos de la querystring (excluyendo el param reservado de extras).
  const params = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [k, v] of searchParams.entries()) {
      if (k === EXTRAS_PARAM) continue
      out[k] = v
    }
    return out
  }, [searchParams])

  const extras = useMemo(() => decodeExtras(searchParams.get(EXTRAS_PARAM)), [searchParams])

  if (loading) {
    return <PageSpinner />
  }

  if (!currentUser) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background px-8 text-center">
        <p className="text-sm font-medium">Sesión cerrada</p>
        <p className="text-xs text-muted-foreground">
          Iniciá sesión para seguir trabajando.
        </p>
        <button
          type="button"
          onClick={() => {
            if ((window as { __stockflowWeb?: boolean }).__stockflowWeb) window.location.hash = '#/login'
            else void api.desktopWindow.closeSelf()
          }}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {(window as { __stockflowWeb?: boolean }).__stockflowWeb ? 'Iniciar sesión' : 'Cerrar ventana'}
        </button>
      </div>
    )
  }

  if (!pageKey || !def) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background px-8 text-center">
        <p className="text-sm font-medium">Ventana desconocida</p>
        <p className="text-xs text-muted-foreground">
          La pantalla «{pageKey}» no existe.
        </p>
      </div>
    )
  }

  // Permisos: se validan ACÁ, después de que `loading` terminó y con
  // `currentUser` ya resuelto. Las páginas hacen `<Navigate to="/">` cuando no
  // tienen permiso; si eso corriera dentro de una ventana de módulo, la ventana
  // se convertiría en OTRO panel principal (bug "sistema duplicado"). Cortamos
  // antes de montar la página.
  const roleOk = !def.roles || (currentUser.role && def.roles.includes(currentUser.role))
  const permOk = !def.requires || hasPermissionFor(currentUser.permissions, def.requires as PermissionAction)
  if (!roleOk || !permOk) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background px-8 text-center">
        <p className="text-sm font-medium">No tenés permiso para ver «{def.title}»</p>
        <p className="text-xs text-muted-foreground">
          Pedile a un administrador que te habilite el acceso.
        </p>
        <button
          type="button"
          onClick={() => {
            void api.desktopWindow.closeSelf()
          }}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
        >
          Cerrar ventana
        </button>
      </div>
    )
  }

  const Component = def.component
  const enNavegador = (window as { __stockflowWeb?: boolean }).__stockflowWeb === true
  const esMac = navigator.userAgent.includes('Mac')

  return (
    <div className="flex h-screen flex-col bg-secondary/30">
      {/* En el navegador todo pasa en una sola pestaña: hace falta una forma
          clara de volver al menú principal, porque no hay ventanas que cerrar. */}
      {/* Barra de título AZUL propia. La ventana nativa oculta la del sistema
          (para poder teñirla), así que el título lo dibujamos acá — si no, la
          ventana del módulo queda sin título. Arrastrable, como la principal. */}
      {!enNavegador && (
        <div
          data-chrome="titlebar"
          className="relative flex h-8 shrink-0 items-center bg-primary text-primary-foreground"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
          <span
            className="pointer-events-none absolute inset-y-0 flex items-center justify-center text-[13px] font-semibold"
            style={esMac ? { left: 0, right: 0 } : { left: 0, right: 140 }}
          >
            {def.title} — StockFlow
          </span>
        </div>
      )}
      {enNavegador && (
        <div className="flex shrink-0 items-center gap-3 border-b bg-background px-3 py-2">
          <button
            type="button"
            onClick={() => { window.location.hash = '#/' }}
            className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
          >
            ← Volver al inicio
          </button>
          <span className="text-sm font-medium">{def.title}</span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
      {/*
        WindowManagerProvider también acá: páginas como Compras usan `useWindowNav`
        (→ useWindowManager) para abrir OTRAS ventanas nativas desde adentro. En el
        modo embedded el proxy IPC sigue siendo válido.
      */}
      <WindowManagerProvider>
        <WindowSelfProvider
          value={{
            windowId: pageKey,
            params,
            extras,
            close: () => {
              void api.desktopWindow.closeSelf()
            },
          }}
        >
          <Suspense fallback={<PageSpinner />}>
            <Component />
          </Suspense>
        </WindowSelfProvider>
      </WindowManagerProvider>
      </div>
    </div>
  )
}
