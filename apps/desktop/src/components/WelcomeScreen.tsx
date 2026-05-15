/**
 * WelcomeScreen — pantalla principal del Desktop cuando no hay ventanas abiertas
 * (P-MDI-TOOLBAR). Look limpio: logo grande centrado + branding + versión.
 *
 * Los accesos rápidos viven en QuickAccessToolbar (chrome superior), por eso
 * acá no hay cards.
 */
import { BRANDING } from "@/assets/branding"
import { useEffect, useState } from 'react'

import { api } from '@/lib/api'

export function WelcomeScreen() {
  const [version, setVersion] = useState<string>('')
  const [machineId, setMachineId] = useState<string>('')

  useEffect(() => {
    api.system
      .getInfo()
      .then((info) => {
        setVersion(info.version)
        setMachineId(info.machineId)
      })
      .catch(() => undefined)
  }, [])

  const shortId = machineId ? `${machineId.slice(0, 8)}…` : ''

  return (
    <div className="flex h-full flex-col items-center justify-center bg-gradient-to-br from-background to-muted/30 px-8 py-12">
      <img
        src={BRANDING.logoTagline}
        alt="StockFlow"
        className="h-auto w-[400px]"
      />

      <div className="mt-10 flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
        {version && <span>v{version}</span>}
        {shortId && <span className="font-mono">{shortId}</span>}
      </div>
    </div>
  )
}
