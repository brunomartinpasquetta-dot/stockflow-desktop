/**
 * WindowManagerContext (v0.1.17 — ventanas nativas del SO)
 *
 * Antes este contexto gestionaba ventanas internas estilo MDI (divs flotantes).
 * Ahora cada pantalla abre como una `BrowserWindow` nativa del SO: el gestor
 * real vive en el main process (`electron/desktop-windows.ts`) y este contexto
 * es sólo un PROXY de IPC.
 *
 * La API pública de `useWindowManager()` se mantiene para no romper los callers
 * (MenuBar, QuickAccessToolbar, useMdiShortcuts, useDeepLinkRouter, useWindowNav,
 * Taskbar). Mover, redimensionar, minimizar y ciclar el foco lo maneja el SO.
 *
 * `WindowSelfProvider` / `useWindowSelf` siguen vivos: los usa `EmbeddedWindow`
 * para entregarle a cada página sus `extras` (los params planos de la URL las
 * páginas los leen con `useSearchParams`).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import { router } from '@/router'

import { api } from '@/lib/api'
import { WINDOWS } from '@/windows/registry'

/**
 * Param reservado donde viajan los `extras` no-triviales (JSON-encodeados).
 * El main process usa el mismo nombre (`electron/desktop-windows.ts`).
 */
export const EXTRAS_PARAM = '__extras'

export interface OpenWindowInput {
  pageKey: string
  title?: string
  params?: Record<string, string | number | undefined>
  /** Objetos serializables (initialTab, prefilledLines, ...) — viajan a la ventana nativa. */
  extras?: unknown
}

/** Forma "ligera" de una ventana nativa abierta (la entrega `desktopWindow:list`). */
export interface NativeWindowInfo {
  id: string
  windowKey: string
  pageKey: string
  title: string
  iconName?: string
  minimized: boolean
  focused: boolean
}

export interface WindowManagerApi {
  /** Ventanas nativas abiertas (refrescado por polling de `desktopWindow:list`). */
  windows: NativeWindowInfo[]
  /** windowKey de la ventana nativa enfocada, o null. */
  focusedId: string | null
  openWindow(input: OpenWindowInput): void
  closeWindow(id: string): void
  focusWindow(id: string): void
}

const WindowManagerContext = createContext<WindowManagerApi | null>(null)

/**
 * Construye el objeto `params` que viaja a la ventana nativa: combina los
 * `params` planos con los `extras` (JSON-encodeados en el param reservado).
 */
function buildParams(input: OpenWindowInput): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (input.params) {
    for (const [k, v] of Object.entries(input.params)) {
      if (v === undefined) continue
      out[k] = String(v)
    }
  }
  if (input.extras !== undefined) {
    try {
      out[EXTRAS_PARAM] = JSON.stringify(input.extras)
    } catch {
      /* extras no serializable — se ignora */
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function WindowManagerProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<NativeWindowInfo[]>([])

  const refresh = useCallback(() => {
    void api.desktopWindow
      .list()
      .then((res) => {
        const list = res.windows.map((w): NativeWindowInfo => {
          const def = WINDOWS[w.windowKey]
          return {
            id: w.windowKey,
            windowKey: w.windowKey,
            pageKey: w.windowKey,
            title: w.title,
            iconName: def?.iconName,
            minimized: w.minimized,
            focused: w.focused,
          }
        })
        setWindows(list)
      })
      .catch(() => undefined)
  }, [])

  // Polling liviano: la barra de tareas refleja las ventanas nativas abiertas.
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const openWindow = useCallback((input: OpenWindowInput) => {
    const def = WINDOWS[input.pageKey]
    if (!def) {
      toast.error(`Ventana desconocida: ${input.pageKey}`)
      return
    }
    const params = buildParams(input)

    // En el navegador no hay ventanas del sistema. El módulo se abre en la
    // MISMA pestaña (el usuario trabaja en una sola ventana, como pidió el
    // comercio) y vuelve al inicio con el botón de la barra superior.
    if ((window as { __stockflowWeb?: boolean }).__stockflowWeb) {
      const qs = params ? `?${new URLSearchParams(params as Record<string, string>).toString()}` : ''
      // Se navega con el router y no asignando `location.hash`: los datos que
      // el menú manda (por ejemplo la pestaña de Configuración) van
      // codificados, y al escribirlos a mano en la barra el navegador los
      // rompe y la pantalla no abre.
      void router.navigate(`/embedded/${input.pageKey}${qs}`)
      return
    }

    void api.desktopWindow
      .open({
        pageKey: input.pageKey,
        title: input.title ?? def.title,
        ...(params ? { params } : {}),
        // La ventana ya abierta recibe los `extras` sin recargarse (si la página sabe).
        ...(def.extrasEnVivo ? { extrasEnVivo: true } : {}),
        ...(def.defaultSize ? { width: def.defaultSize.width, height: def.defaultSize.height } : {}),
        ...(def.minWidth ? { minWidth: def.minWidth } : {}),
        ...(def.minHeight ? { minHeight: def.minHeight } : {}),
      })
      .then(() => refresh())
      .catch(() => {
        toast.error(`No se pudo abrir la ventana «${def.title}»`)
      })
  }, [refresh])

  const closeWindow = useCallback((id: string) => {
    void api.desktopWindow.close(id).then(() => refresh()).catch(() => undefined)
  }, [refresh])

  const focusWindow = useCallback((id: string) => {
    void api.desktopWindow.focus(id).then(() => refresh()).catch(() => undefined)
  }, [refresh])

  const focusedId = useMemo(
    () => windows.find((w) => w.focused)?.windowKey ?? null,
    [windows],
  )

  const value = useMemo<WindowManagerApi>(
    () => ({ windows, focusedId, openWindow, closeWindow, focusWindow }),
    [windows, focusedId, openWindow, closeWindow, focusWindow],
  )

  return <WindowManagerContext.Provider value={value}>{children}</WindowManagerContext.Provider>
}

export function useWindowManager(): WindowManagerApi {
  const ctx = useContext(WindowManagerContext)
  if (!ctx) throw new Error('useWindowManager debe usarse dentro de WindowManagerProvider')
  return ctx
}

/* ------------------------------------------------------------------------ */
/* WindowSelf: extras de la ventana embedded actual                           */
/* ------------------------------------------------------------------------ */

interface WindowSelfContextValue {
  extras: unknown
}

const WindowSelfContext = createContext<WindowSelfContextValue | null>(null)

export function WindowSelfProvider({
  value,
  children,
}: {
  value: WindowSelfContextValue
  children: ReactNode
}) {
  return <WindowSelfContext.Provider value={value}>{children}</WindowSelfContext.Provider>
}

export function useWindowSelf(): WindowSelfContextValue | null {
  return useContext(WindowSelfContext)
}
