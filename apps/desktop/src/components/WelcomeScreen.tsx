/**
 * WelcomeScreen — pantalla principal del Desktop cuando no hay ventanas abiertas
 * (P-MDI-TOOLBAR). Look limpio: logo grande centrado + branding + versión.
 *
 * Los accesos rápidos viven en QuickAccessToolbar (chrome superior), por eso
 * acá no hay cards.
 */
import { useEffect, useState } from 'react'
import { Boxes } from 'lucide-react'

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
      <div className="mb-6 flex h-48 w-48 items-center justify-center rounded-3xl bg-primary text-primary-foreground shadow-xl xl:h-56 xl:w-56">
        <Boxes className="h-24 w-24 xl:h-28 xl:w-28" strokeWidth={1.5} />
      </div>
      <h1 className="text-3xl font-bold tracking-tight text-foreground">StockFlow</h1>
      <p className="mt-1 text-base text-muted-foreground">Sistema de Gestión Comercial</p>

      <div className="mt-10 flex flex-col items-center gap-0.5 text-[11px] text-muted-foreground">
        {version && <span>v{version}</span>}
        {shortId && <span className="font-mono">{shortId}</span>}
      </div>
    </div>
  )
}
