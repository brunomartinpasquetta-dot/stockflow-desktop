import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound, Loader2 } from 'lucide-react'

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

  const mutation = useMutation({
    mutationFn: (key: string): Promise<LicenseStateDTO> => api.license.activate(key),
    onSuccess: (state) => {
      if (state.status === 'active' || state.status === 'readOnly') {
        qc.invalidateQueries({ queryKey: ['license'] })
        toast.success('Licencia activada')
        navigate('/', { replace: true })
      } else {
        setErrorMsg(state.lastError ?? 'No se pudo activar la licencia.')
      }
    },
    onError: (err) => {
      setErrorMsg(err instanceof ApiError ? err.message : 'No se pudo activar la licencia.')
    },
  })

  function submit(): void {
    setErrorMsg(null)
    const key = licenseKey.trim()
    if (!key) {
      setErrorMsg('Ingresá tu clave de licencia.')
      return
    }
    mutation.mutate(key)
  }

  return (
    <div className="flex h-full items-center justify-center bg-secondary/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center gap-2 pt-6 text-center">
          <img
            src={`${import.meta.env.BASE_URL}branding/logo-full.svg`}
            alt="StockFlow"
            className="mx-auto h-auto w-[280px]"
          />
          <CardTitle className="text-lg">Activá tu licencia</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {status === 'revoked' && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Tu licencia fue revocada (suscripción cancelada). Contactá soporte para regularizar.
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            Ingresá la clave de licencia que recibiste al contratar tu plan. Quedará vinculada a esta PC.
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="license-key">Clave de licencia</Label>
            <Input
              id="license-key"
              autoFocus
              placeholder="SF-XXXX-XXXX-XXXX-XXXX"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
            <span className="text-xs text-muted-foreground">Formato: SF-XXXX-XXXX-XXXX-XXXX</span>
          </div>
          {errorMsg && <span className="text-sm text-destructive">{errorMsg}</span>}
          <Button className="mt-1 w-full" onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Activar
          </Button>
          <button
            type="button"
            className="text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => window.open(LANDING_URL, '_blank')}
          >
            ¿No tenés licencia? Comprar un plan
          </button>
        </CardContent>
      </Card>
    </div>
  )
}
