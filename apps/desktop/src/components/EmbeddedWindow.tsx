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
import { Suspense, useEffect, useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/contexts/AuthContext'
import { PageSpinner } from '@/components/PageSpinner'
import { WindowManagerProvider, WindowSelfProvider } from '@/contexts/WindowManagerContext'
import { api } from '@/lib/api'
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
          Volvé a la ventana principal para iniciar sesión.
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

  const Component = def.component

  return (
    <div className="h-screen overflow-auto bg-secondary/30 p-4">
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
  )
}
