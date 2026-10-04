/**
 * Wizard de primera ejecución.
 * Pregunta el modo (PC única / Servidor / Cliente). Guarda LAN config y
 * reinicia la app para que tome la configuración.
 *
 * PC DE SUCURSAL: una PC recién instalada en otro local se conecta a la casa
 * central por internet con la dirección web de la central y un código de
 * emparejamiento; después se ingresa con un usuario de la central. No
 * necesita licencia propia: la licencia Multisucursal la tiene la central. Se
 * llega desde acá, desde la Activación (lo primero que ve una PC sin licencia)
 * y desde el ingreso de una PC de sucursal («Conectar esta PC con un código
 * nuevo»: una PC revocada no puede ingresar y sin sesión no hay Configuración).
 */
import { BRANDING } from "@/assets/branding"
import { useEffect, useState, type ClipboardEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, Store } from 'lucide-react'

import { extraerDatosDeConexion } from '../../electron/lan/mensaje-sucursal'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Step = 'pick' | 'server' | 'client' | 'sucursal'

function generatePin(): string {
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
}

export function Bienvenida() {
  const navigate = useNavigate()
  const location = useLocation()
  // Desde Activación (o desde el ingreso) se entra directo al paso de
  // sucursal; "Volver" regresa a esa pantalla.
  const estado = (location.state ?? null) as { paso?: Step; desde?: string } | null
  const volverA = estado?.desde === 'activacion' ? '/activacion' : estado?.desde === 'login' ? '/login' : null
  const [step, setStep] = useState<Step>(estado?.paso === 'sucursal' ? 'sucursal' : 'pick')
  const [centralUrl, setCentralUrl] = useState('')
  const [centralCodigo, setCentralCodigo] = useState('')
  const [centralError, setCentralError] = useState<string | null>(null)
  // Nombre con que la casa central va a ver esta PC (lista de PC de sucursal,
  // cajas). Arranca con el nombre de Windows ("DESKTOP-7GH2K9P" no le dice
  // nada a nadie): se sugiere cambiarlo por "Caja 1 San Carlos".
  const [nombrePc, setNombrePc] = useState('')
  useEffect(() => {
    let vivo = true
    void api.system
      .getInfo()
      .then((i) => {
        // Sólo si todavía no escribieron nada.
        if (vivo && i?.hostname) setNombrePc((actual) => actual || (i.hostname ?? ''))
      })
      .catch(() => undefined)
    return () => {
      vivo = false
    }
  }, [])

  /** Si se pega el mensaje que copió la casa central, se completan los dos campos. */
  function pegarDatos(e: ClipboardEvent<HTMLInputElement>): void {
    const datos = extraerDatosDeConexion(e.clipboardData.getData('text'))
    if (datos.direccion && datos.codigo) {
      e.preventDefault()
      setCentralUrl(datos.direccion)
      setCentralCodigo(datos.codigo)
      setCentralError(null)
    }
  }

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

  async function conectarCentral(): Promise<void> {
    setCentralError(null)
    if (!centralUrl.trim()) {
      setCentralError('Ingrese la dirección web de la casa central (empieza con https://).')
      return
    }
    if (!centralCodigo.trim()) {
      setCentralError('Ingrese el código de emparejamiento que le pasó la casa central.')
      return
    }
    setBusy(true)
    try {
      // El main revisa la dirección, le pregunta a la central si acepta PC de
      // sucursal y canjea el código ANTES de guardar: si algo falla, la PC
      // queda como estaba y se muestra qué pasó.
      await api.lan.setMode({
        mode: 'client',
        serverUrl: centralUrl.trim(),
        codigoEmparejamiento: centralCodigo.trim(),
        ...(nombrePc.trim() ? { nombrePc: nombrePc.trim() } : {}),
      })
      toast.success('PC conectada a la casa central. Reiniciando…')
      setTimeout(() => void api.lan.applyAndRestart(), 900)
    } catch (err) {
      setCentralError(err instanceof ApiError ? err.message : 'No se pudo conectar con la casa central.')
      setBusy(false)
    }
  }

  function volverDeSucursal(): void {
    setCentralError(null)
    if (volverA) navigate(volverA, { replace: true })
    else setStep('pick')
  }

  async function scanNetwork(): Promise<void> {
    setScanning(true)
    setScanResults([])
    try {
      const r = await api.lan.scanNetwork()
      if (!r.supported) {
        toast.info('Búsqueda automática no disponible: ingrese la IP a mano')
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
          <p className="text-sm text-muted-foreground">Configure cómo se va a usar la aplicación.</p>
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
                Esta PC se conecta al servidor StockFlow de este mismo local.
              </CardContent>
            </Card>
          </div>
        )}

        {/* PC de otro local: opción aparte y discreta. Un comercio de una sola
            PC no la necesita y no cambia nada de lo de arriba. */}
        {step === 'pick' && (
          <button
            type="button"
            className="mt-3 flex w-full items-center gap-3 rounded-md border border-dashed bg-background/60 px-4 py-3 text-left hover:border-primary"
            onClick={() => setStep('sucursal')}
          >
            <Store className="h-5 w-5 shrink-0 text-muted-foreground" />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Conectar a la casa central (PC de sucursal)</span>
              <span className="text-xs text-muted-foreground">
                Esta PC está en otro local y trabaja con el sistema de la casa central, por internet.
              </span>
            </span>
          </button>
        )}

        {step === 'sucursal' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Conectar a la casa central</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Pida a la casa central tres datos: la <strong>dirección web</strong> (empieza con https://), el{' '}
                <strong>código de emparejamiento</strong> y el <strong>usuario y la contraseña</strong> con que va a
                trabajar en esta PC. El administrador encuentra los dos primeros en el StockFlow de la casa central, en
                Configuración → Red local → PC de sucursal. Esta PC no necesita licencia propia.
              </p>
              <div className="flex flex-col gap-1">
                <Label htmlFor="central-url">Dirección de la casa central</Label>
                <Input
                  id="central-url"
                  autoFocus
                  value={centralUrl}
                  onChange={(e) => setCentralUrl(e.target.value)}
                  onPaste={pegarDatos}
                  placeholder="Ej.: https://sucomercio.mistockflow.com"
                  spellCheck={false}
                  autoCapitalize="off"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="central-codigo">Código de emparejamiento</Label>
                <Input
                  id="central-codigo"
                  value={centralCodigo}
                  onChange={(e) => setCentralCodigo(e.target.value.toUpperCase())}
                  onPaste={pegarDatos}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) void conectarCentral()
                  }}
                  placeholder="Ej.: ABCDE-FGH23"
                  className="font-mono tracking-widest"
                  spellCheck={false}
                />
                <span className="text-xs text-muted-foreground">Sirve una sola vez y vence a los 15 minutos de generado.</span>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="central-nombre-pc">Nombre de esta PC (para reconocerla en la casa central)</Label>
                <Input
                  id="central-nombre-pc"
                  value={nombrePc}
                  onChange={(e) => setNombrePc(e.target.value)}
                  placeholder="Ej.: Caja 1 San Carlos"
                  maxLength={64}
                />
              </div>
              {centralError && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {centralError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={volverDeSucursal} disabled={busy}>
                  Volver
                </Button>
                <Button onClick={() => void conectarCentral()} disabled={busy}>
                  {busy && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  {busy ? 'Conectando con la casa central…' : 'Conectar'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 'server' && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Configurar servidor</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <p>
                  El PIN es: <span className="font-mono text-lg font-bold">{serverPin}</span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Anótelo: hará falta para conectar las cajas adicionales.
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
