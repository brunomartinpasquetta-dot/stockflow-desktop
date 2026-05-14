/**
 * Atajos globales del CommandPalette (P-BUSQUEDA):
 *  - Cmd/Ctrl+K        → abrir palette modo 'all'.
 *  - Cmd/Ctrl+Shift+P  → abrir palette modo 'actions'.
 *  - '/'               → focus en la barra de búsqueda (sólo si no se está editando).
 *  - Esc               → lo maneja cmdk dentro del Dialog, no se intercepta acá.
 *
 * Los atajos preexistentes de página (F1-F12 del Layout, Ctrl+N en Artículos,
 * F2 en Ventas) NO se rompen: este hook sólo escucha sus propias teclas.
 */
import { useEffect } from 'react'

import { useCommandPalette } from '@/contexts/CommandPaletteContext'

function isEditingTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}

export function useGlobalShortcuts(): void {
  const palette = useCommandPalette()
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase()
      // Cmd/Ctrl + K → palette modo 'all'
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault()
        palette.openWith('all')
        return
      }
      // Cmd/Ctrl + Shift + P → palette modo 'actions'
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && k === 'p') {
        e.preventDefault()
        palette.openWith('actions')
        return
      }
      // '/' → focus search bar (sólo fuera de inputs)
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isEditingTarget()) return
        e.preventDefault()
        document.getElementById('global-search-input')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [palette])
}
