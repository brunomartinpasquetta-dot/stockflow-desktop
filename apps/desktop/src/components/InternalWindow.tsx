/**
 * InternalWindow (P-MDI-LAYOUT)
 *
 * Ventana flotante draggable/resizable que renderiza una página del registry.
 * - Drag: mousedown en header (excepto botones).
 * - Resize: 8 handles (4 esquinas + 4 bordes).
 * - Botones [_] minimizar, [□] maximizar/restaurar, [×] cerrar.
 * - Doble click en header alterna maximizado.
 * - z-index 30-49 (debajo de Dialog/Dropdown z-50).
 */
import { Suspense, useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { Maximize2, Minus, Square, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { PageSpinner } from '@/components/PageSpinner'
import { useChromeBounds } from '@/lib/useChromeBounds'
import {
  WindowSelfProvider,
  useWindowManager,
  type InternalWindowState,
} from '@/contexts/WindowManagerContext'
import { WINDOWS } from '@/windows/registry'
import { WindowIcon } from '@/windows/WindowIcon'

const HEADER_HEIGHT = 36
const DEFAULT_MIN_WIDTH = 400
const DEFAULT_MIN_HEIGHT = 300

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export function InternalWindow({ window: win }: { window: InternalWindowState }) {
  const wm = useWindowManager()
  const def = WINDOWS[win.pageKey]
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null)
  const resizeRef = useRef<{ dir: ResizeDir; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null)

  const chrome = useChromeBounds()
  const isMax = win.state === 'maximized'
  const isMin = win.state === 'minimized'
  const isFocused = wm.focusedId === win.id

  /**
   * El contenedor `<Desktop>` está debajo de la chrome y arriba de la Taskbar,
   * por lo que su altura útil = `viewport - chrome.top - chrome.bottom`. Las
   * ventanas son `position: absolute` dentro de Desktop, así que `position.y`
   * arranca en `0` (no en `chrome.top`).
   */
  const clampPosition = useCallback((x: number, y: number, w: number) => {
    const vw = globalThis.window.innerWidth
    const desktopH = Math.max(100, globalThis.window.innerHeight - chrome.top - chrome.bottom)
    const minX = -Math.max(0, w - 120)
    const maxX = vw - 80
    const minY = 0
    const maxY = Math.max(0, desktopH - HEADER_HEIGHT)
    return {
      x: Math.min(Math.max(minX, x), maxX),
      y: Math.min(Math.max(minY, y), maxY),
    }
  }, [chrome.top, chrome.bottom])

  // --- DRAG -----------------------------------------------------------------
  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (isMax) return
    wm.focusWindow(win.id)
    dragRef.current = { offsetX: e.clientX - win.position.x, offsetY: e.clientY - win.position.y }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const pos = clampPosition(
        ev.clientX - dragRef.current.offsetX,
        ev.clientY - dragRef.current.offsetY,
        win.size.width,
      )
      wm.moveWindow(win.id, pos)
    }
    const onUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [isMax, win.id, win.position.x, win.position.y, win.size.width, win.size.height, wm, clampPosition])

  // --- RESIZE ---------------------------------------------------------------
  const startResize = useCallback((dir: ResizeDir) => (e: React.MouseEvent) => {
    if (isMax) return
    e.preventDefault()
    e.stopPropagation()
    wm.focusWindow(win.id)
    resizeRef.current = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      startW: win.size.width,
      startH: win.size.height,
      startPosX: win.position.x,
      startPosY: win.position.y,
    }
    const onMove = (ev: MouseEvent) => {
      const r = resizeRef.current
      if (!r) return
      const dx = ev.clientX - r.startX
      const dy = ev.clientY - r.startY
      let w = r.startW
      let h = r.startH
      let x = r.startPosX
      let y = r.startPosY
      if (r.dir.includes('e')) w = r.startW + dx
      if (r.dir.includes('s')) h = r.startH + dy
      if (r.dir.includes('w')) {
        w = r.startW - dx
        x = r.startPosX + dx
      }
      if (r.dir.includes('n')) {
        h = r.startH - dy
        y = r.startPosY + dy
      }
      const vw = globalThis.window.innerWidth
      const desktopH = Math.max(100, globalThis.window.innerHeight - chrome.top - chrome.bottom)
      const maxW = vw - 80
      const maxH = desktopH
      const minW = def?.minWidth ?? DEFAULT_MIN_WIDTH
      const minH = def?.minHeight ?? DEFAULT_MIN_HEIGHT
      w = Math.max(minW, Math.min(maxW, w))
      h = Math.max(minH, Math.min(maxH, h))
      if (r.dir.includes('w')) x = r.startPosX + (r.startW - w)
      if (r.dir.includes('n')) y = r.startPosY + (r.startH - h)
      wm.resizeWindow(win.id, { width: w, height: h })
      wm.moveWindow(win.id, { x, y })
    }
    const onUp = () => {
      resizeRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [isMax, win.id, win.position.x, win.position.y, win.size.width, win.size.height, wm, chrome.top, chrome.bottom])

  // Asegurar foco al click en cualquier parte del frame.
  const onFrameMouseDown = useCallback(() => {
    if (!isFocused) wm.focusWindow(win.id)
  }, [isFocused, win.id, wm])

  useEffect(() => {
    return () => {
      dragRef.current = null
      resizeRef.current = null
    }
  }, [])

  if (!def) return null
  const Component = def.component

  const style: CSSProperties = isMax
    ? {
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        zIndex: win.zIndex,
        display: isMin ? 'none' : 'flex',
      }
    : {
        left: win.position.x,
        top: win.position.y,
        width: win.size.width,
        height: win.size.height,
        zIndex: win.zIndex,
        display: isMin ? 'none' : 'flex',
      }

  return (
    <div
      ref={ref}
      data-window-id={win.id}
      data-state={win.state}
      className={cn(
        'absolute flex-col overflow-hidden rounded-lg border bg-background shadow-xl transition-shadow',
        isFocused ? 'ring-2 ring-primary/40 shadow-2xl' : 'shadow-md',
        'animate-fade-in',
      )}
      style={style}
      onMouseDown={onFrameMouseDown}
    >
      {/* Header */}
      <div
        onMouseDown={onHeaderMouseDown}
        onDoubleClick={() => wm.toggleMaximize(win.id)}
        className={cn(
          'flex h-9 shrink-0 select-none items-center gap-2 border-b px-2',
          isFocused ? 'bg-primary/10' : 'bg-muted',
          !isMax && 'cursor-move',
        )}
      >
        <WindowIcon name={win.iconName} className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-medium">{win.title}</span>
        <button
          type="button"
          aria-label="Minimizar"
          onClick={(e) => { e.stopPropagation(); wm.minimizeWindow(win.id) }}
          className="rounded p-1 hover:bg-accent"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={isMax ? 'Restaurar' : 'Maximizar'}
          onClick={(e) => { e.stopPropagation(); wm.toggleMaximize(win.id) }}
          className="rounded p-1 hover:bg-accent"
        >
          {isMax ? <Square className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          aria-label="Cerrar"
          onClick={(e) => { e.stopPropagation(); wm.closeWindow(win.id) }}
          className="rounded p-1 hover:bg-destructive hover:text-destructive-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto bg-secondary/30 p-4">
        <WindowSelfProvider
          value={{
            windowId: win.id,
            params: win.params,
            extras: wm.getExtras(win.id),
            close: () => wm.closeWindow(win.id),
          }}
        >
          <Suspense fallback={<PageSpinner />}>
            <Component />
          </Suspense>
        </WindowSelfProvider>
      </div>

      {/* Resize handles */}
      {!isMax && (
        <>
          <div className="absolute inset-x-0 top-0 h-1 cursor-n-resize" onMouseDown={startResize('n')} />
          <div className="absolute inset-x-0 bottom-0 h-1 cursor-s-resize" onMouseDown={startResize('s')} />
          <div className="absolute inset-y-0 left-0 w-1 cursor-w-resize" onMouseDown={startResize('w')} />
          <div className="absolute inset-y-0 right-0 w-1 cursor-e-resize" onMouseDown={startResize('e')} />
          <div className="absolute left-0 top-0 h-2 w-2 cursor-nw-resize" onMouseDown={startResize('nw')} />
          <div className="absolute right-0 top-0 h-2 w-2 cursor-ne-resize" onMouseDown={startResize('ne')} />
          <div className="absolute bottom-0 left-0 h-2 w-2 cursor-sw-resize" onMouseDown={startResize('sw')} />
          <div className="absolute bottom-0 right-0 h-2 w-2 cursor-se-resize" onMouseDown={startResize('se')} />
        </>
      )}
    </div>
  )
}
