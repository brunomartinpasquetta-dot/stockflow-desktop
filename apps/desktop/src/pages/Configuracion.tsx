import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { Loader2, Printer, Scale, HardDrive, ArrowRight, RefreshCw } from 'lucide-react'

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
  PrinterConfigDTO,
  PrinterKindDTO,
  PrinterWidthDTO,
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
function PrinterSection() {
  const qc = useQueryClient()
  const cfgQuery = useQuery({ queryKey: ['hardware', 'printer', 'config'], queryFn: () => api.hardware.printer.getConfig() })
  const usbQuery = useQuery({ queryKey: ['hardware', 'usb'], queryFn: () => api.hardware.listUsbDevices() })

  const [kind, setKind] = useState<PrinterKindDTO>('usb')
  const [iface, setIface] = useState('')
  const [width, setWidth] = useState<PrinterWidthDTO>(80)
  const [autoOpen, setAutoOpen] = useState(true)
  const [seeded, setSeeded] = useState<PrinterConfigDTO | null | undefined>(undefined)

  if (seeded !== cfgQuery.data) {
    setSeeded(cfgQuery.data)
    if (cfgQuery.data) {
      setKind(cfgQuery.data.kind)
      setIface(cfgQuery.data.interface)
      setWidth(cfgQuery.data.width)
      setAutoOpen(cfgQuery.data.autoOpenDrawer)
    }
  }

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
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo imprimir la prueba'),
  })

  const drawerMut = useMutation({
    mutationFn: () => api.hardware.cashDrawer.open(),
    onSuccess: () => toast.success('Cajón abierto'),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo abrir el cajón'),
  })

  function onSave(): void {
    if (!iface.trim()) {
      toast.error('Debés ingresar la interfaz de la impresora')
      return
    }
    saveMut.mutate({
      kind,
      interface: iface.trim(),
      width,
      characterSet: 'PC858_EURO',
      autoOpenDrawer: autoOpen,
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Printer className="h-4 w-4" /> Impresora térmica
        </CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label>Tipo de conexión</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as PrinterKindDTO)}
          >
            <option value="usb">USB</option>
            <option value="network">Red (Ethernet/WiFi)</option>
            <option value="file">Archivo (debug)</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label>Ancho de papel</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value) as PrinterWidthDTO)}
          >
            <option value={58}>58 mm (32 columnas)</option>
            <option value={80}>80 mm (48 columnas)</option>
          </select>
        </div>
        <div className="col-span-2 flex flex-col gap-1">
          <Label htmlFor="iface">
            Interfaz{' '}
            <span className="text-xs text-muted-foreground">
              {kind === 'usb' && '(formato "vendorId:productId" en hex, ej. 04b8:0202)'}
              {kind === 'network' && '(formato "ip:port", típicamente 9100)'}
              {kind === 'file' && '(ruta absoluta a archivo)'}
            </span>
          </Label>
          <Input id="iface" value={iface} onChange={(e) => setIface(e.target.value)} placeholder={kind === 'usb' ? '04b8:0202' : kind === 'network' ? '192.168.1.50:9100' : '/tmp/printer.bin'} />
        </div>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoOpen} onChange={(e) => setAutoOpen(e.target.checked)} />
          Abrir cajón monedero automáticamente al cobrar en efectivo
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

        <div className="col-span-2 mt-2">
          <div className="mb-1 flex items-center gap-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Dispositivos USB detectados</Label>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => qc.invalidateQueries({ queryKey: ['hardware', 'usb'] })}
            >
              <RefreshCw className="inline h-3 w-3" /> refrescar
            </button>
          </div>
          {usbQuery.data && usbQuery.data.length > 0 ? (
            <ul className="text-xs text-muted-foreground">
              {usbQuery.data.map((d, i) => (
                <li key={i} className="font-mono">
                  {d.vendorId.toString(16).padStart(4, '0')}:{d.productId.toString(16).padStart(4, '0')}
                  {d.manufacturer ? ` — ${d.manufacturer}` : ''}
                  {d.product ? ` ${d.product}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              No se detectaron dispositivos USB (puede requerir permisos / drivers).
            </p>
          )}
        </div>
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

export function Configuracion() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <h1 className="text-lg font-semibold">Configuración</h1>
      <Tabs defaultValue="hardware" className="flex flex-col gap-3">
        <TabsList>
          <TabsTrigger value="hardware">Hardware</TabsTrigger>
          <TabsTrigger value="backup">Backup</TabsTrigger>
          <TabsTrigger value="general">General</TabsTrigger>
        </TabsList>
        <TabsContent value="hardware" className="flex flex-col gap-3">
          <PrinterSection />
          <ScaleSection />
        </TabsContent>
        <TabsContent value="backup">
          <BackupSection />
        </TabsContent>
        <TabsContent value="general">
          <GeneralSection />
        </TabsContent>
      </Tabs>
    </div>
  )
}
