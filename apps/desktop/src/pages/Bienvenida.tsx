/**
 * Wizard de primera ejecución.
 * Pregunta el modo (PC única / Servidor / Cliente). Guarda LAN config y
 * reinicia la app para que tome la configuración.
 */
import { BRANDING } from "@/assets/branding"
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Step = 'pick' | 'server' | 'client'

function generatePin(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
}

export function Bienvenida() {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('pick')

  const [serverPin, setServerPin] = useState<string>(generatePin())
  const [clientIp, setClientIp] = useState('')
  const [clientPort, setClientPort] = useState(7777)
  const [clientToken, setClientToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanResults, setScanResults] = useState<{ ip: string; port: number; name?: string }[]>([])

  async function applySingle(): Promise<void> {
    setBusy(true)
    try {
      await api.lan.setMode({ mode: 'single' })
      toast.success('Modo PC única configurado')
      navigate('/activacion')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  async function applyServer(): Promise<void> {
    setBusy(true)
    try {
      await api.lan.setMode({ mode: 'server', port: 7777 })
      toast.success('Servidor configurado. Reiniciando…')
      setTimeout(() => void api.lan.applyAndRestart(), 600)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Error')
      setBusy(false)
    }
  }

  async function applyClient(): Promise<void> {
    if (!clientIp || !clientToken) {
      toast.error('Falta IP y/o PIN')
      return
    }
    setBusy(true)
    try {
      await api.lan.setMode({ mode: 'client', serverIp: clientIp, serverPort: clientPort, token: clientToken })
      toast.success('Cliente configurado. Reiniciando…')
      setTimeout(() => void api.lan.applyAndRestart(), 600)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Error')
      setBusy(false)
    }
  }

  async function scanNetwork(): Promise<void> {
    setScanning(true)
    setScanResults([])
    try {
      const r = await api.lan.scanNetwork()
      if (!r.supported) {
        toast.info('Búsqueda automática no disponible — ingresá la IP a mano')
      } else if (r.results.length === 0) {
        toast.info('No se encontró ningún servidor')
      } else {
        setScanResults(r.results)
      }
    } finally {
      setScanning(false)
    }
  }

  async function testConn(): Promise<void> {
    if (!clientIp) return
    setTestResult('Probando…')
    const r = await api.lan.testConnection(clientIp, clientPort, clientToken)
    setTestResult(r.ok ? `Conectado (${r.latencyMs ?? 0} ms)` : `Sin conexión: ${r.error ?? '—'}`)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-secondary/30 p-6">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img
            src={BRANDING.logoFull}
            alt="StockFlow"
            className="mx-auto mb-4 h-auto w-[280px]"
          />
          <h1 className="text-2xl font-semibold">Bienvenido</h1>
          <p className="text-sm text-muted-foreground">Configurá cómo vas a usar la aplicación.</p>
        </div>

        {step === 'pick' && (
          <div className="grid gap-3 md:grid-cols-3">
            <Card className="cursor-pointer hover:border-primary" onClick={() => void applySingle()}>
              <CardHeader>
                <CardTitle className="text-base">En esta PC únicamente</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Una sola caja, sin red. La opción más simple.
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:border-primary" onClick={() => setStep('server')}>
              <CardHeader>
                <CardTitle className="text-base">Como servidor (caja principal)</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Esta PC guarda los datos y atiende a otras cajas de la red.
              </CardContent>
            </Card>
            <Card className="cursor-pointer hover:border-primary" onClick={() => setStep('client')}>
              <CardHeader>
                <CardTitle className="text-base">Como caja adicional</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                Esta PC se conecta a un servidor StockFlow ya configurado.
              </CardContent>
            </Card>
          </div>
        )}

        {step === 'server' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Configurar servidor</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <p>
                  Tu PIN es: <span className="font-mono text-lg font-bold">{serverPin}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Anotalo: vas a necesitarlo para conectar las cajas adicionales.
                </p>
                <Button variant="link" size="sm" className="px-0" onClick={() => setServerPin(generatePin())}>
                  Generar otro
                </Button>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setStep('pick')} disabled={busy}>
                  Volver
                </Button>
                <Button onClick={() => void applyServer()} disabled={busy}>
                  {busy && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  Continuar y reiniciar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 'client' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Conectarse a un servidor</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void scanNetwork()} disabled={scanning}>
                  {scanning && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  Buscar en la red
                </Button>
                {scanResults.length > 0 && (
                  <select
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                    onChange={(e) => {
                      const r = scanResults[Number(e.target.value)]
                      if (r) {
                        setClientIp(r.ip)
                        setClientPort(r.port)
                      }
                    }}
                  >
                    <option value="">— elegir —</option>
                    {scanResults.map((r, i) => (
                      <option key={i} value={i}>
                        {r.ip}:{r.port}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Label>IP del servidor</Label>
                  <Input value={clientIp} onChange={(e) => setClientIp(e.target.value)} placeholder="192.168.1.100" />
                </div>
                <div>
                  <Label>Puerto</Label>
                  <Input type="number" value={clientPort} onChange={(e) => setClientPort(Number(e.target.value) || 7777)} />
                </div>
              </div>
              <div>
                <Label>PIN de seguridad</Label>
                <Input value={clientToken} onChange={(e) => setClientToken(e.target.value)} placeholder="6 dígitos" />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void testConn()}>
                  Probar conexión
                </Button>
                {testResult && <span className="text-xs">{testResult}</span>}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setStep('pick')} disabled={busy}>
                  Volver
                </Button>
                <Button onClick={() => void applyClient()} disabled={busy}>
                  {busy && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  Conectar y reiniciar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
