/**
 * Estado del panel del Asistente virtual "Flowy". Dos estados: 'closed' y
 * 'open'. Lo monta `Layout` una sola vez; el panel se mantiene montado aunque
 * esté cerrado para no perder la conversación. Se abre desde el botón "Flowy"
 * de la barra superior (StatusBar).
 */
import { createContext, useContext, useState, type ReactNode } from 'react'

export type AssistantState = 'closed' | 'open'

interface AssistantCtx {
  state: AssistantState
  show: () => void
  hide: () => void
  /** Abre si está cerrado; cierra si está abierto. */
  toggle: () => void
}

const Ctx = createContext<AssistantCtx | null>(null)

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AssistantState>('closed')
  const value: AssistantCtx = {
    state,
    show: () => setState('open'),
    hide: () => setState('closed'),
    toggle: () => setState((s) => (s === 'open' ? 'closed' : 'open')),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAssistant(): AssistantCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAssistant fuera del provider')
  return c
}
