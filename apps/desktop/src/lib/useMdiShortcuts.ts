/**
 * useMdiShortcuts (v0.1.17) — atajos de teclado de la VENTANA PRINCIPAL.
 *
 * - F1..F10 → abrir/enfocar la ventana nativa mapeada en el registry.
 * - F12 / Ctrl+L → logout con confirm.
 *
 * El ciclado de foco entre ventanas lo maneja el SO (Alt+Tab / Cmd+`). Cmd+W y
 * Cmd+M aplican a las ventanas nativas embedded (ver `useEmbeddedShortcuts`).
 *
 * Respeta inputs activos (no dispara en input/textarea/select/contenteditable).
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

      // Ctrl+L → logout.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === 'l') {
        e.preventDefault()
        void logout()
        return
      }

      if (isEditingTarget() && e.key !== 'Escape') return

      // F12 → logout (preserva atajo original "Salir").
      if (e.key === 'F12') {
        e.preventDefault()
        const ok = window.confirm('¿Cerrar sesión?')
        if (ok) void logout()
        return
      }

      // F1..F10 → abrir ventana nativa por fKey.
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
