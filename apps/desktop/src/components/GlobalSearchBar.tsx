/**
 * Barra de búsqueda en el header. Visual-only: al recibir foco o click abre el
 * `CommandPalette` en modo 'all'. Compacto en pantallas chicas (sólo icono).
 */
import { Search } from 'lucide-react'

import { useCommandPalette } from '@/contexts/CommandPaletteContext'

const HOTKEY_LABEL = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'

export function GlobalSearchBar() {
  const palette = useCommandPalette()
  return (
    <button
      type="button"
      id="global-search-input"
      onClick={() => palette.openWith('all')}
      onFocus={() => palette.openWith('all')}
      className="inline-flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent lg:w-80"
      aria-label="Búsqueda global"
    >
      <Search className="h-3.5 w-3.5" />
      <span className="hidden flex-1 text-left lg:inline">Buscar…</span>
      <span className="hidden rounded border px-1 text-[10px] lg:inline">{HOTKEY_LABEL}</span>
    </button>
  )
}
