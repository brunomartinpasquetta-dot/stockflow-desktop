import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, QrCode, CheckCircle2, AlertCircle } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useLicense } from '@/contexts/LicenseContext'
import { usePrintQrCartel } from '@/lib/usePrint'
import { descargarImagen, nombreDeArchivo } from '@/lib/descargarArchivo'
import type { MpPosDeviceDTO } from '@/types/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Pantalla de configuración de MercadoPago QR Atendido.
 * Sólo admin.
 */
export function ConfiguracionMercadoPago() {
  const qc = useQueryClient()
  const configQuery = useQuery({ queryKey: ['mpQr', 'config'], queryFn: () => api.mpQr.getConfig() })
  const posQuery = useQuery({ queryKey: ['mpQr', 'pos'], queryFn: () => api.mpQr.listPosDevices() })
  const currentCashQuery = useQuery({ queryKey: ['cash', 'current'], queryFn: () => api.cash.getCurrent() })

  const [accessToken, setAccessToken] = useState('')
  /** Caja cuyo QR se está mirando, para verlo grande e imprimirlo. */
  const [verQr, setVerQr] = useState<{ pos: MpPosDeviceDTO; numero: number } | null>(null)
  /** Caja cuyo QR se va a rehacer, esperando la confirmación. */
  const [confirmarRehacer, setConfirmarRehacer] = useState<string | null>(null)

  const setupMutation = useMutation({
    mutationFn: () => api.mpQr.setupCompany({ accessToken }),
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
    onSuccess: (pos) => {
      toast.success('QR generado para la caja.')
      void qc.invalidateQueries({ queryKey: ['mpQr', 'pos'] })
      // Se abre solo: recién generado, lo que hace falta es imprimirlo.
      if (currentCashQuery.data) setVerQr({ pos, numero: currentCashQuery.data.number })
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Error'
      toast.error(`No se pudo generar QR: ${msg}`)
    },
  })

  const recrearMutation = useMutation({
    mutationFn: (cashRegisterId: string) => api.mpQr.recrearPosDevice(cashRegisterId),
    onSuccess: (pos) => {
      toast.success('QR rehecho. Imprima el cartel nuevo: el código cambió.')
      void qc.invalidateQueries({ queryKey: ['mpQr', 'pos'] })
      if (currentCashQuery.data) setVerQr({ pos, numero: currentCashQuery.data.number })
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Error'
      toast.error(`No se pudo rehacer el QR: ${msg}`)
    },
  })

  const config = configQuery.data
  const { state: licenseState } = useLicense()
  const licenseActive = licenseState?.status === 'active'
  const tenantId = licenseActive ? licenseState?.tenantId ?? 'OWNER' : null
  const webhookUrl = tenantId
    ? `https://stockflow.bpsgsistemas.com/api/mp/webhook/${tenantId}`
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
              <div>Cuenta de Mercado Pago: <code className="bg-muted px-1 rounded">{config.mpUserId}</code></div>
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
                    Active la licencia primero para obtener el endpoint del webhook.
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
                {/* El usuario ya no se pide: se saca del propio token. Pedirlo
                    a mano hacía que el comercio pusiera el número de la
                    aplicación en vez del de su cuenta y después no podía
                    cobrar (Denver, 8-oct-2026). */}
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
                  disabled={setupMutation.isPending || !accessToken}
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
                        {posQuery.data?.find((p) => p.cashRegisterId === currentCashQuery.data?.id) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setVerQr({
                                pos: posQuery.data.find(
                                  (p) => p.cashRegisterId === currentCashQuery.data?.id,
                                )!,
                                numero: currentCashQuery.data!.number,
                              })
                            }
                          >
                            Ver e imprimir QR
                          </Button>
                        ) : null}
                        {posQuery.data?.find((p) => p.cashRegisterId === currentCashQuery.data?.id) ? (
                          /* Para la caja que quedó enganchada a un QR que no
                             acepta el importe del sistema. Pide confirmación
                             porque el código cambia y hay que reimprimirlo. */
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-2"
                            disabled={recrearMutation.isPending}
                            onClick={() => setConfirmarRehacer(currentCashQuery.data!.id)}
                          >
                            {recrearMutation.isPending && (
                              <Loader2 className="mr-2 animate-spin" size={14} />
                            )}
                            Rehacer el QR de la caja
                          </Button>
                        ) : (
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
                        Abra una caja para poder asignarle un QR.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <QrDialog datos={verQr} onClose={() => setVerQr(null)} />

      <Dialog open={!!confirmarRehacer} onOpenChange={(a) => !a && setConfirmarRehacer(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rehacer el QR de la caja</DialogTitle>
            <DialogDescription>
              Se crea un QR nuevo que acepta el importe enviado desde el sistema. Úselo cuando al
              cobrar aparezca que el QR está en el modo en que el cliente escribe cuánto paga.
              <strong className="mt-2 block text-foreground">
                El código cambia: hay que imprimir el cartel de nuevo y reemplazar el que está en el
                mostrador.
              </strong>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmarRehacer(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => {
                const id = confirmarRehacer
                setConfirmarRehacer(null)
                if (id) recrearMutation.mutate(id)
              }}
            >
              Rehacer el QR
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Muestra el QR de la caja en grande y lo imprime en A4 para pegarlo en el
 * mostrador. El QR es siempre el mismo: se imprime una vez y queda.
 */
function QrDialog({
  datos,
  onClose,
}: {
  datos: { pos: MpPosDeviceDTO; numero: number } | null
  onClose: () => void
}) {
  const imprimir = usePrintQrCartel()
  const [descargando, setDescargando] = useState(false)
  const companyQuery = useQuery({
    queryKey: ['company'],
    queryFn: () => api.company.get(),
    enabled: !!datos,
  })

  const pos = datos?.pos
  const src = pos ? (pos.qrImageBase64 ? `data:image/png;base64,${pos.qrImageBase64}` : pos.qrUrl) : ''

  return (
    <Dialog open={!!datos} onOpenChange={(abierto) => !abierto && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>QR de cobro — Caja {datos?.numero}</DialogTitle>
          <DialogDescription>
            Este QR es siempre el mismo: imprímalo una vez y déjelo en el mostrador. El importe de
            cada venta se envía desde el sistema.
          </DialogDescription>
        </DialogHeader>

        {src ? (
          <div className="flex flex-col items-center gap-2">
            <img
              src={src}
              alt="Código QR de Mercado Pago"
              className="h-64 w-64 rounded border bg-white p-2"
            />
            <p className="text-xs text-muted-foreground">
              Si no se ve el código, revise la conexión a internet.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Mercado Pago no devolvió la imagen del QR. Vuelva a generarlo.
          </p>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={onClose}>
            Cerrar
          </Button>
          <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!pos || descargando}
            onClick={() => {
              if (!pos) return
              setDescargando(true)
              const comercio = nombreDeArchivo(companyQuery.data?.name ?? 'StockFlow')
              void descargarImagen(`QR-${comercio}-caja-${datos?.numero ?? 0}.png`, {
                base64: pos.qrImageBase64,
                url: pos.qrUrl,
              })
                .then(() => toast.success('QR descargado.'))
                .catch((err: unknown) =>
                  toast.error(
                    `No se pudo descargar: ${err instanceof Error ? err.message : 'error desconocido'}`,
                  ),
                )
                .finally(() => setDescargando(false))
            }}
          >
            {descargando && <Loader2 className="mr-2 animate-spin" size={14} />}
            Descargar QR
          </Button>
          <Button
            disabled={!pos}
            onClick={() =>
              void imprimir({
                company: companyQuery.data ?? null,
                numeroDeCaja: datos?.numero,
                qrImageBase64: pos?.qrImageBase64 ?? null,
                qrUrl: pos?.qrUrl ?? '',
              })
            }
          >
            Imprimir cartel
          </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
