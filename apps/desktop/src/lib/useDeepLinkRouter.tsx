/**
 * useDeepLinkRouter (P-MDI-LAYOUT)
 *
 * Intercepta cambios de URL: cuando la ruta coincide con una ventana del MDI,
 * abre/foco esa ventana pasando los searchParams como `params`, y redirige a `/`.
 * Mantiene viva la integración Cmd+K → deep link.
 */
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { useWindowManager } from '@/contexts/WindowManagerContext'
import { ROUTE_TO_PAGEKEY } from '@/windows/registry'

const FULLSCREEN_ROUTES = new Set(['/login', '/activacion', '/bienvenida'])

export function useDeepLinkRouter(): void {
  const location = useLocation()
  const navigate = useNavigate()
  const wm = useWindowManager()

  useEffect(() => {
    if (FULLSCREEN_ROUTES.has(location.pathname)) return
    if (location.pathname === '/' || location.pathname === '') return

    const pageKey = ROUTE_TO_PAGEKEY[location.pathname]
    if (!pageKey) {
      // Ruta huérfana — redirigir a home.
      navigate('/', { replace: true })
      return
    }

    const params: Record<string, string> = {}
    const sp = new URLSearchParams(location.search)
    for (const [k, v] of sp.entries()) params[k] = v

    wm.openWindow({ pageKey, params })
    navigate('/', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search])
}
