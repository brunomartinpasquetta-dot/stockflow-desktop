import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, QrCode, CheckCircle2, AlertCircle } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useLicense } from '@/contexts/LicenseContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Pantalla de configuración de MercadoPago QR Atendido.
 * Sólo admin.
 */
export function ConfiguracionMercadoPago() {
  const qc = useQueryClient()
  const configQuery = useQuery({ queryKey: ['mpQr', 'config'], queryFn: () => api.mpQr.getConfig() })
  const posQuery = useQuery({ queryKey: ['mpQr', 'pos'], queryFn: () => api.mpQr.listPosDevices() })
  const currentCashQuery = useQuery({ queryKey: ['cash', 'current'], queryFn: () => api.cash.getCurrent() })

  const [mpUserId, setMpUserId] = useState('')
  const [accessToken, setAccessToken] = useState('')

  const setupMutation = useMutation({
    mutationFn: () => api.mpQr.setupCompany({ mpUserId, accessToken }),
    onSuccess: () => {
      toast.success('MercadoPago configurado correctamente.')
      setAccessToken('')
      void qc.invalidateQueries({ queryKey: ['mpQr'] })
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Error desconocido'
      toast.error(`No se pudo configurar: ${msg}`)
    },
  })

  const testMutation = useMutation({
    mutationFn: () => api.mpQr.testConnection(),
    onSuccess: (res) => {
      if (res.ok) toast.success(`Conexión OK — usuario MP ${res.mpUserId}`)
      else toast.error(`Falló: ${res.error ?? 'error desconocido'}`)
    },
  })

  const createPosMutation = useMutation({
    mutationFn: (cashRegisterId: string) => api.mpQr.createPosDevice(cashRegisterId),
    onSuccess: () => {
      toast.success('QR generado para la caja.')
      void qc.invalidateQueries({ queryKey: ['mpQr', 'pos'] })
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Error'
      toast.error(`No se pudo generar QR: ${msg}`)
    },
  })

  const config = configQuery.data
  const { state: licenseState } = useLicense()
  const licenseActive = licenseState?.status === 'active'
  const tenantId = licenseActive ? licenseState?.tenantId ?? 'OWNER' : null
  const webhookUrl = tenantId
    ? `https://api.stockflow.com.ar/api/mp/webhook/${tenantId}`
    : null

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-2xl font-bold">MercadoPago QR</h1>

      <Card>
        <CardHeader>
          <CardTitle>Estado</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {configQuery.isLoading ? (
            <Loader2 className="animate-spin" />
          ) : config?.configured ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle2 size={18} /> Configurado
              </div>
              <div>User ID MercadoPago: <code className="bg-muted px-1 rounded">{config.mpUserId}</code></div>
              <div>Store ID: <code className="bg-muted px-1 rounded">{config.storeId}</code></div>
              <div className="break-all">
                Webhook secret:{' '}
                <code className="bg-muted px-1 rounded">{config.webhookSecret}</code>{' '}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(config.webhookSecret ?? '')
                    toast.success('Copiado')
                  }}
                >
                  Copiar
                </Button>
              </div>
              <div className="break-all">
                URL del webhook (pegar en panel MP):{' '}
                {webhookUrl ? (
                  <>
                    <code className="bg-muted px-1 rounded">{webhookUrl}</code>{' '}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void navigator.clipboard.writeText(webhookUrl)
                        toast.success('Copiado')
                      }}
                    >
                      Copiar
                    </Button>
                  </>
                ) : (
                  <span className="text-amber-600">
                    Activá tu licencia primero para obtener el endpoint del webhook.
                  </span>
                )}
              </div>
              <Button onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
                {testMutation.isPending && <Loader2 className="mr-2 animate-spin" size={14} />}
                Probar conexión
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-amber-600 text-sm">
                <AlertCircle size={18} /> No configurado
              </div>
              <div className="grid gap-2 max-w-md">
                <div>
                  <Label htmlFor="mp-user-id">User ID MercadoPago</Label>
                  <Input id="mp-user-id" value={mpUserId} onChange={(e) => setMpUserId(e.target.value)} placeholder="123456789" />
                </div>
                <div>
                  <Label htmlFor="mp-token">Access Token</Label>
                  <Input
                    id="mp-token"
                    type="password"
                    value={accessToken}
                    onChange={(e) => setAccessToken(e.target.value)}
                    placeholder="APP_USR-..."
                  />
                </div>
                <Button
                  onClick={() => setupMutation.mutate()}
                  disabled={setupMutation.isPending || !mpUserId || !accessToken}
                >
                  {setupMutation.isPending && <Loader2 className="mr-2 animate-spin" size={14} />}
                  Conectar
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>QR por caja</CardTitle>
        </CardHeader>
        <CardContent>
          {!config?.configured ? (
            <p className="text-sm text-muted-foreground">Primero configurá MercadoPago.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Asigná un QR único a cada caja. El QR se imprime una vez y se reutiliza para todas las ventas.
              </p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2">Caja</th>
                    <th>QR</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {currentCashQuery.data ? (
                    <tr className="border-b">
                      <td className="py-2">Caja #{currentCashQuery.data.number}</td>
                      <td>
                        {posQuery.data?.find((p) => p.cashRegisterId === currentCashQuery.data?.id) ? (
                          <span className="inline-flex items-center gap-1 text-green-600"><QrCode size={14} /> Generado</span>
                        ) : (
                          <span className="text-muted-foreground">Sin generar</span>
                        )}
                      </td>
                      <td>
                        {!posQuery.data?.find((p) => p.cashRegisterId === currentCashQuery.data?.id) && (
                          <Button
                            size="sm"
                            onClick={() => createPosMutation.mutate(currentCashQuery.data!.id)}
                            disabled={createPosMutation.isPending}
                          >
                            Generar QR
                          </Button>
                        )}
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td colSpan={3} className="py-2 text-muted-foreground">
                        Abrí una caja para poder asignarle un QR.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
