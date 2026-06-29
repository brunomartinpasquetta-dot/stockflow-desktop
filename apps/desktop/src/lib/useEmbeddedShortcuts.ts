/**
 * useEmbeddedShortcuts (v0.1.17) — atajos de teclado de las VENTANAS NATIVAS.
 *
 * Corre dentro de cada `BrowserWindow` embedded (no tiene WindowManager).
 * - Cmd/Ctrl+W → cierra esta ventana nativa.
 * - Cmd/Ctrl+M → minimiza esta ventana nativa.
 * - F1..F12 → abre la ventana nativa mapeada en el registry (vía IPC).
 *
 * Respeta inputs activos (no dispara en input/textarea/select/contenteditable),
 * excepto los atajos de ventana (Cmd+W / Cmd+M).
 */
import { useEffect } from 'react'

import { useAuth } from '@/contexts/AuthContext'
import { api } from '@/lib/api'
import { hasPermissionFor } from '@/lib/permissions'
import { WINDOWS } from '@/windows/registry'

function isEditingTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}

function buildOpenPayload(pageKey: string): import('@/types/api').DesktopWindowOpenDTO {
  const def = WINDOWS[pageKey]
  return {
    pageKey,
    title: def?.title,
    ...(def?.defaultSize ? { width: def.defaultSize.width, height: def.defaultSize.height } : {}),
    ...(def?.minWidth ? { minWidth: def.minWidth } : {}),
    ...(def?.minHeight ? { minHeight: def.minHeight } : {}),
  }
}

export function useEmbeddedShortcuts(): void {
  const { currentUser } = useAuth()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase()

      // Cmd/Ctrl+W → cerrar esta ventana nativa.
      if ((e.metaKey || e.ctrlKey) && k === 'w') {
        e.preventDefault()
        void api.desktopWindow.closeSelf()
        return
      }
      // Cmd/Ctrl+M → minimizar esta ventana nativa.
      if ((e.metaKey || e.ctrlKey) && k === 'm') {
        e.preventDefault()
        void api.desktopWindow.minimizeSelf()
        return
      }

      if (isEditingTarget()) return

      // F1..F12 → abrir ventana nativa por fKey.
      const m = /^F(1[0-2]|[1-9])$/.exec(e.key)
      if (m) {
        const fnum = Number(m[1])
        const entry = Object.values(WINDOWS).find((w) => w.fKey === fnum)
        if (!entry) return
        if (entry.roles && (!currentUser || !entry.roles.includes(currentUser.role))) return
        if (entry.requires && !hasPermissionFor(currentUser?.permissions, entry.requires)) return
        e.preventDefault()
        void api.desktopWindow.open(buildOpenPayload(entry.pageKey))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentUser])
}
