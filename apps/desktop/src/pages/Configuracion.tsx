import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { Loader2, Printer, Scale, HardDrive, ArrowRight, RefreshCw, Network, RefreshCcw } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type {
  BackupConfigDTO,
  BackupEntryDTO,
  PaperFormatDTO,
  PrinterConfigDTO,
  ScaleConfigDTO,
  ScaleProtocolDTO,
} from '@/types/api'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/* ----------------------- IMPRESORA ----------------------- */
/**
 * Identifica el formato sugerido en base al nombre/producto detectado.
 *  - ESC/POS térmicas conocidas → 80mm.
 *  - Impresoras de oficina → A4.
 */
function suggestPaperFormat(label: string): PaperFormatDTO {
  const upper = label.toUpperCase()
  if (/HP|BROTHER|CANON|INKJET|LASERJET|OFFICEJET|DESKJET/.test(upper)) return 'A4'
  if (/TM-T|RPT|BEMATECH|ESC\/POS|EPSON TM|XPRINTER|3NSTAR/.test(upper)) return '80mm'
  return '80mm'
}

interface PrinterOption {
  value: string // 'usb:vid:pid' | 'network:ip:port' | 'file:/path'
  label: string
  paperHint: PaperFormatDTO
}

function buildPrinterOptions(
  usb: { vendorId: number; productId: number; manufacturer?: string; product?: string }[],
  currentNetwork: string | null,
): PrinterOption[] {
  const out: PrinterOption[] = []
  // USB detectadas
  for (const d of usb) {
    const vid = d.vendorId.toString(16).padStart(4, '0')
    const pid = d.productId.toString(16).padStart(4, '0')
    const label = `${d.manufacturer ?? ''} ${d.product ?? ''}`.trim() || `USB ${vid}:${pid}`
    out.push({
      value: `usb:${vid}:${pid}`,
      label: `${label} (USB)`,
      paperHint: suggestPaperFormat(label),
    })
  }
  // Red guardada
  if (currentNetwork) {
    out.push({
      value: `network:${currentNetwork}`,
      label: `${currentNetwork} (Red)`,
      paperHint: '80mm',
    })
  }
  // Archivo (testing) siempre disponible
  out.push({ value: 'file:/tmp/stockflow-printer.bin', label: 'Archivo (para testing)', paperHint: '80mm' })
  return out
}

function parsePrinterValue(value: string): { kind: 'usb' | 'network' | 'file'; iface: string } | null {
  if (value.startsWith('usb:')) return { kind: 'usb', iface: value.slice(4) }
  if (value.startsWith('network:')) return { kind: 'network', iface: value.slice(8) }
  if (value.startsWith('file:')) return { kind: 'file', iface: value.slice(5) }
  return null
}

function currentValueFromConfig(cfg: PrinterConfigDTO | null): string {
  if (!cfg) return ''
  if (cfg.kind === 'usb') return `usb:${cfg.interface}`
  if (cfg.kind === 'network') return `network:${cfg.interface}`
  return `file:${cfg.interface}`
}

function PrinterSection() {
  const qc = useQueryClient()
  const cfgQuery = useQuery({ queryKey: ['hardware', 'printer', 'config'], queryFn: () => api.hardware.printer.getConfig() })
  const usbQuery = useQuery({ queryKey: ['hardware', 'usb'], queryFn: () => api.hardware.listUsbDevices() })

  const [selected, setSelected] = useState<string>('')
  const [paperFormat, setPaperFormat] = useState<PaperFormatDTO>('80mm')
  const [networkIp, setNetworkIp] = useState<string>('')
  const [autoOpen, setAutoOpen] = useState(true)
  const [seeded, setSeeded] = useState<PrinterConfigDTO | null | undefined>(undefined)

  if (seeded !== cfgQuery.data) {
    setSeeded(cfgQuery.data)
    if (cfgQuery.data) {
      setSelected(currentValueFromConfig(cfgQuery.data))
      const fmt: PaperFormatDTO = cfgQuery.data.paperFormat ?? (cfgQuery.data.width === 58 ? '58mm' : '80mm')
      setPaperFormat(fmt)
      setAutoOpen(cfgQuery.data.autoOpenDrawer)
      if (cfgQuery.data.kind === 'network') setNetworkIp(cfgQuery.data.interface)
    }
  }

  const options = buildPrinterOptions(usbQuery.data ?? [], networkIp || null)

  const saveMut = useMutation({
    mutationFn: (cfg: PrinterConfigDTO) => api.hardware.printer.setConfig(cfg),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hardware', 'printer', 'config'] })
      toast.success('Configuración de impresora guardada')
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  })

  const testMut = useMutation({
    mutationFn: () => api.hardware.printer.test(),
    onSuccess: () => toast.success('Prueba enviada'),
    onError: (err) => {
      if (err instanceof Error && err.message.includes('A4_BROWSER_PRINT_REQUIRED')) {
        // Imprimir desde el browser un placeholder.
        window.print()
        toast.info('Impresión A4 enviada al diálogo del sistema')
        return
      }
      toast.error(err instanceof ApiError ? err.message : 'No se pudo imprimir la prueba')
    },
  })

  const drawerMut = useMutation({
    mutationFn: () => api.hardware.cashDrawer.open(),
    onSuccess: () => toast.success('Cajón abierto'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo abrir el cajón'),
  })

  function onSelect(value: string): void {
    setSelected(value)
    const opt = options.find((o) => o.value === value)
    if (opt) setPaperFormat(opt.paperHint)
  }

  function onSave(): void {
    const parsed = parsePrinterValue(selected)
    if (!parsed) {
      toast.error('Elegí una impresora')
      return
    }
    const width: 58 | 80 = paperFormat === '58mm' ? 58 : 80
    saveMut.mutate({
      kind: parsed.kind,
      interface: parsed.iface,
      width,
      characterSet: 'PC858_EURO',
      autoOpenDrawer: autoOpen,
      paperFormat,
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Printer className="h-4 w-4" /> Impresora
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3">
        <div className="col-span-2 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <Label>Impresora</Label>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => qc.invalidateQueries({ queryKey: ['hardware', 'usb'] })}
            >
              <RefreshCw className="mr-1 inline h-3 w-3" /> refrescar
            </button>
          </div>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={selected}
            onChange={(e) => onSelect(e.target.value)}
          >
            <option value="">— seleccioná una impresora —</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="col-span-2 flex flex-col gap-1">
          <Label>Impresora de Red (IP:puerto, opcional)</Label>
          <Input
            value={networkIp}
            onChange={(e) => setNetworkIp(e.target.value)}
            placeholder="192.168.1.50:9100"
          />
          <p className="text-xs text-muted-foreground">
            Si tu impresora está en la red, ingresá IP:puerto y aparecerá en la lista de arriba.
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label>Ancho de papel</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={paperFormat}
            onChange={(e) => setPaperFormat(e.target.value as PaperFormatDTO)}
          >
            <option value="58mm">58 mm (térmica)</option>
            <option value="80mm">80 mm (térmica)</option>
            <option value="A4">A4 (oficina)</option>
          </select>
        </div>

        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
          Abrir cajón monedero automáticamente al confirmar venta efectivo
        </label>

        <div className="col-span-2 flex flex-wrap gap-2">
          <Button onClick={onSave} disabled={saveMut.isPending}>
            {saveMut.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Guardar configuración
          </Button>
          <Button variant="outline" onClick={() => testMut.mutate()} disabled={testMut.isPending}>
            {testMut.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Probar impresión
          </Button>
          <Button variant="outline" onClick={() => drawerMut.mutate()} disabled={drawerMut.isPending}>
            Abrir cajón
          </Button>
        </div>

        {paperFormat === 'A4' && (
          <p className="col-span-2 text-xs text-muted-foreground">
            En modo A4, los tickets se imprimen vía diálogo del sistema (browser print).
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/* ----------------------- BALANZA ----------------------- */
function ScaleSection() {
  const qc = useQueryClient()
  const cfgQuery = useQuery({ queryKey: ['hardware', 'scale', 'config'], queryFn: () => api.hardware.scale.getConfig() })
  const portsQuery = useQuery({ queryKey: ['hardware', 'serial'], queryFn: () => api.hardware.listSerialPorts() })

  const [portPath, setPortPath] = useState('')
  const [baudRate, setBaudRate] = useState(9600)
  const [protocol, setProtocol] = useState<ScaleProtocolDTO>('generic')
  const [mode, setMode] = useState<'continuous' | 'request'>('request')

  const [liveReading, setLiveReading] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [seeded, setSeeded] = useState<ScaleConfigDTO | null | undefined>(undefined)

  if (seeded !== cfgQuery.data) {
    setSeeded(cfgQuery.data)
    if (cfgQuery.data) {
      setPortPath(cfgQuery.data.portPath)
      setBaudRate(cfgQuery.data.baudRate)
      setProtocol(cfgQuery.data.protocol)
      setMode(cfgQuery.data.mode)
    }
  }

  const saveMut = useMutation({
    mutationFn: (cfg: ScaleConfigDTO) => api.hardware.scale.setConfig(cfg),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hardware', 'scale', 'config'] })
      toast.success('Configuración de balanza guardada')
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  })

  async function testRead(): Promise<void> {
    setReading(true)
    setLiveReading(null)
    const started = Date.now()
    try {
      while (Date.now() - started < 5000) {
        try {
          const r = await api.hardware.scale.read()
          setLiveReading(`${r.value} kg ${r.stable ? '(estable)' : '(no estable)'}`)
        } catch {
          // ignorar lecturas fallidas en el polling de prueba
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    } finally {
      setReading(false)
    }
  }

  function onSave(): void {
    if (!portPath.trim()) {
      toast.error('Tenés que indicar el puerto serial')
      return
    }
    saveMut.mutate({ portPath: portPath.trim(), baudRate, protocol, mode })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="h-4 w-4" /> Balanza
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label>Puerto serial</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={portPath}
            onChange={(e) => setPortPath(e.target.value)}
          >
            <option value="">— seleccioná —</option>
            {(portsQuery.data ?? []).map((p) => (
              <option key={p.path} value={p.path}>
                {p.path}
                {p.manufacturer ? ` — ${p.manufacturer}` : ''}
              </option>
            ))}
          </select>
          <Input
            placeholder="o ingresá uno manualmente (ej: /dev/tty.usbserial-XYZ)"
            value={portPath}
            onChange={(e) => setPortPath(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Velocidad (baud rate)</Label>
          <Input type="number" value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value) || 9600)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label>Protocolo</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as ScaleProtocolDTO)}
          >
            <option value="kretz">Kretz</option>
            <option value="systel">Systel</option>
            <option value="magris">Magris</option>
            <option value="generic">Genérico</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>Modo</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'continuous' | 'request')}
          >
            <option value="request">A pedido (consultar al pesar)</option>
            <option value="continuous">Continuo (emite siempre)</option>
          </select>
        </div>

        <div className="col-span-2 flex flex-wrap items-center gap-2">
          <Button onClick={onSave} disabled={saveMut.isPending}>
            {saveMut.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Guardar configuración
          </Button>
          <Button variant="outline" onClick={() => void testRead()} disabled={reading}>
            {reading && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Probar lectura (5 s)
          </Button>
          {liveReading && <span className="text-sm font-mono">{liveReading}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

/* ----------------------- BACKUP ----------------------- */
function BackupSection() {
  const qc = useQueryClient()
  const cfgQuery = useQuery({ queryKey: ['backup', 'config'], queryFn: () => api.backup.getConfig() })
  const listQuery = useQuery({ queryKey: ['backup', 'list'], queryFn: () => api.backup.list() })

  const [cfg, setCfg] = useState<BackupConfigDTO>({ destination: '', autoOnCashClose: true, autoOnAppQuit: true })
  const [seeded, setSeeded] = useState<BackupConfigDTO | undefined>(undefined)

  if (cfgQuery.data && seeded !== cfgQuery.data) {
    setSeeded(cfgQuery.data)
    setCfg(cfgQuery.data)
  }

  const saveMut = useMutation({
    mutationFn: (next: BackupConfigDTO) => api.backup.setConfig(next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backup', 'config'] })
      toast.success('Configuración de backup guardada')
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  })

  const createMut = useMutation({
    mutationFn: () => api.backup.create(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['backup', 'list'] })
      toast.success('Backup creado')
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo crear el backup'),
  })

  const restoreMut = useMutation({
    mutationFn: (zipPath: string) => api.backup.restore(zipPath),
    onSuccess: () => {
      toast.success('Backup restaurado. Reiniciá la aplicación para usar la base restaurada.')
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo restaurar el backup'),
  })

  const [confirmRestore, setConfirmRestore] = useState<BackupEntryDTO | null>(null)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <HardDrive className="h-4 w-4" /> Backup automático
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.autoOnCashClose}
            onChange={(e) => setCfg((c) => ({ ...c, autoOnCashClose: e.target.checked }))}
          />
          Crear backup automático al cerrar caja
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.autoOnAppQuit}
            onChange={(e) => setCfg((c) => ({ ...c, autoOnAppQuit: e.target.checked }))}
          />
          Crear backup automático al cerrar la aplicación
        </label>
        <div className="flex flex-col gap-1">
          <Label>Carpeta de destino</Label>
          <Input value={cfg.destination} onChange={(e) => setCfg((c) => ({ ...c, destination: e.target.value }))} placeholder="/Users/.../Documents/StockFlow Backups" />
          <p className="text-xs text-muted-foreground">
            Recomendamos un directorio sincronizado con la nube (Dropbox, Google Drive, OneDrive).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => saveMut.mutate(cfg)} disabled={saveMut.isPending}>
            {saveMut.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Guardar
          </Button>
          <Button variant="outline" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
            {createMut.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Crear backup ahora
          </Button>
        </div>

        <div>
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">Backups existentes</Label>
          {listQuery.data && listQuery.data.length > 0 ? (
            <div className="mt-1 rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">Archivo</th>
                    <th className="px-2 py-1 text-right">Tamaño</th>
                    <th className="px-2 py-1 text-left">Fecha</th>
                    <th className="px-2 py-1" />
                  </tr>
                </thead>
                <tbody>
                  {listQuery.data.map((b) => (
                    <tr key={b.fullPath} className="border-t">
                      <td className="px-2 py-1 font-mono text-xs">{b.filename}</td>
                      <td className="px-2 py-1 text-right">{formatBytes(b.sizeBytes)}</td>
                      <td className="px-2 py-1">{formatDate(b.createdAt)}</td>
                      <td className="px-2 py-1 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setConfirmRestore(b)}>
                          Restaurar
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Todavía no hay backups.</p>
          )}
        </div>
      </CardContent>

      <AlertDialog open={!!confirmRestore} onOpenChange={(o) => !o && setConfirmRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar backup</AlertDialogTitle>
            <AlertDialogDescription>
              Vas a reemplazar la base de datos actual por el contenido de{' '}
              <span className="font-mono text-foreground">{confirmRestore?.filename}</span>. Después tenés que{' '}
              <strong>cerrar y volver a abrir StockFlow</strong> para que el cambio tenga efecto. ¿Continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRestore) restoreMut.mutate(confirmRestore.fullPath)
                setConfirmRestore(null)
              }}
            >
              Restaurar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/* ----------------------- LAN ----------------------- */
function LanSection() {
  const qc = useQueryClient()
  const cfgQuery = useQuery({ queryKey: ['lan', 'config'], queryFn: () => api.lan.getConfig() })
  const ipQuery = useQuery({ queryKey: ['lan', 'localIp'], queryFn: () => api.lan.getLocalIp() })

  const [mode, setMode] = useState<'single' | 'server' | 'client'>('single')
  const [serverPort, setServerPort] = useState<number>(7777)
  const [token, setToken] = useState<string>('')
  const [clientIp, setClientIp] = useState<string>('')
  const [clientPort, setClientPort] = useState<number>(7777)
  const [seeded, setSeeded] = useState<unknown>(undefined)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  if (cfgQuery.data && seeded !== cfgQuery.data) {
    setSeeded(cfgQuery.data)
    setMode(cfgQuery.data.mode)
    setServerPort(cfgQuery.data.port ?? 7777)
    setToken(cfgQuery.data.token ?? '')
    setClientIp(cfgQuery.data.serverIp ?? '')
    setClientPort(cfgQuery.data.serverPort ?? 7777)
  }

  const saveMut = useMutation({
    mutationFn: () => {
      if (mode === 'single') return api.lan.setMode({ mode: 'single' })
      if (mode === 'server') return api.lan.setMode({ mode: 'server', port: serverPort })
      return api.lan.setMode({ mode: 'client', serverIp: clientIp, serverPort: clientPort, token })
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['lan', 'config'] })
      toast.success('Configuración LAN guardada. Reiniciando…')
      setTimeout(() => void api.lan.applyAndRestart(), 600)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  })

  async function onScan(): Promise<void> {
    try {
      const r = await api.lan.scanNetwork()
      if (!r.supported) {
        toast.info('Búsqueda automática no disponible — ingresá la IP a mano')
        return
      }
      if (r.results.length === 0) {
        toast.info('No se encontró ningún servidor StockFlow en la red')
        return
      }
      const first = r.results[0]!
      setClientIp(first.ip)
      setClientPort(first.port)
      toast.success(`Encontrado: ${first.ip}:${first.port}`)
    } catch {
      toast.error('No se pudo buscar en la red')
    }
  }

  async function onTest(): Promise<void> {
    if (!clientIp) {
      toast.error('Ingresá la IP del servidor')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.lan.testConnection(clientIp, clientPort, token)
      if (r.ok) setTestResult(`Conectado (${r.latencyMs ?? 0} ms)`)
      else setTestResult(`Sin conexión: ${r.error ?? 'desconocido'}`)
    } finally {
      setTesting(false)
    }
  }

  function regenPin(): void {
    setToken(String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0'))
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="h-4 w-4" /> Modo multi-caja (LAN)
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label>Modo de operación</Label>
          <div className="grid grid-cols-3 gap-2">
            {(['single', 'server', 'client'] as const).map((m) => (
              <label
                key={m}
                className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs ${mode === m ? 'border-primary bg-primary/5' : ''}`}
              >
                <input type="radio" name="lan-mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {m === 'single' ? 'PC única' : m === 'server' ? 'Servidor' : 'Cliente'}
                  </span>
                  <span className="text-muted-foreground">
                    {m === 'single' && 'Esta PC trabaja sola, sin red.'}
                    {m === 'server' && 'Esta PC es la caja principal; otras se conectan a ella.'}
                    {m === 'client' && 'Esta PC se conecta a un servidor StockFlow en la red.'}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {mode === 'server' && (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label>Puerto</Label>
                <Input type="number" value={serverPort} onChange={(e) => setServerPort(Number(e.target.value) || 7777)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>PIN de seguridad</Label>
                <div className="flex gap-1">
                  <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="6 dígitos" />
                  <Button variant="outline" size="sm" onClick={regenPin} type="button">
                    Generar
                  </Button>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              IP local: <span className="font-mono">{ipQuery.data?.ip ?? '—'}</span>
              {ipQuery.data?.ip && (
                <>
                  {' '}
                  · URL para clientes: <span className="font-mono">http://{ipQuery.data.ip}:{serverPort}</span>
                </>
              )}
            </p>
          </div>
        )}

        {mode === 'client' && (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 flex flex-col gap-1">
                <Label>IP del servidor</Label>
                <div className="flex gap-1">
                  <Input value={clientIp} onChange={(e) => setClientIp(e.target.value)} placeholder="192.168.1.100" />
                  <Button variant="outline" size="sm" onClick={onScan} type="button">
                    Buscar
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Puerto</Label>
                <Input type="number" value={clientPort} onChange={(e) => setClientPort(Number(e.target.value) || 7777)} />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label>PIN de seguridad</Label>
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="6 dígitos" />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={onTest} type="button" disabled={testing}>
                {testing && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                Probar conexión
              </Button>
              {testResult && <span className="text-xs">{testResult}</span>}
            </div>
          </div>
        )}

        <div>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Guardar y reiniciar
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/* ----------------------- ACTUALIZACIONES ----------------------- */
function UpdatesSection() {
  const versionQuery = useQuery({ queryKey: ['system', 'version'], queryFn: () => api.system.getVersion() })
  const autoQuery = useQuery({ queryKey: ['updater', 'autoCheck'], queryFn: () => api.updater.getAutoCheck() })
  const [auto, setAuto] = useState<boolean>(true)
  const [seeded, setSeeded] = useState<unknown>(undefined)
  const [checkStatus, setCheckStatus] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState<string | null>(null)

  if (autoQuery.data && seeded !== autoQuery.data) {
    setSeeded(autoQuery.data)
    setAuto(autoQuery.data.autoCheck)
  }

  useEffect(() => {
    const off = api.updater.onDownloaded((info) => setDownloaded(info.version))
    return () => off()
  }, [])

  const setAutoMut = useMutation({
    mutationFn: (next: boolean) => api.updater.setAutoCheck(next),
    onSuccess: () => toast.success('Preferencia guardada'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  })

  async function checkNow(): Promise<void> {
    setCheckStatus('Verificando…')
    try {
      const r = await api.updater.checkNow()
      if (r.status === 'available' && r.version) setCheckStatus(`Versión ${r.version} disponible — descargando…`)
      else if (r.status === 'not-available') setCheckStatus('Estás al día.')
      else if (r.status === 'disabled') setCheckStatus('Auto-update deshabilitado en este entorno.')
      else setCheckStatus(`Estado: ${r.status}${r.version ? ' — ' + r.version : ''}`)
    } catch (err) {
      setCheckStatus(err instanceof ApiError ? err.message : 'Error al verificar')
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCcw className="h-4 w-4" /> Actualizaciones
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked)
              setAutoMut.mutate(e.target.checked)
            }}
          />
          Verificar actualizaciones automáticamente
        </label>
        <p className="text-xs text-muted-foreground">
          Versión actual: <span className="font-mono">{versionQuery.data?.version ?? '—'}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void checkNow()}>
            Buscar actualizaciones ahora
          </Button>
          {checkStatus && <span className="text-xs">{checkStatus}</span>}
        </div>
        {downloaded && (
          <div className="flex items-center gap-2 rounded-md border bg-emerald-500/10 p-2 text-sm">
            <span>Versión {downloaded} lista para instalar.</span>
            <Button size="sm" onClick={() => void api.updater.quitAndInstall()}>
              Reiniciar e instalar
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ----------------------- GENERAL ----------------------- */
function GeneralSection() {
  const links: { to: string; label: string }[] = [
    { to: '/empresa', label: 'Datos de la empresa' },
    { to: '/medios-de-pago', label: 'Medios de pago' },
    { to: '/usuarios', label: 'Usuarios' },
    { to: '/importar-stock', label: 'Importar stock desde Excel' },
  ]
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">General</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-accent"
          >
            <span>{l.label}</span>
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}

import { useWindowSelf } from '@/contexts/WindowManagerContext'

const VALID_TABS = ['hardware', 'backup', 'lan', 'updates', 'general'] as const
type TabValue = (typeof VALID_TABS)[number]

function readInitialTab(extras: unknown): TabValue | null {
  if (extras && typeof extras === 'object' && 'initialTab' in extras) {
    const v = (extras as { initialTab?: unknown }).initialTab
    if (typeof v === 'string' && (VALID_TABS as readonly string[]).includes(v)) return v as TabValue
  }
  return null
}

export function Configuracion() {
  const self = useWindowSelf()
  const initial = readInitialTab(self?.extras) ?? 'hardware'
  const [tab, setTab] = useState<TabValue>(initial)
  // Pattern "derivar estado de prop que cambia": guardamos el extras visto y si
  // cambia (re-open con otro initialTab) actualizamos el tab durante render.
  const [lastExtras, setLastExtras] = useState<unknown>(self?.extras)
  if (self?.extras !== lastExtras) {
    setLastExtras(self?.extras)
    const next = readInitialTab(self?.extras)
    if (next && next !== tab) setTab(next)
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <h1 className="text-lg font-semibold">Configuración</h1>
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="flex flex-col gap-3">
        <TabsList>
          <TabsTrigger value="hardware">Hardware</TabsTrigger>
          <TabsTrigger value="backup">Backup</TabsTrigger>
          <TabsTrigger value="lan">LAN</TabsTrigger>
          <TabsTrigger value="updates">Actualizaciones</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>
        <TabsContent value="hardware" className="flex flex-col gap-3">
          <PrinterSection />
          <ScaleSection />
        </TabsContent>
        <TabsContent value="backup">
          <BackupSection />
        </TabsContent>
        <TabsContent value="lan">
          <LanSection />
        </TabsContent>
        <TabsContent value="updates">
          <UpdatesSection />
        </TabsContent>
        <TabsContent value="general">
          <GeneralSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
