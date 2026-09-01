/**
 * StatusBar — barra superior persistente (P-MDI-LAYOUT).
 *
 * Mezcla: GlobalSearchBar + estado caja + LAN + hora + usuario.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { User, Wallet } from 'lucide-react'

import { BRANDING } from '@/assets/branding'
import { api } from '@/lib/api'
import { GlobalSearchBar } from '@/components/GlobalSearchBar'
import { LanStatusIndicator } from '@/components/LanStatusIndicator'
import { useAuth } from '@/contexts/AuthContext'
import { useAssistant } from '@/contexts/AssistantContext'
import { useLicense } from '@/contexts/LicenseContext'
import { useDemoActive } from '@/lib/useDemoActive'

export function StatusBar() {
  const { currentUser } = useAuth()
  const assistant = useAssistant()
  const { state: license } = useLicense()
  const demoActive = useDemoActive()
  const [now, setNow] = useState(() => new Date())

  // Prueba gratis: días que le quedan (mínimo 0). null si no es trial.
  const trialDaysLeft =
    license?.trial && license.expiresAt
      ? Math.max(0, Math.ceil((license.expiresAt - Date.now()) / 86_400_000))
      : null

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const cashQuery = useQuery({
    queryKey: ['cash', 'current'],
    queryFn: api.cash.getCurrent,
    staleTime: 15_000,
  })

  const cashLabel = cashQuery.data
    ? `Caja: abierta`
    : 'Caja cerrada'

  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')

  return (
    <div data-chrome="statusbar" className="flex h-10 shrink-0 items-center gap-3 border-b bg-background px-3 text-sm">
      <div className="flex flex-1 items-center gap-2">
        <GlobalSearchBar />
        {/* Asistente virtual Flowy — botón propio, al lado del buscador */}
        <button
          type="button"
          onClick={assistant.show}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-primary/20"
          title="Abrir el asistente virtual Flowy"
        >
          <img src={BRANDING.iconSvg} alt="" className="h-5 w-5" draggable={false} />
          <span className="hidden md:inline">Flowy</span>
        </button>
        {/* MODO DEMO: distintivo permanente mientras los datos de ejemplo estén cargados */}
        {demoActive && (
          <span
            className="inline-flex shrink-0 items-center rounded-md border border-amber-500/60 bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800"
            title="Datos de ejemplo cargados. Todo lo que cargues acá se descarta al quitar la demo (Configuración → Datos de ejemplo)."
          >
            MODO DEMO
          </span>
        )}
      </div>
      {/* Prueba gratis: días restantes, siempre a la vista */}
      {trialDaysLeft !== null && (
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold ${
            trialDaysLeft <= 5 ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-primary/25 bg-primary/10 text-foreground'
          }`}
          title={
            trialDaysLeft > 0
              ? `Tu prueba gratis vence en ${trialDaysLeft} día(s). Para seguir después, escribinos por WhatsApp.`
              : 'Tu prueba gratis terminó. Escribinos por WhatsApp para activar tu licencia.'
          }
        >
          {trialDaysLeft > 0 ? `Prueba: ${trialDaysLeft} día(s)` : 'Prueba vencida'}
        </span>
      )}
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Wallet className="h-3.5 w-3.5" />
        <span>{cashLabel}</span>
      </div>
      <LanStatusIndicator />
      <div className="font-mono text-xs text-muted-foreground">{hh}:{mm}</div>
      {currentUser && (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <User className="h-3.5 w-3.5" />
          <span>{currentUser.fullName}</span>
        </div>
      )}
    </div>
  )
}
