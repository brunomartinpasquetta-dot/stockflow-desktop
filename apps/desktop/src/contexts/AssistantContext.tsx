/**
 * Estado del panel del Asistente virtual. Tres estados, igual que el panel de
 * WhatsApp: 'closed' (nada), 'open' (visible) y 'min' (minimizado a un chip en la
 * barra superior). Lo monta `Layout` una sola vez; el panel se mantiene montado
 * (aunque esté cerrado/minimizado) para no perder la conversación.
 *
 * `openWith(pregunta)` abre el panel y le manda esa pregunta directo — lo usa el
 * buscador unificado para derivar una consulta a Sofía.
 */
import { createContext, useContext, useState, type ReactNode } from 'react'

export type AssistantState = 'closed' | 'open' | 'min'

interface AssistantCtx {
  state: AssistantState
  /** Pregunta pendiente para enviar al abrir (desde el buscador). */
  pending: string | null
  show: () => void
  hide: () => void
  minimize: () => void
  /** Abre el asistente y le envía la pregunta directamente. */
  openWith: (question: string) => void
  clearPending: () => void
  /** Abre si está cerrado/minimizado; cierra si está abierto. */
  toggle: () => void
}

const Ctx = createContext<AssistantCtx | null>(null)

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AssistantState>('closed')
  const [pending, setPending] = useState<string | null>(null)
  const value: AssistantCtx = {
    state,
    pending,
    show: () => setState('open'),
    hide: () => setState('closed'),
    minimize: () => setState('min'),
    openWith: (question: string) => {
      setPending(question)
      setState('open')
    },
    clearPending: () => setPending(null),
    toggle: () => setState((s) => (s === 'open' ? 'closed' : 'open')),
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAssistant(): AssistantCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAssistant fuera del provider')
  return c
}
