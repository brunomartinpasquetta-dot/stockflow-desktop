/**
 * GUÍA DE PRIMEROS PASOS — asistente de configuración inicial estilo "primera
 * vez" (pantalla difuminada detrás, pasos con formularios reales e imágenes).
 *
 * Cuándo aparece SOLO: primer inicio de sesión de una licencia de PRUEBA, con
 * usuario administrador, una única vez por máquina ({userData}/guia-inicial.json).
 * Siempre puede saltarse, retoma donde quedó, y se reabre a mano desde
 * Ayuda → "Guía de primeros pasos" (evento 'sf:abrir-guia').
 *
 * Los formularios escriben contra las MISMAS APIs que las pantallas reales
 * (company.upsert, hardware.printer.setConfig, users.update, demo.load): la
 * checklist "Primeros pasos" (E5) se tilda sola porque computa la realidad.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, FileSpreadsheet, Loader2, PackageOpen, Printer, Sparkles, Store } from 'lucide-react'
import { toast } from 'sonner'

import imgArticulos from '@/assets/guia/articulos.webp'
import imgBienvenida from '@/assets/guia/bienvenida.webp'
import imgImpresora from '@/assets/guia/impresora.webp'
import imgVentas from '@/assets/guia/ventas.webp'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/contexts/AuthContext'
import { useWindowManager } from '@/contexts/WindowManagerContext'
import { api, ApiError } from '@/lib/api'
import { useCompany } from '@/lib/hooks'
import { cn } from '@/lib/utils'

const PASOS = ['Bienvenida', 'Su comercio', 'Modo de precios', 'Impresora', 'Acceso', 'Artículos', 'Listo'] as const
const TOTAL = PASOS.length

export function AsistenteInicial({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const wm = useWindowManager()
  const { currentUser } = useAuth()
  const companyQuery = useCompany()
  const guiaQuery = useQuery({ queryKey: ['guia', 'estado'], queryFn: api.guia.estado, staleTime: Infinity })

  const [paso, setPaso] = useState(0)
  // Retomar donde quedó (solo al abrir).
  useEffect(() => {
    if (visible && guiaQuery.data && guiaQuery.data.paso > 0 && guiaQuery.data.paso < TOTAL - 1) {
      setPaso(guiaQuery.data.paso)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // ── Paso: Su comercio ──
  const company = companyQuery.data
  const [nombre, setNombre] = useState('')
  const [cuit, setCuit] = useState('')
  const [telefono, setTelefono] = useState('')
  const [direccion, setDireccion] = useState('')
  useEffect(() => {
    if (!company) return
    // El seed crea el stub "Mi Empresa": no prellenar con eso.
    setNombre(company.name === 'Mi Empresa' ? '' : company.name)
    setCuit(company.cuit ?? '')
    setTelefono(company.phone ?? '')
    setDireccion(company.address ?? '')
  }, [company])

  // ── Paso: Modo de precios ──
  const [modo, setModo] = useState<'gross' | 'net'>('gross')
  useEffect(() => { if (company) setModo(company.priceMode) }, [company])

  // ── Paso: Impresora ──
  const printersQuery = useQuery({
    queryKey: ['guia', 'printers'],
    queryFn: api.hardware.printer.listSystem,
    enabled: visible && paso === 3,
    retry: false,
  })
  const [impresora, setImpresora] = useState('')
  const [papel, setPapel] = useState<'58mm' | '80mm'>('58mm')
  const [probando, setProbando] = useState(false)

  // ── Paso: Acceso ──
  const [clave, setClave] = useState('')
  const [clave2, setClave2] = useState('')

  // ── Paso: Artículos ──
  const demoQuery = useQuery({
    queryKey: ['demo', 'status'],
    queryFn: api.demo.status,
    enabled: visible && paso === 5,
    retry: false,
  })
  const [cargandoDemo, setCargandoDemo] = useState(false)

  const guardando = useMutation({
    mutationFn: async (destino: number) => {
      // Cada avance persiste lo del paso actual contra la API real.
      if (paso === 1 && nombre.trim()) {
        await api.company.upsert({
          name: nombre.trim(),
          cuit: cuit.trim() || null,
          phone: telefono.trim() || null,
          address: direccion.trim() || null,
        })
        void qc.invalidateQueries({ queryKey: ['company'] })
      }
      if (paso === 2 && company && modo !== company.priceMode) {
        await api.company.upsert({ priceMode: modo })
        void qc.invalidateQueries({ queryKey: ['company'] })
      }
      if (paso === 3 && impresora) {
        await api.hardware.printer.setConfig({
          kind: 'system',
          interface: impresora,
          width: papel === '80mm' ? 80 : 58,
          characterSet: 'PC858_EURO',
          autoOpenDrawer: true,
          paperFormat: papel,
          silentPrint: true,
          autoPrintOnSale: true,
          a4PrinterName: null,
        })
        void qc.invalidateQueries({ queryKey: ['hardwarePrinterConfig'] })
      }
      if (paso === 4 && clave && currentUser) {
        if (clave.length < 4) throw new ApiError('VALIDATION', 'La contraseña debe tener al menos 4 caracteres')
        if (clave !== clave2) throw new ApiError('VALIDATION', 'Las contraseñas no coinciden')
        await api.users.update(currentUser.id, { password: clave })
      }
      await api.guia.progreso(destino)
      return destino
    },
    onSuccess: (destino) => setPaso(destino),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar este paso'),
  })

  const cerrar = (completada: boolean): void => {
    void api.guia.vista().then(() => {
      void qc.invalidateQueries({ queryKey: ['guia'] })
      void qc.invalidateQueries({ queryKey: ['onboarding'] })
    })
    if (completada) toast.success('Configuración inicial completada')
    onClose()
  }

  const probarImpresion = async (): Promise<void> => {
    setProbando(true)
    try {
      // Guardar primero lo elegido y recién probar (el test usa la config).
      if (impresora) {
        await api.hardware.printer.setConfig({
          kind: 'system', interface: impresora, width: papel === '80mm' ? 80 : 58,
          characterSet: 'PC858_EURO', autoOpenDrawer: false, paperFormat: papel,
          silentPrint: true, autoPrintOnSale: true, a4PrinterName: null,
        })
      }
      await api.hardware.printer.test()
      toast.success('Página de prueba enviada a la impresora')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo imprimir la prueba')
    } finally {
      setProbando(false)
    }
  }

  const cargarDemo = async (): Promise<void> => {
    setCargandoDemo(true)
    try {
      const r = await api.demo.load()
      toast.success(`Datos de ejemplo cargados: ${r.ventas} ventas, ${r.compras} compras`)
      void qc.invalidateQueries()
      void guardando.mutateAsync(TOTAL - 1)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudieron cargar los datos de ejemplo')
    } finally {
      setCargandoDemo(false)
    }
  }

  const imagen = useMemo(() => {
    switch (paso) {
      case 0: return imgBienvenida
      case 1: case 2: return imgVentas
      case 3: return imgImpresora
      case 5: return imgArticulos
      default: return null
    }
  }, [paso])

  if (!visible) return null

  const avanzar = (): void => { void guardando.mutate(Math.min(paso + 1, TOTAL - 1)) }
  const volver = (): void => setPaso((p) => Math.max(0, p - 1))

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-6 backdrop-blur-md">
      {/* Ancho 1254px con panel de captura al 48% (las capturas se ven grandes
          y legibles); alto justo para la captura sin aire de más — 780px le
          sobraba, dijo Bruno. El contenido largo scrollea adentro. */}
      <div className="flex h-[620px] max-h-[92vh] w-full max-w-[1254px] flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl">
        {/* Encabezado: progreso + saltar */}
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" />
            Guía de primeros pasos
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              Paso {paso + 1} de {TOTAL} — {PASOS[paso]}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => cerrar(false)}>
            Saltar la guía
          </Button>
        </div>
        <div className="flex h-1 w-full bg-muted">
          <div className="h-1 bg-primary transition-all" style={{ width: `${((paso + 1) / TOTAL) * 100}%` }} />
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Panel visual */}
          {imagen && (
            <div className="hidden w-[48%] items-center justify-center border-r bg-muted/40 p-5 md:flex">
              <img src={imagen} alt="" className="max-h-full w-full rounded-lg border object-contain shadow-md" />
            </div>
          )}
          {/* Contenido del paso */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-8">
            {paso === 0 && (
              <>
                <h2 className="text-2xl font-bold">Bienvenido a StockFlow</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  En unos pocos pasos el sistema queda listo para trabajar: los datos del comercio,
                  cómo se cargan los precios, la impresora de tickets y los primeros artículos.
                </p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Cada paso puede saltearse y retomarse después — esta guía queda siempre disponible
                  en el menú <b>Ayuda → Guía de primeros pasos</b>.
                </p>
              </>
            )}

            {paso === 1 && (
              <>
                <h2 className="flex items-center gap-2 text-xl font-bold"><Store className="h-5 w-5 text-primary" />Los datos de su comercio</h2>
                <p className="text-sm text-muted-foreground">Aparecen en tickets, presupuestos y comprobantes. Solo el nombre es obligatorio.</p>
                <div className="grid gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="g-nombre">Nombre del comercio</Label>
                    <Input id="g-nombre" autoFocus value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej.: Ferretería San Martín" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="g-cuit">CUIT (opcional)</Label>
                      <Input id="g-cuit" value={cuit} onChange={(e) => setCuit(e.target.value)} placeholder="30-12345678-9" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="g-tel">Teléfono (opcional)</Label>
                      <Input id="g-tel" value={telefono} onChange={(e) => setTelefono(e.target.value)} />
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="g-dir">Dirección (opcional)</Label>
                    <Input id="g-dir" value={direccion} onChange={(e) => setDireccion(e.target.value)} />
                  </div>
                </div>
              </>
            )}

            {paso === 2 && (
              <>
                <h2 className="text-xl font-bold">¿Cómo carga sus precios?</h2>
                <p className="text-sm text-muted-foreground">
                  Esta decisión conviene tomarla <b>antes de cargar artículos</b>. Puede cambiarse
                  después, pero los comprobantes ya emitidos conservan su cálculo original.
                </p>
                <div className="grid gap-3">
                  {([
                    { v: 'gross', t: 'Precios con IVA incluido', d: 'El precio cargado es el precio final de venta. Recomendado para venta al público (mostrador).' },
                    { v: 'net', t: 'Precios netos + IVA aparte', d: 'El precio cargado no incluye IVA; el sistema lo suma al vender. Habitual en venta entre empresas.' },
                  ] as const).map((op) => (
                    <button
                      key={op.v}
                      type="button"
                      onClick={() => setModo(op.v)}
                      className={cn(
                        'rounded-xl border-2 p-4 text-left transition-colors',
                        modo === op.v ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40',
                      )}
                    >
                      <div className="flex items-center gap-2 font-semibold">
                        {modo === op.v && <Check className="h-4 w-4 text-primary" />}
                        {op.t}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{op.d}</p>
                    </button>
                  ))}
                </div>
              </>
            )}

            {paso === 3 && (
              <>
                <h2 className="flex items-center gap-2 text-xl font-bold"><Printer className="h-5 w-5 text-primary" />Impresora de tickets</h2>
                <p className="text-sm text-muted-foreground">
                  Si la impresora ya está conectada, se elige acá y queda lista. Este paso puede
                  saltearse y configurarse después desde Configuración.
                </p>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="g-imp">Impresora</Label>
                  <select
                    id="g-imp"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={impresora}
                    onChange={(e) => setImpresora(e.target.value)}
                  >
                    <option value="">— Elegir más tarde —</option>
                    {(printersQuery.data ?? []).map((p) => (
                      <option key={p.name} value={p.name}>{p.name}{p.isDefault ? ' (predeterminada)' : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Ancho del papel</Label>
                  <div className="flex gap-2">
                    {(['58mm', '80mm'] as const).map((w) => (
                      <Button key={w} type="button" size="sm" variant={papel === w ? 'default' : 'outline'} onClick={() => setPapel(w)}>
                        {w}
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <Button variant="outline" size="sm" disabled={!impresora || probando} onClick={() => void probarImpresion()}>
                    {probando && <Loader2 className="h-4 w-4 animate-spin" />}
                    Probar impresión
                  </Button>
                </div>
              </>
            )}

            {paso === 4 && (
              <>
                <h2 className="text-xl font-bold">Su clave de acceso</h2>
                <p className="text-sm text-muted-foreground">
                  El sistema viene con el usuario <b className="font-mono">admin</b> y contraseña{' '}
                  <b className="font-mono">admin</b>. Se recomienda elegir una contraseña propia.
                  Más usuarios y permisos por empleado: Configuración → Usuarios.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="g-pass">Nueva contraseña</Label>
                    <Input id="g-pass" type="password" value={clave} onChange={(e) => setClave(e.target.value)} placeholder="Mínimo 4 caracteres" />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="g-pass2">Repetir contraseña</Label>
                    <Input id="g-pass2" type="password" value={clave2} onChange={(e) => setClave2(e.target.value)} />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Dejar vacío para mantener la actual por ahora.</p>
              </>
            )}

            {paso === 5 && (
              <>
                <h2 className="flex items-center gap-2 text-xl font-bold"><PackageOpen className="h-5 w-5 text-primary" />Sus artículos</h2>
                <p className="text-sm text-muted-foreground">¿Cómo prefiere empezar?</p>
                <div className="grid gap-3">
                  <button
                    type="button"
                    onClick={() => { cerrar(true); wm.openWindow({ pageKey: 'importar-stock' }) }}
                    className="rounded-xl border-2 border-border p-4 text-left transition-colors hover:border-primary/40"
                  >
                    <div className="flex items-center gap-2 font-semibold"><FileSpreadsheet className="h-4 w-4 text-primary" />Importar desde Excel</div>
                    <p className="mt-1 text-sm text-muted-foreground">Trae la lista de artículos existente (Excel o CSV). Se abre el importador con vista previa.</p>
                  </button>
                  <button
                    type="button"
                    disabled={demoQuery.data?.canLoad !== true || cargandoDemo}
                    onClick={() => void cargarDemo()}
                    className="rounded-xl border-2 border-border p-4 text-left transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {cargandoDemo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-primary" />}
                      Explorar con datos de ejemplo
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Carga una ferretería de práctica (artículos, ventas, cajas) para recorrer el sistema.
                      Se quita después desde Configuración y la base vuelve a cero.
                      {demoQuery.data && demoQuery.data.canLoad !== true && ' (Disponible solo con la base vacía.)'}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={avanzar}
                    className="rounded-xl border-2 border-border p-4 text-left transition-colors hover:border-primary/40"
                  >
                    <div className="font-semibold">Empezar de cero</div>
                    <p className="mt-1 text-sm text-muted-foreground">Cargar los artículos a mano, a medida que se necesiten.</p>
                  </button>
                </div>
              </>
            )}

            {paso === 6 && (
              <>
                <h2 className="text-2xl font-bold">¡Listo para trabajar!</h2>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  La configuración inicial quedó guardada. La tarjeta <b>Primeros pasos</b> de la
                  pantalla principal muestra lo que falta completar, y se tilda sola a medida que
                  se usa el sistema.
                </p>
                <div className="rounded-xl border bg-primary/5 p-4 text-sm leading-relaxed">
                  <b>Flowy</b>, el asistente del sistema, responde consultas en cualquier momento:
                  cómo hacer una venta, configurar la balanza, cobrar una cuenta corriente… Se abre
                  con el botón <b>Flowy</b> junto al buscador.
                </div>
              </>
            )}
          </div>
        </div>

        {/* Pie: navegación */}
        <div className="flex items-center justify-between border-t px-5 py-3">
          <Button variant="outline" size="sm" disabled={paso === 0 || guardando.isPending} onClick={volver}>
            <ArrowLeft className="h-4 w-4" /> Anterior
          </Button>
          {paso < TOTAL - 1 ? (
            <Button size="sm" disabled={guardando.isPending || (paso === 1 && !nombre.trim() && company?.name === 'Mi Empresa')} onClick={avanzar}>
              {guardando.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {paso === 5 ? 'Omitir este paso' : 'Continuar'} <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button size="sm" onClick={() => cerrar(true)}>
              <Check className="h-4 w-4" /> Empezar a usar StockFlow
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
