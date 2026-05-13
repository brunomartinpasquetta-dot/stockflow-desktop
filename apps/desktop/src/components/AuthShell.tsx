import { Navigate, Outlet, useLocation } from 'react-router-dom'

import { AuthProvider } from '@/contexts/AuthContext'
import { useLanContext } from '@/contexts/LanContext'

/** Raíz del árbol de rutas: provee el contexto de autenticación (necesita estar dentro del router). */
export function AuthShell() {
  const { config } = useLanContext()
  const location = useLocation()
  // Si todavía no se completó el wizard (no existe lan.json) → redirigir.
  if (config && config.configured === false && location.pathname !== '/bienvenida') {
    return <Navigate to="/bienvenida" replace />
  }
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}
