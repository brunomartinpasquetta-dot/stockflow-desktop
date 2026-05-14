/**
 * Context para el CommandPalette global: estado abierto/cerrado y modo
 * ('all' = búsqueda completa de datos + acciones, 'actions' = sólo acciones).
 * Lo monta una sola vez `Layout`, y cualquier componente (atajos, GlobalSearchBar)
 * puede abrirlo con `usePalette().openWith('all')`.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

export type PaletteMode = 'all' | 'actions'

interface PaletteState {
  open: boolean
  mode: PaletteMode
  openWith: (mode?: PaletteMode) => void
  close: () => void
}

const Ctx = createContext<PaletteState | null>(null)

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<PaletteMode>('all')

  const openWith = useCallback((m: PaletteMode = 'all') => {
    setMode(m)
    setOpen(true)
  }, [])
  const close = useCallback(() => setOpen(false), [])

  const value = useMemo<PaletteState>(() => ({ open, mode, openWith, close }), [open, mode, openWith, close])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useCommandPalette(): PaletteState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCommandPalette requiere <CommandPaletteProvider>')
  return v
}
