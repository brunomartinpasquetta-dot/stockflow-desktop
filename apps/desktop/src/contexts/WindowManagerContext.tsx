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
 * Taskbar). Las operaciones que ya no aplican al modelo nativo (mover/redimensionar
 * desde JS, z-index, ciclar foco) quedan como no-ops o se delegan al SO.
 *
 * `WindowSelfProvider` / `useWindowSelf` / `useWindowParam` siguen vivos: los usa
 * `EmbeddedWindow` para entregarle a cada página sus `params` + `extras`.
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

import { api } from '@/lib/api'
import { WINDOWS } from '@/windows/registry'

export type WindowState = 'normal' | 'minimized' | 'maximized'

/** Param reservado donde viajan los `extras` no-triviales (JSON-encodeados). */
const EXTRAS_PARAM = '__extras'

export interface OpenWindowInput {
  id?: string
  pageKey: string
  title?: string
  iconName?: string
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
  minimizeWindow(id: string): void
  toggleMaximize(id: string): void
  focusWindow(id: string): void
  /** No-op: el SO maneja la posición de las ventanas nativas. */
  moveWindow(id: string, position: { x: number; y: number }): void
  /** No-op: el SO maneja el tamaño de las ventanas nativas. */
  resizeWindow(id: string, size: { width: number; height: number }): void
  /** No-op: el ciclado de foco lo maneja el SO (Alt+Tab / Cmd+`). */
  cycleFocus(direction: 1 | -1): void
  /** Refresca la lista de ventanas nativas desde el main process. */
  refresh(): void
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
    void api.desktopWindow
      .open({
        pageKey: input.pageKey,
        title: input.title ?? def.title,
        ...(params ? { params } : {}),
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

  const minimizeWindow = useCallback((id: string) => {
    // El SO no expone "minimizar otra ventana" desde acá; si es la enfocada
    // se minimiza vía atajo. Como fallback, sólo refrescamos.
    void api.desktopWindow.focus(id).then(() => refresh()).catch(() => undefined)
  }, [refresh])

  const noop = useCallback(() => {
    /* el SO maneja posición / tamaño / z-order de las ventanas nativas */
  }, [])

  const focusedId = useMemo(
    () => windows.find((w) => w.focused)?.windowKey ?? null,
    [windows],
  )

  const value = useMemo<WindowManagerApi>(
    () => ({
      windows,
      focusedId,
      openWindow,
      closeWindow,
      minimizeWindow,
      toggleMaximize: noop,
      focusWindow,
      moveWindow: noop,
      resizeWindow: noop,
      cycleFocus: noop,
      refresh,
    }),
    [windows, focusedId, openWindow, closeWindow, minimizeWindow, focusWindow, noop, refresh],
  )

  return <WindowManagerContext.Provider value={value}>{children}</WindowManagerContext.Provider>
}

export function useWindowManager(): WindowManagerApi {
  const ctx = useContext(WindowManagerContext)
  if (!ctx) throw new Error('useWindowManager debe usarse dentro de WindowManagerProvider')
  return ctx
}

/* ------------------------------------------------------------------------ */
/* WindowSelf: params/extras/close de la ventana embedded actual              */
/* ------------------------------------------------------------------------ */

interface WindowSelfContextValue {
  windowId: string
  params: Record<string, string | number | undefined>
  extras: unknown
  close: () => void
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

/**
 * Lee un param de la ventana actual (si existe). En el modelo de ventanas
 * nativas siempre hay un `WindowSelfProvider` cuando la página corre embedded.
 */
export function useWindowParam(key: string): string | null {
  const self = useContext(WindowSelfContext)
  if (self && self.params[key] != null) return String(self.params[key])
  return null
}
