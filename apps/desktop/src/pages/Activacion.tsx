import { useEffect, useState } from 'react'
import { BRANDING } from '@/assets/branding'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Gift, KeyRound, Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useLicenseStatus } from '@/contexts/LicenseContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { LicenseStateDTO } from '@/types/api'

const LANDING_URL = (import.meta.env.VITE_LANDING_URL as string | undefined) ?? 'https://stockflow.com.ar'

export function Activacion() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const status = useLicenseStatus()
  const [licenseKey, setLicenseKey] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Prueba gratis
  const [tFullName, setTFullName] = useState('')
  const [tCompany, setTCompany] = useState('')
  const [tPhone, setTPhone] = useState('')
  const [trialError, setTrialError] = useState<string | null>(null)

  function onActivated(state: LicenseStateDTO, okMsg: string, setErr: (m: string) => void): void {
    console.info('[license] estado tras activación:', state.status)
    if (state.status === 'active' || state.status === 'readOnly') {
      // Sembrar el cache sincrónicamente con el estado autoritativo devuelto por
      // la activación. Si sólo invalidáramos, el LicenseGuard leería el estado
      // viejo ('unlicensed') durante el refetch y rebotaría a /activacion →
      // loop de activación. Sólo se ve en el build empaquetado (Windows): en dev
      // el getState() del main siempre devuelve 'active' y tapaba el bug.
      qc.setQueryData(['license'], state)
      void qc.invalidateQueries({ queryKey: ['license'] })
      toast.success(okMsg)
      navigate('/', { replace: true })
    } else {
      setErr(state.lastError ?? 'No se pudo activar la licencia.')
    }
  }

  const mutation = useMutation({
    mutationFn: (key: string): Promise<LicenseStateDTO> => api.license.activate(key),
    onSuccess: (state) => onActivated(state, 'Licencia activada', (m) => setErrorMsg(m)),
    onError: (err) => {
      setErrorMsg(err instanceof ApiError ? err.message : 'No se pudo activar la licencia.')
    },
  })

  const trialMutation = useMutation({
    mutationFn: (input: { fullName: string; companyName: string; phone: string }): Promise<LicenseStateDTO> =>
      api.license.activateTrial(input),
    onSuccess: (state) =>
      onActivated(state, '¡Prueba gratis activada! Tenés 30 días con todo el sistema.', (m) => setTrialError(m)),
    onError: (err) => {
      setTrialError(err instanceof ApiError ? err.message : 'No se pudo crear la prueba gratis.')
    },
  })

  // Red de seguridad: si la licencia ya está activa (p.ej. el guard rebotó acá
  // tras una activación, o se reabrió la app ya licenciada), salir de esta
  // pantalla. Evita quedar trabado en /activacion con licencia válida.
  useEffect(() => {
    if (status === 'active' || status === 'readOnly') {
      navigate('/', { replace: true })
    }
  }, [status, navigate])

  function submit(): void {
    setErrorMsg(null)
    const key = licenseKey.trim()
    if (!key) {
      setErrorMsg('Ingresá tu clave de licencia.')
      return
    }
    mutation.mutate(key)
  }

  function submitTrial(): void {
    setTrialError(null)
    const fullName = tFullName.trim()
    const companyName = tCompany.trim()
    const phone = tPhone.trim()
    if (!fullName || !companyName || !phone) {
      setTrialError('Completá tu nombre, el comercio y tu WhatsApp.')
      return
    }
    trialMutation.mutate({ fullName, companyName, phone })
  }

  const busy = mutation.isPending || trialMutation.isPending

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-secondary/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center gap-2 pt-6 text-center">
          <img
            src={BRANDING.logoFull}
            alt="StockFlow"
            className="mx-auto h-auto w-[280px]"
          />
          <CardTitle className="text-lg">Empezá a usar StockFlow</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {status === 'revoked' && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Tu licencia fue revocada (suscripción cancelada). Contactá soporte para regularizar.
            </div>
          )}

          {/* ── Prueba gratis 30 días ── */}
          <div className="flex flex-col gap-2 rounded-md border border-primary/25 bg-primary/5 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Gift className="h-4 w-4 text-primary" />
              Probá GRATIS por 30 días
            </div>
            <p className="text-xs text-muted-foreground">
              Sistema completo, sin tarjeta y sin costo. Se activa al instante en esta PC (una prueba por computadora).
            </p>
            <div className="flex flex-col gap-1">
              <Label htmlFor="trial-name">Tu nombre y apellido</Label>
              <Input id="trial-name" autoFocus placeholder="Ej: Juan Pérez" value={tFullName} onChange={(e) => setTFullName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="trial-company">Nombre del comercio</Label>
              <Input id="trial-company" placeholder="Ej: Ferretería El Tornillo" value={tCompany} onChange={(e) => setTCompany(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="trial-phone">Tu WhatsApp</Label>
              <Input
                id="trial-phone"
                placeholder="Ej: 342 5847340"
                value={tPhone}
                onChange={(e) => setTPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitTrial()
                }}
              />
            </div>
            {trialError && <span className="text-sm text-destructive">{trialError}</span>}
            <Button className="w-full" onClick={submitTrial} disabled={busy}>
              {trialMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />}
              Empezar mi prueba gratis
            </Button>
          </div>

          {/* ── Ya tengo licencia ── */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            ¿Ya tenés una clave de licencia?
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="license-key">Clave de licencia</Label>
            <Input
              id="license-key"
              placeholder="SF-XXXX-XXXX-XXXX-XXXX"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>
          {errorMsg && <span className="text-sm text-destructive">{errorMsg}</span>}
          <Button variant="outline" className="w-full" onClick={submit} disabled={busy}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Activar con mi clave
          </Button>
          <button
            type="button"
            className="text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => window.open(LANDING_URL, '_blank')}
          >
            Más información y precios
          </button>
        </CardContent>
      </Card>
    </div>
  )
}
