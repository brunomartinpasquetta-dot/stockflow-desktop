/**
 * Atajos globales de la barra unificada (asistente + búsqueda), P-BUSQUEDA:
 *  - Cmd/Ctrl+K        → foco en la barra (desplegable inline, no modal).
 *  - Cmd/Ctrl+Shift+P  → ídem (la barra ya muestra las acciones al tipear).
 *  - '/'               → foco en la barra (sólo si no se está editando).
 *
 * Los atajos de página (F1-F12 del Layout, Ctrl+N en Artículos, F2 en Ventas)
 * NO se rompen: este hook sólo escucha sus propias teclas.
 */
import { useEffect } from 'react'

function isEditingTarget(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toUpperCase()
  if (el.id === 'global-search-input') return false
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (el as HTMLElement).isContentEditable === true
}

function focusSearch(): void {
  const el = document.getElementById('global-search-input') as HTMLInputElement | null
  el?.focus()
  el?.select?.()
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const k = e.key.toLowerCase()
      // Cmd/Ctrl + K → foco en la barra unificada
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault()
        focusSearch()
        return
      }
      // Cmd/Ctrl + Shift + P → foco en la barra (muestra acciones al tipear)
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && k === 'p') {
        e.preventDefault()
        focusSearch()
        return
      }
      // '/' → foco en la barra (fuera de inputs)
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isEditingTarget()) return
        e.preventDefault()
        focusSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
