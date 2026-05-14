/**
 * WindowManagerContext (P-MDI-LAYOUT)
 *
 * Gestiona ventanas internas estilo MDI: cada "página" se renderiza dentro de un
 * `<InternalWindow>` flotante con drag/resize/minimize/maximize/close. Una sola
 * instancia por pageKey (default). Persistencia en sessionStorage.
 *
 * El árbol de ventanas se entrega vía `useWindowManager()`. Cada InternalWindow
 * recibe sus `params` y, opcionalmente, `extras` (objetos no-serializables como
 * `prefilledLines`) vía un store auxiliar.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import { WINDOWS } from '@/windows/registry'

export type WindowState = 'normal' | 'minimized' | 'maximized'

export interface InternalWindowState {
  id: string
  title: string
  iconName?: string
  pageKey: string
  params: Record<string, string | number | undefined>
  position: { x: number; y: number }
  size: { width: number; height: number }
  prevPosition?: { x: number; y: number }
  prevSize?: { width: number; height: number }
  zIndex: number
  state: WindowState
  openedAt: number
}

export interface OpenWindowInput {
  id?: string
  pageKey: string
  title?: string
  iconName?: string
  params?: Record<string, string | number | undefined>
  extras?: unknown
}

export interface WindowManagerApi {
  windows: InternalWindowState[]
  focusedId: string | null
  openWindow(input: OpenWindowInput): void
  closeWindow(id: string): void
  minimizeWindow(id: string): void
  toggleMaximize(id: string): void
  focusWindow(id: string): void
  moveWindow(id: string, position: { x: number; y: number }): void
  resizeWindow(id: string, size: { width: number; height: number }): void
  cycleFocus(direction: 1 | -1): void
  getExtras(id: string): unknown
  setExtras(id: string, extras: unknown): void
}

const WindowManagerContext = createContext<WindowManagerApi | null>(null)

const STORAGE_KEY = 'stockflow:windows'
const MAX_WINDOWS = 10
const Z_BASE = 30
const Z_MAX = 49 // bajo z-50 de Dialog/Dropdown shadcn

function defaultSizeFor(pageKey: string): { width: number; height: number } {
  const def = WINDOWS[pageKey]
  if (def?.defaultSize) return def.defaultSize
  const w = Math.min(1100, typeof window !== 'undefined' ? window.innerWidth - 200 : 1100)
  const h = Math.min(700, typeof window !== 'undefined' ? window.innerHeight - 200 : 700)
  return { width: Math.max(600, w), height: Math.max(400, h) }
}

function cascadeOffset(n: number): { x: number; y: number } {
  return { x: 80 + 20 * n, y: 80 + 20 * n }
}

function isSmallViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 1280
}

function loadFromStorage(): InternalWindowState[] {
  if (typeof sessionStorage === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as InternalWindowState[]
    if (!Array.isArray(parsed)) return []
    // Filtrar ventanas cuyo pageKey ya no exista en el registry.
    return parsed.filter((w) => Boolean(WINDOWS[w.pageKey]))
  } catch {
    return []
  }
}

export function WindowManagerProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<InternalWindowState[]>(() => loadFromStorage())
  const [focusedId, setFocusedId] = useState<string | null>(() => {
    const arr = loadFromStorage()
    if (arr.length === 0) return null
    return arr.reduce((acc, w) => (w.zIndex > acc.zIndex ? w : acc)).id
  })
  const extrasRef = useRef<Record<string, unknown>>({})

  // Persistencia (no guardamos extras: son objetos pesados que se recalculan al abrir).
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(windows))
    } catch {
      /* ignore quota */
    }
  }, [windows])

  const nextZ = useCallback((arr: InternalWindowState[]): number => {
    const max = arr.reduce((m, w) => Math.max(m, w.zIndex), Z_BASE - 1)
    return Math.min(max + 1, Z_MAX)
  }, [])

  const focusWindow = useCallback((id: string) => {
    setWindows((prev) => {
      const target = prev.find((w) => w.id === id)
      if (!target) return prev
      const z = nextZ(prev)
      return prev.map((w) =>
        w.id === id
          ? { ...w, zIndex: z, state: w.state === 'minimized' ? 'normal' : w.state }
          : w,
      )
    })
    setFocusedId(id)
  }, [nextZ])

  const openWindow = useCallback((input: OpenWindowInput) => {
    const def = WINDOWS[input.pageKey]
    if (!def) {
      toast.error(`Ventana desconocida: ${input.pageKey}`)
      return
    }
    const id = input.id ?? input.pageKey
    setWindows((prev) => {
      const existing = prev.find((w) => w.id === id)
      if (existing) {
        // Re-foco + restore + actualizar params/extras si vinieron nuevos.
        const z = nextZ(prev)
        if (input.extras !== undefined) extrasRef.current[id] = input.extras
        const newParams = input.params ?? existing.params
        return prev.map((w) =>
          w.id === id
            ? {
                ...w,
                zIndex: z,
                state: w.state === 'minimized' ? 'normal' : w.state,
                params: newParams,
              }
            : w,
        )
      }
      if (prev.length >= MAX_WINDOWS) {
        toast.warning('Demasiadas ventanas abiertas — cerrá alguna primero')
        return prev
      }
      const size = defaultSizeFor(input.pageKey)
      const pos = cascadeOffset(prev.length)
      if (input.extras !== undefined) extrasRef.current[id] = input.extras
      const newWin: InternalWindowState = {
        id,
        title: input.title ?? def.title,
        iconName: input.iconName ?? def.iconName,
        pageKey: input.pageKey,
        params: input.params ?? {},
        position: pos,
        size,
        zIndex: nextZ(prev),
        state: isSmallViewport() ? 'maximized' : 'normal',
        openedAt: Date.now(),
      }
      // Si vamos a maximizar, guardamos prev para poder restaurar.
      if (newWin.state === 'maximized') {
        newWin.prevPosition = pos
        newWin.prevSize = size
      }
      return [...prev, newWin]
    })
    setFocusedId(id)
  }, [nextZ])

  const closeWindow = useCallback((id: string) => {
    setWindows((prev) => prev.filter((w) => w.id !== id))
    delete extrasRef.current[id]
    setFocusedId((prev) => (prev === id ? null : prev))
  }, [])

  const minimizeWindow = useCallback((id: string) => {
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, state: 'minimized' as WindowState } : w)))
    setFocusedId((prev) => (prev === id ? null : prev))
  }, [])

  const toggleMaximize = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) => {
        if (w.id !== id) return w
        if (w.state === 'maximized') {
          return {
            ...w,
            state: 'normal' as WindowState,
            position: w.prevPosition ?? w.position,
            size: w.prevSize ?? w.size,
          }
        }
        return {
          ...w,
          state: 'maximized' as WindowState,
          prevPosition: w.position,
          prevSize: w.size,
        }
      }),
    )
    setFocusedId(id)
  }, [])

  const moveWindow = useCallback((id: string, position: { x: number; y: number }) => {
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, position } : w)))
  }, [])

  const resizeWindow = useCallback((id: string, size: { width: number; height: number }) => {
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, size } : w)))
  }, [])

  const cycleFocus = useCallback((direction: 1 | -1) => {
    setWindows((prev) => {
      if (prev.length === 0) return prev
      const ordered = [...prev].sort((a, b) => a.openedAt - b.openedAt)
      const idx = ordered.findIndex((w) => w.id === focusedId)
      const nextIdx = idx < 0 ? 0 : (idx + direction + ordered.length) % ordered.length
      const target = ordered[nextIdx]
      if (!target) return prev
      const z = nextZ(prev)
      setFocusedId(target.id)
      return prev.map((w) =>
        w.id === target.id
          ? { ...w, zIndex: z, state: w.state === 'minimized' ? 'normal' : w.state }
          : w,
      )
    })
  }, [focusedId, nextZ])

  const getExtras = useCallback((id: string) => extrasRef.current[id], [])
  const setExtras = useCallback((id: string, extras: unknown) => {
    extrasRef.current[id] = extras
  }, [])

  const value = useMemo<WindowManagerApi>(
    () => ({
      windows,
      focusedId,
      openWindow,
      closeWindow,
      minimizeWindow,
      toggleMaximize,
      focusWindow,
      moveWindow,
      resizeWindow,
      cycleFocus,
      getExtras,
      setExtras,
    }),
    [windows, focusedId, openWindow, closeWindow, minimizeWindow, toggleMaximize, focusWindow, moveWindow, resizeWindow, cycleFocus, getExtras, setExtras],
  )

  return <WindowManagerContext.Provider value={value}>{children}</WindowManagerContext.Provider>
}

export function useWindowManager(): WindowManagerApi {
  const ctx = useContext(WindowManagerContext)
  if (!ctx) throw new Error('useWindowManager debe usarse dentro de WindowManagerProvider')
  return ctx
}

/** Context con params/extras/close de la ventana actual (para que la página los lea). */
interface WindowSelfContextValue {
  windowId: string
  params: Record<string, string | number | undefined>
  extras: unknown
  close: () => void
}

const WindowSelfContext = createContext<WindowSelfContextValue | null>(null)

export function WindowSelfProvider({ value, children }: { value: WindowSelfContextValue; children: ReactNode }) {
  return <WindowSelfContext.Provider value={value}>{children}</WindowSelfContext.Provider>
}

export function useWindowSelf(): WindowSelfContextValue | null {
  return useContext(WindowSelfContext)
}

/**
 * Lee un param de la ventana actual (si existe) o cae al `useSearchParams` global.
 * Permite que páginas existentes sigan funcionando con minimal change.
 */
export function useWindowParam(key: string): string | null {
  const self = useContext(WindowSelfContext)
  if (self && self.params[key] != null) return String(self.params[key])
  return null
}
