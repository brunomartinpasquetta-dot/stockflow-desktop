/**
 * useWindowNav (P-MDI-LAYOUT) — helper para abrir ventanas desde dentro de páginas.
 *
 * Reemplaza `navigate('/compras')` por `openInWindow('compras', { params, extras })`.
 */
import { useCallback } from 'react'

import { useWindowManager, type OpenWindowInput } from '@/contexts/WindowManagerContext'

export function useWindowNav() {
  const wm = useWindowManager()
  return useCallback(
    (pageKey: string, opts?: Pick<OpenWindowInput, 'params' | 'extras' | 'title'>) => {
      wm.openWindow({ pageKey, ...opts })
    },
    [wm],
  )
}
