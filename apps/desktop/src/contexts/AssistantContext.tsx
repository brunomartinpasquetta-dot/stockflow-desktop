/**
 * Estado del panel del Asistente virtual (abierto/cerrado). Lo monta `Layout`
 * una sola vez; el botón de la StatusBar lo abre y el propio panel lo cierra.
 */
import { createContext, useContext, useState, type ReactNode } from 'react'

interface AssistantCtx {
  open: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
}

const Ctx = createContext<AssistantCtx | null>(null)

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const toggle = (): void => setOpen((o) => !o)
  return <Ctx.Provider value={{ open, setOpen, toggle }}>{children}</Ctx.Provider>
}

export function useAssistant(): AssistantCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAssistant fuera del provider')
  return c
}
