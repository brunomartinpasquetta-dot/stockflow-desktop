/**
 * FACTURACIÓN ELECTRÓNICA (ARCA) — configuración.
 *
 * Dos bloques:
 *  1. Datos del emisor + certificado + entorno, con prueba de conexión.
 *  2. Puntos de venta: uno por terminal que factura.
 *
 * Solo administrador. Mientras `enabled` esté apagado, las ventas siguen
 * emitiendo remito X — nada cambia hasta que el usuario lo active a propósito.
 */
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, FileKey, Loader2, Plug, Plus, ShieldCheck, Trash2, XCircle } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { SaveFiscalConfigDTO } from '@/types/api'

const EMPTY: SaveFiscalConfigDTO = {
  environment: 'homologacion',
  cuit: '',
  businessName: '',
  address: '',
  vatCondition: 'RI',
  grossIncome: '',
  certPath: '',
  enabled: false,
}

export function FacturacionElectronica() {
  const { currentUser } = useAuth()
  const isAdmin = currentUser?.role === 'admin'
  if (!isAdmin) return <Navigate to="/" replace />
  return <FacturacionInner />
}

function FacturacionInner() {
  const qc = useQueryClient()
  const cfgQuery = useQuery({ queryKey: ['fiscal', 'config'], queryFn: () => api.fiscal.getConfig() })
  const pointsQuery = useQuery({ queryKey: ['fiscal', 'salePoints'], queryFn: () => api.fiscal.listSalePoints() })

  const [form, setForm] = useState<SaveFiscalConfigDTO>(EMPTY)
  const [seeded, setSeeded] = useState<unknown>(undefined)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; servers?: string } | null>(null)

  // Seeding del formulario cuando llega la config guardada.
  if (cfgQuery.data !== undefined && seeded !== cfgQuery.data) {
    setSeeded(cfgQuery.data)
    if (cfgQuery.data) {
      setForm({
        environment: cfgQuery.data.environment,
        cuit: cfgQuery.data.cuit,
        businessName: cfgQuery.data.businessName ?? '',
        address: cfgQuery.data.address ?? '',
        vatCondition: cfgQuery.data.vatCondition,
        grossIncome: cfgQuery.data.grossIncome ?? '',
        certPath: cfgQuery.data.certPath ?? '',
        enabled: cfgQuery.data.enabled,
      })
    }
  }

  const saveMut = useMutation({
    mutationFn: (next: SaveFiscalConfigDTO) => api.fiscal.saveConfig(next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fiscal'] })
      toast.success('Configuración fiscal guardada')
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  })

  const testMut = useMutation({
    mutationFn: () => api.fiscal.testConnection(),
    onSuccess: (r) => {
      setTestResult(r)
      if (r.ok) toast.success('Conexión con ARCA OK')
      else toast.error('No se pudo conectar con ARCA')
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Error al probar la conexión'
      setTestResult({ ok: false, message })
      toast.error(message)
    },
  })

  async function pickCert(): Promise<void> {
    const r = await api.system.pickFile([{ name: 'Certificado', extensions: ['crt', 'pem', 'cer'] }])
    if (r.filePath) setForm((f) => ({ ...f, certPath: r.filePath }))
  }

  const canEnable = Boolean(form.cuit && form.certPath)

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {/* ---------------------------- Emisor ---------------------------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Facturación electrónica (ARCA)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Configurá los datos fiscales para emitir facturas con CAE. Mientras esté desactivada, las
            ventas siguen saliendo como remito X (no fiscal).
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>Entorno</Label>
              <Select
                value={form.environment}
                onChange={(e) =>
                  setForm({ ...form, environment: e.target.value as 'homologacion' | 'produccion' })
                }
              >
                <option value="homologacion">Homologación (pruebas)</option>
                <option value="produccion">Producción (facturas reales)</option>
              </Select>
              <span className="text-xs text-muted-foreground">
                {form.environment === 'homologacion'
                  ? 'Las facturas son de prueba y no tienen validez fiscal.'
                  : '⚠ Las facturas emitidas son REALES y quedan registradas en ARCA.'}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <Label>Condición frente al IVA</Label>
              <Select
                value={form.vatCondition}
                onChange={(e) => setForm({ ...form, vatCondition: e.target.value as 'RI' | 'MT' })}
              >
                <option value="RI">Responsable Inscripto</option>
                <option value="MT">Monotributo</option>
              </Select>
              <span className="text-xs text-muted-foreground">
                {form.vatCondition === 'RI'
                  ? 'Emite Factura A a inscriptos y B al resto.'
                  : 'Emite siempre Factura C.'}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              <Label>CUIT del emisor</Label>
              <Input
                value={form.cuit}
                onChange={(e) => setForm({ ...form, cuit: e.target.value })}
                placeholder="30123456789"
                inputMode="numeric"
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label>Razón social</Label>
              <Input
                value={form.businessName ?? ''}
                onChange={(e) => setForm({ ...form, businessName: e.target.value })}
                placeholder="Como figura en ARCA"
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label>Domicilio comercial</Label>
              <Input
                value={form.address ?? ''}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label>Ingresos Brutos</Label>
              <Input
                value={form.grossIncome ?? ''}
                onChange={(e) => setForm({ ...form, grossIncome: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label>Certificado digital</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void pickCert()}>
                <FileKey className="h-4 w-4" />
                Elegir certificado…
              </Button>
              <span className="font-mono text-xs text-muted-foreground">
                {form.certPath || 'Ningún certificado seleccionado'}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              La clave privada tiene que estar en la misma carpeta y con el mismo nombre, pero
              terminada en <span className="font-mono">.key</span>.
            </span>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              disabled={!canEnable}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Activar facturación electrónica
            {!canEnable && (
              <span className="text-xs text-muted-foreground">
                (cargá el CUIT y el certificado primero)
              </span>
            )}
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => saveMut.mutate(form)} disabled={saveMut.isPending}>
              {saveMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar configuración
            </Button>
            <Button
              variant="outline"
              onClick={() => testMut.mutate()}
              disabled={testMut.isPending || !cfgQuery.data?.certPath}
              title={cfgQuery.data?.certPath ? undefined : 'Guardá el certificado antes de probar'}
            >
              {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
              Probar conexión con ARCA
            </Button>
          </div>

          {testResult && (
            <div
              className={`flex items-start gap-2 rounded-md border p-2 text-sm ${
                testResult.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10'
                  : 'border-destructive/40 bg-destructive/10'
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
              )}
              <div className="flex flex-col">
                <span>{testResult.message}</span>
                {testResult.servers && (
                  <span className="text-xs text-muted-foreground">{testResult.servers}</span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ------------------------ Puntos de venta ------------------------ */}
      <SalePointsCard
        points={pointsQuery.data ?? []}
        hasCert={Boolean(cfgQuery.data?.certPath)}
        onChanged={() => void qc.invalidateQueries({ queryKey: ['fiscal', 'salePoints'] })}
      />
    </div>
  )
}

function SalePointsCard({
  points,
  hasCert,
  onChanged,
}: {
  points: { id: string; number: number; description: string; terminalId: string | null; active: boolean }[]
  hasCert: boolean
  onChanged: () => void
}) {
  const [number, setNumber] = useState('')
  const [description, setDescription] = useState('')

  const saveMut = useMutation({
    mutationFn: () =>
      api.fiscal.saveSalePoint({ number: Number(number), description: description.trim() }),
    onSuccess: () => {
      toast.success('Punto de venta guardado')
      setNumber('')
      setDescription('')
      onChanged()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar'),
  })

  const delMut = useMutation({
    mutationFn: (id: string) => api.fiscal.deleteSalePoint(id),
    onSuccess: () => {
      toast.success('Punto de venta eliminado')
      onChanged()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo eliminar'),
  })

  const fetchMut = useMutation({
    mutationFn: (): Promise<{ number: number; type: string; blocked: boolean }[]> =>
      api.fiscal.fetchSalePointsFromArca(),
    onSuccess: (list) => {
      if (list.length === 0) {
        toast.info('ARCA no devolvió puntos de venta habilitados')
        return
      }
      toast.success(
        `ARCA tiene ${list.length} punto(s) habilitado(s): ${list.map((p) => p.number).join(', ')}`,
        { duration: 8000 },
      )
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo consultar ARCA'),
  })

  const canSave = Number(number) > 0 && description.trim().length > 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Puntos de venta</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Cada terminal que factura usa su propio punto de venta, con numeración independiente. Tienen
          que coincidir con los habilitados en ARCA.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Número</Label>
            <Input
              className="w-24"
              value={number}
              onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))}
              placeholder="1"
              inputMode="numeric"
            />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label className="text-xs">Descripción</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ej: Terminal 1 — Mostrador"
            />
          </div>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave || saveMut.isPending}>
            <Plus className="h-4 w-4" />
            Agregar
          </Button>
          <Button
            variant="outline"
            onClick={() => fetchMut.mutate()}
            disabled={!hasCert || fetchMut.isPending}
            title={hasCert ? undefined : 'Necesita el certificado configurado'}
          >
            {fetchMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Consultar en ARCA
          </Button>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Número</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                    Todavía no hay puntos de venta cargados.
                  </TableCell>
                </TableRow>
              ) : (
                points.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono">{String(p.number).padStart(5, '0')}</TableCell>
                    <TableCell>{p.description}</TableCell>
                    <TableCell>
                      {p.active ? (
                        <Badge variant="outline">Activo</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          Inactivo
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Eliminar punto de venta"
                        onClick={() => delMut.mutate(p.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
