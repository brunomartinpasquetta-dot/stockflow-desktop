import { Outlet } from 'react-router-dom'

import { AuthProvider } from '@/contexts/AuthContext'

/** Raíz del árbol de rutas: provee el contexto de autenticación (necesita estar dentro del router). */
export function AuthShell() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}
