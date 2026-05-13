/**
 * Badge en el header que muestra el estado de la conexión LAN.
 * Sólo se renderiza si el modo es 'client'.
 */
import type React from 'react'
import { Wifi, WifiOff } from 'lucide-react'

import { useLanContext } from '@/contexts/LanContext'

export function LanStatusIndicator(): React.JSX.Element | null {
  const { mode, config, online } = useLanContext()
  if (mode !== 'client') return null

  const target = config ? `${config.serverIp}:${config.serverPort}` : 'servidor'

  if (online) {
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <Wifi className="h-3 w-3" />
        <span>LAN: {target}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
      <WifiOff className="h-3 w-3" />
      <span>Sin conexión LAN — reintentando…</span>
    </div>
  )
}
