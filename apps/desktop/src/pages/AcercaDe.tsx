import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api, ApiError } from '@/lib/api'
import { useLicense } from '@/contexts/LicenseContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

export function AcercaDe() {
  const [version, setVersion] = useState<string>('—')
  const [checking, setChecking] = useState(false)
  const { state: license } = useLicense()

  useEffect(() => {
    api.system.getVersion().then((r) => setVersion(r.version)).catch(() => undefined)
  }, [])

  async function checkUpdates(): Promise<void> {
    setChecking(true)
    try {
      const r = await api.updater.checkNow()
      if (r.status === 'disabled' || r.status === 'disabled-in-dev') {
        toast.info('Auto-update sólo está disponible en builds de producción.')
      } else if (r.status === 'error') {
        toast.error(`No se pudo verificar (${r.version ?? 'error desconocido'})`)
      } else {
        toast.success(`Verificación iniciada${r.version ? `: v${r.version}` : ''}`)
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo verificar')
    } finally {
      setChecking(false)
    }
  }

  const plan = license?.plan ?? '—'
  const tenantName = license?.tenantName ?? '—'
  const licenseKey = license?.licenseKey ?? '—'
  const keyShort = licenseKey === '—' ? '—' : licenseKey.length > 19 ? `${licenseKey.slice(0, 16)}...` : licenseKey

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <h1 className="text-lg font-semibold">Acerca de StockFlow</h1>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Aplicación</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm">
          <div className="font-medium">Versión</div>
          <div className="font-mono">{version}</div>
          <div className="font-medium">Plan</div>
          <div className="font-mono">{plan}</div>
          <div className="font-medium">Empresa</div>
          <div className="font-mono">{tenantName}</div>
          <div className="font-medium">Licencia</div>
          <div className="font-mono">{keyShort}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Actualizaciones</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            StockFlow verifica nuevas versiones automáticamente al iniciar y cada 4 horas.
          </p>
          <Button variant="outline" onClick={() => void checkUpdates()} disabled={checking}>
            {checking && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Verificar actualización ahora
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Soporte</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <div>
            Email:{' '}
            <a className="text-primary hover:underline" href="mailto:soporte@stockflow.com.ar">
              soporte@stockflow.com.ar
            </a>
          </div>
          <div>
            Web:{' '}
            <a className="text-primary hover:underline" href="https://stockflow.com.ar" target="_blank" rel="noreferrer">
              stockflow.com.ar
            </a>
          </div>
          <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
            <a className="hover:underline" href="#">Términos</a>
            <a className="hover:underline" href="#">Privacidad</a>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
