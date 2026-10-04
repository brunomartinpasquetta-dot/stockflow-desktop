/**
 * Badge en el header que muestra el estado de la conexión LAN.
 * Sólo se renderiza si el modo es 'client'.
 */
import type React from 'react'
import { Wifi, WifiOff } from 'lucide-react'

import { destinoDeConfig, useLanContext } from '@/contexts/LanContext'

export function LanStatusIndicator(): React.JSX.Element | null {
  const { mode, config, online } = useLanContext()
  if (mode !== 'client') return null

  const target = destinoDeConfig(config)
  // PC de sucursal (app instalada conectada por dirección web): no está en la
  // red del local, trabaja con la casa central por internet. Las terminales
  // de red local y las de navegador (que también informan serverUrl) siguen
  // viendo exactamente lo de siempre.
  const esWeb = Boolean((window as { __stockflowWeb?: boolean }).__stockflowWeb)
  const sucursal = Boolean(config?.serverUrl) && !esWeb

  if (online) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <Wifi className="h-3 w-3" />
        <span>{sucursal ? `Casa central: ${target}` : `LAN: ${target}`}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
      <WifiOff className="h-3 w-3" />
      <span>{sucursal ? 'Sin conexión con la casa central — reintentando…' : 'Sin conexión LAN — reintentando…'}</span>
    </div>
  )
}
