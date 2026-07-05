/**
 * Estado compartido del panel de WhatsApp (POC): lo controla el ícono del
 * toolbar y los botones del propio panel (minimizar/maximizar/cerrar).
 *
 *  - 'hidden'  → oculto (se abre con el ícono del toolbar)
 *  - 'min'     → minimizado a una barra en el costado derecho
 *  - 'normal'  → panel a la derecha (ancho por defecto)
 */
import { createContext, useContext, useState, type ReactNode } from 'react'

export type WaPanelState = 'hidden' | 'min' | 'normal'

interface WaPanelCtx {
  state: WaPanelState
  set: (s: WaPanelState) => void
  toggle: () => void
}

const Ctx = createContext<WaPanelCtx | null>(null)

export function WhatsAppPanelProvider({ children }: { children: ReactNode }) {
  const [state, set] = useState<WaPanelState>('hidden')
  const toggle = (): void => set((s) => (s === 'hidden' ? 'normal' : 'hidden'))
  return <Ctx.Provider value={{ state, set, toggle }}>{children}</Ctx.Provider>
}

export function useWhatsAppPanel(): WaPanelCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useWhatsAppPanel fuera del provider')
  return c
}
