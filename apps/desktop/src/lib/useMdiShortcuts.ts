/**
 * useMdiShortcuts (P-MDI-LAYOUT) — atajos del WindowManager.
 *
 * - Cmd/Ctrl+W → cerrar focused.
 * - Cmd/Ctrl+M → minimizar focused.
 * - Cmd/Ctrl+Tab (Shift) → ciclar foco.
 * - F1..F10 → abrir/focus la window mapeada en el registry.
 * - F12 → logout con confirm.
 *
 * Respeta inputs activos (no dispara en input/textarea/contenteditable),
 * excepto Esc.
 */
import { useEffect } from 'react'

import { useAuth } from '@/contexts/AuthContext'
import { useWindowManager } from '@/contexts/WindowManagerContext'
import { hasPermission } from '@/lib/permissions'
import { WINDOWS } from '@/windows/registry'

function isEditingTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}

export function useMdiShortcuts(): void {
  const wm = useWindowManager()
  const { currentUser, logout } = useAuth()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase()

      // Ctrl+L → logout (mantenido de Layout original).
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'l') {
        e.preventDefault()
        void logout()
        return
      }

      if (isEditingTarget() && e.key !== 'Escape') return

      // Cmd/Ctrl+W → cerrar focused
      if ((e.metaKey || e.ctrlKey) && k === 'w') {
        e.preventDefault()
        if (wm.focusedId) wm.closeWindow(wm.focusedId)
        return
      }
      // Cmd/Ctrl+M → minimizar focused
      if ((e.metaKey || e.ctrlKey) && k === 'm') {
        e.preventDefault()
        if (wm.focusedId) wm.minimizeWindow(wm.focusedId)
        return
      }
      // Cmd/Ctrl+Tab → cycle focus
      if ((e.metaKey || e.ctrlKey) && e.key === 'Tab') {
        e.preventDefault()
        wm.cycleFocus(e.shiftKey ? -1 : 1)
        return
      }
      // Escape → si hay focused y no es minimized → minimizar
      if (e.key === 'Escape') {
        if (wm.focusedId) {
          const w = wm.windows.find((x) => x.id === wm.focusedId)
          if (w && w.state !== 'minimized') {
            // No preventDefault: dejamos que Radix maneje sus propios overlays primero.
          }
        }
        return
      }

      // F12 → logout (preserva atajo original "Salir")
      if (e.key === 'F12') {
        e.preventDefault()
        const ok = window.confirm('¿Cerrar sesión?')
        if (ok) void logout()
        return
      }

      // F1..F10 → abrir window por fKey
      const m = /^F([1-9]|10)$/.exec(e.key)
      if (m) {
        const fnum = Number(m[1])
        const entry = Object.values(WINDOWS).find((w) => w.fKey === fnum)
        if (!entry) return
        // Validar permisos antes de abrir.
        if (entry.roles && (!currentUser || !entry.roles.includes(currentUser.role))) return
        if (entry.requires && !hasPermission(currentUser?.role, entry.requires)) return
        e.preventDefault()
        wm.openWindow({ pageKey: entry.pageKey })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wm, currentUser, logout])
}
