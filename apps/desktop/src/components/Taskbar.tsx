/**
 * Taskbar — píldoras por ventana abierta (P-MDI-LAYOUT).
 *
 * Click: si está minimizada restaura+focus; si está activa+focused minimiza;
 * si está activa pero no focused, focusea.
 */
import { X } from 'lucide-react'

import { useWindowManager } from '@/contexts/WindowManagerContext'
import { WindowIcon } from '@/windows/WindowIcon'
import { cn } from '@/lib/utils'

export function Taskbar() {
  const wm = useWindowManager()
  if (wm.windows.length === 0) {
    return <div className="h-10 shrink-0 border-t bg-muted/40" />
  }
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-t bg-muted/40 px-2">
      {wm.windows
        .slice()
        .sort((a, b) => a.openedAt - b.openedAt)
        .map((w) => {
          const focused = wm.focusedId === w.id && w.state !== 'minimized'
          const minimized = w.state === 'minimized'
          return (
            <div
              key={w.id}
              className={cn(
                'inline-flex h-7 max-w-[200px] items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
                focused ? 'bg-background border shadow-sm' : 'hover:bg-background/60',
                minimized && 'opacity-60',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  if (minimized) {
                    wm.focusWindow(w.id)
                  } else if (focused) {
                    wm.minimizeWindow(w.id)
                  } else {
                    wm.focusWindow(w.id)
                  }
                }}
                className="inline-flex flex-1 items-center gap-1.5 truncate"
              >
                <WindowIcon name={w.iconName} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{w.title}</span>
              </button>
              <button
                type="button"
                aria-label="Cerrar"
                onClick={(e) => { e.stopPropagation(); wm.closeWindow(w.id) }}
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
