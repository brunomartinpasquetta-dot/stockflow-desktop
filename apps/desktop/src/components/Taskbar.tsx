/**
 * Taskbar — píldoras por ventana nativa abierta (v0.1.17).
 *
 * Lista las `BrowserWindow` nativas abiertas (vía `desktopWindow:list`). Click en
 * una píldora la enfoca/restaura. La barra de tareas del SO sigue siendo la vía
 * principal; esta barra es un atajo dentro de la ventana principal de StockFlow.
 */
import { X } from 'lucide-react'

import { useWindowManager } from '@/contexts/WindowManagerContext'
import { WindowIcon } from '@/windows/WindowIcon'
import { cn } from '@/lib/utils'

export function Taskbar() {
  const wm = useWindowManager()
  if (wm.windows.length === 0) {
    return <div data-chrome="taskbar" className="h-10 shrink-0 border-t bg-muted/40" />
  }
  return (
    <div data-chrome="taskbar" className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-t bg-muted/40 px-2">
      {wm.windows.map((w) => {
        const focused = w.focused && !w.minimized
        return (
          <div
            key={w.windowKey}
            className={cn(
              'inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
              focused ? 'bg-background border shadow-sm' : 'hover:bg-background/60',
              w.minimized && 'opacity-60',
            )}
          >
            <button
              type="button"
              onClick={() => wm.focusWindow(w.windowKey)}
              className="inline-flex flex-1 items-center gap-1.5 truncate"
            >
              <WindowIcon name={w.iconName} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{w.title}</span>
            </button>
            <button
              type="button"
              aria-label="Cerrar"
              onClick={(e) => {
                e.stopPropagation()
                wm.closeWindow(w.windowKey)
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
