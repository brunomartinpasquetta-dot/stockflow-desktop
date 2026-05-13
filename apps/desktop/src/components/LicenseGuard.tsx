import { Navigate, Outlet } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import { useLicenseStatus } from '@/contexts/LicenseContext'

/**
 * Exige una licencia válida (activa o suspendida en sólo-lectura) para renderizar
 * las rutas hijas. Sin licencia (o revocada) redirige a /activacion.
 */
export function LicenseGuard() {
  const status = useLicenseStatus()

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (status === 'unlicensed' || status === 'revoked') {
    return <Navigate to="/activacion" replace />
  }
  return <Outlet />
}
