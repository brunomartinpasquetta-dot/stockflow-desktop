/**
 * Compras → "Facturas escaneadas" (ver docs/PLAN_FACTURAS_TELEFONO.md).
 *
 * Dos vistas en la misma ventana:
 *  - Lista: las facturas que llegaron desde el teléfono y en qué están.
 *  - Revisión: la foto de la hoja a la izquierda y, a la derecha, el encabezado
 *    y los renglones leídos para corregir, vincular con artículos y pasar al
 *    formulario de Compras.
 *
 * De acá NUNCA sale una compra: "Cargar en Compras" abre el formulario
 * precargado y la compra la confirma el usuario como siempre. La cuenta de
 * plata del pasaje está en `@/lib/facturaACompra`.
 *
 * Compras («Cargar con el teléfono») abre esta ventana directo en la revisión
 * de una factura (`extras.facturaId`, `desdeCompras`, `pantalla`): al terminar,
 * la factura vuelve a ESA pantalla de Compras sin recargarla (`facturas.aCompras`).
 * Los `extras` llegan también con la ventana ya abierta, sin recargarla
 * (`extrasEnVivo` en el registry): si se estaba corrigiendo otra factura, se
 * guarda lo hecho y recién después se cambia.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Plus, Search, Smartphone, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'

import { api, ApiError } from '@/lib/api'
import { mensajeError } from '@/lib/mensajeError'
import { useAuth } from '@/contexts/AuthContext'
import { useWindowManager, useWindowSelf } from '@/contexts/WindowManagerContext'
import { hasPermissionFor } from '@/lib/permissions'
import { useArticles, useCompany, useFamilies, useSuppliers } from '@/lib/hooks'
import { articleMatches, buildSearchContext } from '@/lib/articleSearch'
import {
  ALICUOTAS_DE_ARTICULO,
  armarPasajeACompras,
  avisosDelRenglon,
  avisoYaCargada,
  baseDeLaEmpresa,
  claseDeComprobante,
  controlDeTotal,
  costoParaCompras,
  cuitConGuiones,
  cuitParaGuardar,
  datosArticuloNuevo,
  decidirAtajo,
  esCodigoDeBarras,
  estadoDelRenglon,
  numeroDeFactura,
  packEnDescripcion,
  prefillDeFactura,
  proveedoresParecidos,
  proximoCodigoInterno,
  tipoDeEncabezado,
  type ModoPrecios,
  type TipoComprobante,
} from '@/lib/facturaACompra'
import { CurrencyInput } from '@/components/ui/currency-input'
import { formatCurrency, formatDate, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { useWindowNav } from '@/lib/useWindowNav'
import { cn } from '@/lib/utils'
import { SupplierPicker } from '@/components/SupplierPicker'
import { VincularTelefonoDialog } from '@/components/VincularTelefonoDialog'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import type {
  ArticleDTO,
  FacturaEscaneadaArticuloDTO,
  FacturaEscaneadaDetalleDTO,
  FacturaEscaneadaEncabezadoDTO,
  FacturaEscaneadaEstadoDTO,
  FacturaEscaneadaRenglonDTO,
  FacturaEscaneadaRenglonDetalleDTO,
  FacturaEscaneadaResumenDTO,
  PriceMode,
  SupplierDTO,
} from '@/types/api'

const ESTADOS: Record<FacturaEscaneadaEstadoDTO, { etiqueta: string; variante: 'default' | 'primary' | 'success' | 'destructive' | 'outline' }> = {
  recibiendo: { etiqueta: 'Recibiendo', variante: 'default' },
  en_cola: { etiqueta: 'Pendiente', variante: 'default' },
  leyendo: { etiqueta: 'Leyendo', variante: 'primary' },
  lista: { etiqueta: 'Lista', variante: 'success' },
  error: { etiqueta: 'Error', variante: 'destructive' },
  cargada: { etiqueta: 'Cargada', variante: 'outline' },
  descartada: { etiqueta: 'Descartada', variante: 'outline' },
}

const TIPOS: { value: TipoComprobante; label: string }[] = [
  { value: 'A', label: 'Factura A' },
  { value: 'B', label: 'Factura B' },
  { value: 'C', label: 'Factura C' },
  { value: 'X', label: 'Comprobante X' },
]

const CLASES = { factura: '', notaCredito: 'NC', notaDebito: 'ND' } as const

function comprobante(f: { letra: string | null; tipoCmp?: number | null; ptoVta: number | null; nroCmp: number | null }): string {
  const numero = numeroDeFactura(f.ptoVta, f.nroCmp)
  if (!f.letra && !numero) return '—'
  return `${CLASES[claseDeComprobante(f.tipoCmp)]} ${f.letra ?? ''} ${numero}`.trim()
}

/** Qué aviso de «ya cargada» vio el usuario (para volver a avisar si aparece otro al guardar). */
function claveDeYaCargada(d: Pick<FacturaEscaneadaDetalleDTO, 'compraExistente' | 'yaCargada'>): string | null {
  if (d.compraExistente) return d.compraExistente.id
  return d.yaCargada ? `cargada:${d.yaCargada.fecha}` : null
}

/** Lo que manda Compras al abrir esta ventana para revisar una factura del teléfono. */
interface ExtrasDeCompras {
  facturaId?: string
  desdeCompras?: boolean
  /** Identificador de la pantalla de Compras que espera la factura (se le devuelve a ésa). */
  pantalla?: string
  lote?: number | string
}

/** Qué revisión está abierta y para quién. */
interface RevisionAbierta {
  id: string
  /** La revisión la pidió Compras: al terminar, la factura vuelve a esa pantalla. */
  desdeCompras: boolean
  pantalla: string | null
}

/* ───────────────────────────────── Lista ───────────────────────────────── */

export function FacturasEscaneadas() {
  const self = useWindowSelf()
  const extras = (self?.extras ?? null) as ExtrasDeCompras | null
  const pedida = typeof extras?.facturaId === 'string' && extras.facturaId ? extras.facturaId : null
  const pedidaPor = (): RevisionAbierta | null =>
    pedida
      ? { id: pedida, desdeCompras: extras?.desdeCompras === true, pantalla: typeof extras?.pantalla === 'string' && extras.pantalla ? extras.pantalla : null }
      : null
  const [abierta, setAbierta] = useState<RevisionAbierta | null>(pedidaPor)
  /**
   * Compras pidió OTRA factura mientras se revisaba una (los `extras` llegan
   * sin recargar la ventana): la revisión abierta guarda lo corregido y recién
   * después se cambia (ver `cambioPendiente` en Revision).
   */
  const [pendiente, setPendiente] = useState<{ a: RevisionAbierta; n: number } | null>(null)
  // Con la ventana ya abierta, Compras puede pedir otra factura (otro `lote`).
  const lote = extras?.lote ?? null
  useEffect(() => {
    const a = pedidaPor()
    if (!a) return
    if (abierta && abierta.id !== a.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendiente((p) => ({ a, n: (p?.n ?? 0) + 1 }))
      return
    }
    setAbierta(a)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pedida, lote])
  const volver = (): void => {
    if (pendiente) {
      setAbierta(pendiente.a)
      setPendiente(null)
      return
    }
    setAbierta(null)
  }
  return abierta ? (
    <Revision
      key={abierta.id}
      id={abierta.id}
      desdeCompras={abierta.desdeCompras}
      pantalla={abierta.pantalla}
      cambioPendiente={pendiente?.n ?? 0}
      onVolver={volver}
    />
  ) : (
    <Lista onAbrir={(id) => setAbierta({ id, desdeCompras: false, pantalla: null })} />
  )
}

function Lista({ onAbrir }: { onAbrir: (id: string) => void }) {
  const qc = useQueryClient()
  const openInWindow = useWindowNav()
  const [vincular, setVincular] = useState(false)
  const [aDescartar, setADescartar] = useState<FacturaEscaneadaResumenDTO | null>(null)
  const [cargando, setCargando] = useState<string | null>(null)
  const articlesQuery = useArticles()
  const companyQuery = useCompany()

  const estado = useQuery({ queryKey: ['facturas', 'estado'], queryFn: () => api.facturas.estado(), retry: false, refetchInterval: 8000 })
  const lista = useQuery({
    queryKey: ['facturas', 'lista'],
    queryFn: () => api.facturas.listar(),
    retry: false,
    // Mientras hay algo leyéndose, se refresca seguido para ver el avance.
    refetchInterval: (q) => {
      const filas = q.state.data as FacturaEscaneadaResumenDTO[] | undefined
      return filas?.some((f) => f.estado === 'en_cola' || f.estado === 'leyendo') ? 2500 : 8000
    },
  })
  const refrescar = (): void => void qc.invalidateQueries({ queryKey: ['facturas'] })

  const releer = useMutation({
    mutationFn: (id: string) => api.facturas.releer(id),
    onSuccess: refrescar,
    onError: (err) => toast.error(mensajeError(err)),
  })
  const descartar = useMutation({
    mutationFn: (id: string) => api.facturas.descartar(id),
    onSuccess: () => {
      refrescar()
      toast.success('Factura descartada')
    },
    onError: (err) => toast.error(mensajeError(err)),
  })

  const activo = estado.data?.activo === true
  const filas = lista.data ?? []

  /**
   * Atajo: la factura salió completa (proveedor, todo vinculado, nada en
   * revisar, el total coincide) y pasa al formulario de Compras sin abrir la
   * revisión. Se vuelve a controlar acá con los artículos de hoy; ante
   * cualquier duda se abre la revisión. La compra la confirma el usuario.
   */
  async function cargarDirecto(f: FacturaEscaneadaResumenDTO): Promise<void> {
    setCargando(f.id)
    try {
      const d = await api.facturas.obtener(f.id)
      const articulos = articlesQuery.data
      const modo = companyQuery.data?.priceMode
      if (!articulos || !modo) {
        toast.info('La factura necesita una revisión antes de cargarla.')
        return onAbrir(f.id)
      }
      const porId = new Map(articulos.filter((a) => a.active).map((a) => [a.id, a]))
      // La misma decisión que «Cargar con el teléfono» en Compras.
      const decision = decidirAtajo(d, modo, (articleId) => {
        const a = porId.get(articleId)
        return a ? { alicuota: Number(a.vatRate), costo: Number(a.costPrice) } : null
      })
      if (!decision.directo) {
        toast.info(`La factura necesita una revisión antes de cargarla. ${decision.motivo}`)
        return onAbrir(f.id)
      }
      openInWindow('compras', {
        extras: prefillDeFactura(
          f.id,
          {
            supplierId: d.supplierId,
            tipo: decision.tipo,
            ptoVta: d.header?.ptoVta ?? null,
            nroCmp: d.header?.nroCmp ?? null,
            fecha: d.header?.fecha ?? null,
            yaCargada: d.yaCargada,
          },
          decision.pasaje,
        ),
      })
    } catch (err) {
      toast.error(mensajeError(err))
    } finally {
      setCargando(null)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">Facturas escaneadas</h1>
          <p className="text-xs text-muted-foreground">
            Facturas de proveedores fotografiadas con el teléfono. Se revisan y se pasan al formulario de Compras.
          </p>
        </div>
        <Button onClick={() => setVincular(true)} disabled={!activo}>
          <Smartphone className="mr-2 h-4 w-4" />
          Vincular teléfono
        </Button>
      </div>

      {estado.data && !activo && (
        <div className="flex shrink-0 items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          <span>La función está desactivada. Se activa en Configuración → Facturas por teléfono.</span>
          <Button size="sm" variant="outline" onClick={() => openInWindow('configuracion', { extras: { initialTab: 'facturas' } })}>
            Abrir Configuración
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-muted">
            <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="w-28 px-3 py-2">Estado</th>
              <th className="px-3 py-2">Proveedor</th>
              <th className="w-40 px-3 py-2">Comprobante</th>
              <th className="w-16 px-3 py-2 text-right">Hojas</th>
              <th className="w-24 px-3 py-2 text-right">Renglones</th>
              <th className="w-24 px-3 py-2 text-right">A revisar</th>
              <th className="w-32 px-3 py-2 text-right">Suma</th>
              <th className="w-36 px-3 py-2">Recibida</th>
              <th className="w-72 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {lista.isLoading ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Cargando…
                </td>
              </tr>
            ) : lista.error ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-sm text-destructive">{mensajeError(lista.error)}</td>
              </tr>
            ) : filas.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                  No hay facturas escaneadas. Toque «Vincular teléfono» para enviar la primera.
                </td>
              </tr>
            ) : (
              filas.map((f) => {
                const est = ESTADOS[f.estado]
                // Leída = con renglones para mostrar y para abrir en la revisión.
                const leida = f.estado === 'lista' || f.estado === 'cargada'
                return (
                  <tr
                    key={f.id}
                    className={cn('border-t', leida && 'cursor-pointer hover:bg-muted/50')}
                    onClick={leida ? () => onAbrir(f.id) : undefined}
                  >
                    <td className="px-3 py-2 align-top">
                      <Badge variant={est.variante} title={f.error ?? undefined}>{est.etiqueta}</Badge>
                      {f.estado === 'leyendo' && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          Leyendo hoja {Math.min(f.hojasLeidas + 1, f.hojas)} de {f.hojas}
                          {f.lecturaLenta && ', puede demorar unos minutos'}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {f.proveedor ??
                        (f.proveedorLeido ? (
                          <span
                            className="text-amber-600"
                            title="Se leyó el emisor de la factura, pero no hay un proveedor cargado con ese CUIT. Se crea o se elige en la revisión."
                          >
                            Sin asociar: {f.proveedorLeido.razonSocial ?? `CUIT ${cuitConGuiones(f.proveedorLeido.cuit ?? '')}`}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Sin identificar</span>
                        ))}
                      {f.estado === 'error' && f.error && <div className="text-xs text-destructive">{f.error}</div>}
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-xs">
                      {comprobante(f)}
                      {f.repetida && (
                        <Badge variant="destructive" className="ml-1.5 font-sans" title="Hay otra factura escaneada con el mismo comprobante">
                          Repetida
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right align-top tabular-nums">{f.hojas}</td>
                    <td className="px-3 py-2 text-right align-top tabular-nums">{leida ? f.renglones : '—'}</td>
                    <td className={cn('px-3 py-2 text-right align-top tabular-nums', leida && f.porRevisar > 0 && 'font-semibold text-destructive')}>
                      {leida ? f.porRevisar : '—'}
                    </td>
                    <td className="px-3 py-2 text-right align-top tabular-nums">
                      {leida ? formatCurrency(f.sumaRenglones) : '—'}
                      {leida && f.totalCoincide === false && f.total != null && (
                        <div
                          className="text-[11px] font-semibold text-destructive"
                          title="La suma de los renglones no coincide con el total de la factura. Puede faltar un renglón."
                        >
                          Total {formatCurrency(f.total)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">{formatDateTime(f.creadaEl)}</td>
                    <td className="px-3 py-2 align-top" onClick={(ev) => ev.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        {f.estado === 'lista' && f.listaParaCargar && (
                          <Button
                            size="sm"
                            variant="success"
                            className="h-7"
                            disabled={cargando != null}
                            title="Todo reconocido: abre el formulario de Compras con la factura cargada. La compra se confirma allí."
                            onClick={() => void cargarDirecto(f)}
                          >
                            {cargando === f.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                            Cargar en Compras
                          </Button>
                        )}
                        {f.estado === 'lista' && (
                          <Button size="sm" variant={f.listaParaCargar ? 'outline' : 'default'} className="h-7" onClick={() => onAbrir(f.id)}>
                            Revisar
                          </Button>
                        )}
                        {f.estado === 'cargada' && <Button size="sm" variant="outline" className="h-7" onClick={() => onAbrir(f.id)}>Ver</Button>}
                        {f.estado === 'error' && (
                          <Button size="sm" variant="outline" className="h-7" disabled={releer.isPending} onClick={() => releer.mutate(f.id)}>
                            Volver a leer
                          </Button>
                        )}
                        {f.estado !== 'cargada' && (
                          <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => setADescartar(f)}>
                            Descartar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <VincularTelefonoDialog open={vincular} onClose={() => { setVincular(false); refrescar() }} />

      <AlertDialog open={aDescartar != null} onOpenChange={(o) => { if (!o) setADescartar(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Descartar la factura?</AlertDialogTitle>
            <AlertDialogDescription>Se borran las fotos y lo leído. Esta acción no se puede deshacer.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (aDescartar) descartar.mutate(aDescartar.id)
                setADescartar(null)
              }}
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ─────────────────────────────── Revisión ─────────────────────────────── */

interface Fila {
  key: number
  dto: FacturaEscaneadaRenglonDetalleDTO
  cantidad: string
  uxb: string
  precio: string
  importe: string
  estado: 'ok' | 'corregido' | 'revisar'
  motivo: string | null
  articulo: FacturaEscaneadaArticuloDTO | null
  /** El usuario quitó el vínculo: no vuelve solo por el código. */
  sinVinculo: boolean
  /** Flete, envío…: no es mercadería (cuenta para el total, no se carga como renglón). */
  esGasto: boolean
  /** El artículo lo propuso el sistema por parecido y el usuario todavía no lo aceptó. */
  sugerido: boolean
}

/** Número → texto del campo, con coma decimal. */
function aTexto(n: number | null): string {
  return n === null ? '' : String(n).replace('.', ',')
}
/** Texto del campo → número (acepta coma o punto); vacío o ilegible = null. */
function aNumero(s: string): number | null {
  const t = s.trim()
  if (t === '' || !/\d/.test(t)) return null
  const n = Number(parseCurrencyInput(t))
  return Number.isFinite(n) ? n : null
}

function aFila(r: FacturaEscaneadaRenglonDetalleDTO, key: number): Fila {
  return {
    key,
    dto: r,
    cantidad: aTexto(r.cantidad),
    uxb: aTexto(r.unidadesPorBulto),
    precio: aTexto(r.precioUnitario),
    importe: aTexto(r.importe),
    estado: r.estado,
    motivo: r.motivo,
    articulo: r.articulo,
    sinVinculo: r.articulo === null && r.sinVinculo === true,
    esGasto: r.articulo === null && r.esGasto === true,
    sugerido: r.articulo !== null && (r.sugerido === true || r.vinculadoPor === 'sugerido'),
  }
}

/**
 * Punto de venta / número de comprobante tal como se imprimen: sólo dígitos,
 * rellenados con ceros a `largo` (y nunca más de `maximo` dígitos; si se
 * escribieron de más, valen los últimos). Vacío queda vacío.
 */
function normalizarNumero(valor: string, largo: number, maximo: number): string {
  const digitos = valor.replace(/\D/g, '')
  if (!digitos) return ''
  return digitos.slice(-maximo).padStart(largo, '0')
}

function aRenglon(f: Fila): FacturaEscaneadaRenglonDTO {
  return {
    codigo: f.dto.codigo,
    descripcion: f.dto.descripcion,
    cantidad: aNumero(f.cantidad),
    unidadesPorBulto: aNumero(f.uxb),
    precioUnitario: aNumero(f.precio),
    importe: aNumero(f.importe),
    esDescuento: f.dto.esDescuento,
    estado: f.estado,
    motivo: f.motivo,
    original: f.dto.original,
    hoja: f.dto.hoja,
    articleId: f.articulo?.id ?? null,
    tasaIva: f.dto.tasaIva ?? null,
    ...(f.articulo === null && f.sinVinculo ? { sinVinculo: true } : {}),
    ...(f.dto.codigoDudoso ? { codigoDudoso: true } : {}),
    ...(f.dto.packResuelto ? { packResuelto: true } : {}),
    ...(f.articulo === null && f.esGasto && !f.dto.esDescuento ? { esGasto: true } : {}),
    ...(f.articulo !== null && f.sugerido ? { sugerido: true } : {}),
  }
}

const ESTADO_RENGLON: Record<Fila['estado'], { etiqueta: string; clase: string }> = {
  ok: { etiqueta: 'Correcto', clase: 'text-success' },
  corregido: { etiqueta: 'Corregido', clase: 'text-amber-600' },
  revisar: { etiqueta: 'Revisar', clase: 'text-destructive' },
}

/** De dónde salió el vínculo del renglón: una palabra para la columna y la explicación. */
function vinculoDe(f: Fila): { etiqueta: string; detalle: string; clase: string } {
  if (!f.articulo) return { etiqueta: '—', detalle: 'Sin artículo vinculado', clase: 'text-muted-foreground' }
  if (f.sugerido) {
    return {
      etiqueta: 'Sugerido',
      detalle: 'El sistema lo eligió por parecido con la descripción. Contrólelo: al aceptarlo, se recuerda para este proveedor.',
      clase: 'text-amber-600',
    }
  }
  const por = f.articulo.id === f.dto.articulo?.id ? f.dto.vinculadoPor : 'guardado'
  if (por === 'proveedor') return { etiqueta: 'Código', detalle: 'Por el código del proveedor (recordado de una factura anterior)', clase: 'text-success' }
  if (por === 'codigo') return { etiqueta: 'Código', detalle: 'Por el código de barras', clase: 'text-success' }
  if (por === 'descripcion') {
    return { etiqueta: 'Aprendido', detalle: 'Por la descripción (recordada de una factura anterior de este proveedor)', clase: 'text-success' }
  }
  return { etiqueta: 'Elegido', detalle: 'Elegido en esta revisión', clase: 'text-foreground' }
}

const ZOOMS = [1, 1.5, 2, 3]

function Revision({
  id,
  desdeCompras = false,
  pantalla = null,
  cambioPendiente = 0,
  onVolver,
}: {
  id: string
  desdeCompras?: boolean
  /** Pantalla de Compras que espera esta factura (`facturas.aCompras`). */
  pantalla?: string | null
  /** Sube cada vez que Compras pide otra factura con esta revisión abierta: se guarda y se sale. */
  cambioPendiente?: number
  onVolver: () => void
}) {
  const qc = useQueryClient()
  const openInWindow = useWindowNav()
  const ventanas = useWindowManager().windows
  const articlesQuery = useArticles()
  const suppliersQuery = useSuppliers()
  const familiesQuery = useFamilies()
  const companyQuery = useCompany()
  const priceMode: PriceMode = companyQuery.data?.priceMode ?? 'gross'
  const suppliers = useMemo(() => suppliersQuery.data ?? [], [suppliersQuery.data])
  const activos = useMemo(() => (articlesQuery.data ?? []).filter((a) => a.active), [articlesQuery.data])
  const porId = useMemo(() => new Map(activos.map((a) => [a.id, a])), [activos])
  const searchCtx = useMemo(() => buildSearchContext(familiesQuery.data, suppliersQuery.data), [familiesQuery.data, suppliersQuery.data])

  const detalle = useQuery({
    queryKey: ['facturas', 'detalle', id],
    queryFn: () => api.facturas.obtener(id),
    retry: false,
    // Lo que está en pantalla es lo que el usuario está corrigiendo: no se
    // vuelve a pedir solo (pisaría los cambios sin guardar).
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

  // Copia editable. Se arma al abrir y después de guardar. Con cambios SIN
  // guardar no se rearma aunque llegue un detalle nuevo: cualquier escritura
  // en otra ventana (crear un artículo, confirmar una compra) invalida todas
  // las consultas, y pisaría lo que el usuario está corrigiendo.
  const [base, setBase] = useState<FacturaEscaneadaDetalleDTO | null>(null)
  const [filas, setFilas] = useState<Fila[]>([])
  const [supplierId, setSupplierId] = useState<string | null>(null)
  // null = no se leyó la letra y el usuario todavía no eligió: NO se supone A
  // (con precios finales, a cada costo se le sumaría un IVA que ya tiene).
  const [tipoElegido, setTipoElegido] = useState<TipoComprobante | null>(null)
  /** Total del comprobante: el leído, o el que escribe el usuario si no se leyó. */
  const [total, setTotal] = useState('')
  const [ptoVta, setPtoVta] = useState('')
  const [nroCmp, setNroCmp] = useState('')
  const [fecha, setFecha] = useState('')
  const [sucio, setSucio] = useState(false)
  function aplicar(d: FacturaEscaneadaDetalleDTO): void {
    setBase(d)
    setFilas(d.lineas.map(aFila))
    setSupplierId(d.supplierId)
    // El tipo que eligió el usuario manda (el comprobante X no tiene letra).
    // Si todavía no eligió: la letra leída; la Factura M se trata como A
    // (precios netos). Sin letra queda sin elegir: lo elige el usuario.
    setTipoElegido(tipoDeEncabezado(d.header))
    setTotal(aTexto(d.header?.importe ?? null))
    // Con los ceros de adelante, como se imprime en la factura ("0004-00019142").
    setPtoVta(d.header?.ptoVta != null ? String(d.header.ptoVta).padStart(4, '0') : '')
    setNroCmp(d.header?.nroCmp != null ? String(d.header.nroCmp).padStart(8, '0') : '')
    setFecha(d.header?.fecha ?? '')
    setSucio(false)
  }
  if (detalle.data && detalle.data !== base && !sucio) aplicar(detalle.data)

  const [hoja, setHoja] = useState(1)
  const [zoom, setZoom] = useState(0)
  const [seleccion, setSeleccion] = useState<number | null>(null)
  const [vinculando, setVinculando] = useState<number | null>(null)
  const [pickerProveedor, setPickerProveedor] = useState(false)
  const [creandoProveedor, setCreandoProveedor] = useState(false)
  /** Renglón para el que se está creando un artículo nuevo. */
  const [creandoArticulo, setCreandoArticulo] = useState<number | null>(null)
  const [confirmar, setConfirmar] = useState<'descartar' | 'releer' | 'cargar' | null>(null)
  /** Compra ya registrada con este comprobante que el usuario ya vio en el aviso de carga. */
  const [compraVista, setCompraVista] = useState<string | null>(null)
  const [trabajando, setTrabajando] = useState(false)
  /** «Guardar el CUIT leído en este proveedor» (viene marcada). */
  const [guardarCuit, setGuardarCuit] = useState(true)
  const { currentUser } = useAuth()
  const puedeProveedores = hasPermissionFor(currentUser?.permissions, 'manage_suppliers')
  const puedeArticulos = hasPermissionFor(currentUser?.permissions, 'manage_articles')

  const hojas = base?.hojas ?? 0
  const foto = useQuery({
    queryKey: ['facturas', 'foto', id, hoja],
    queryFn: () => api.facturas.foto(id, hoja),
    enabled: hojas > 0,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })

  const soloLectura = base?.estado !== 'lista'
  const proveedor = supplierId != null ? (suppliers.find((s) => s.id === supplierId) ?? null) : null

  const renglones = useMemo(() => filas.map(aRenglon), [filas])
  /** Los renglones para la cuenta: además, si las unidades por bulto de ese código ya se confirmaron antes. */
  const cuenta = useMemo(
    () => filas.map((f) => ({ ...aRenglon(f), uxbConfirmado: f.dto.uxbRecordado != null && f.articulo?.id === f.dto.articulo?.id })),
    [filas],
  )
  const totalLeido = base?.header?.qr ? (base.header.importe ?? null) : aNumero(total)
  const alicuotaDelRenglon = (r: { articleId: string | null }): number | null => {
    const iva = r.articleId ? Number(porId.get(r.articleId)?.vatRate) : NaN
    return Number.isFinite(iva) ? iva : null
  }
  // Lo que el total dice de los precios (netos o finales), sin importar el tipo elegido.
  const baseSugerida = useMemo(
    () => controlDeTotal(renglones, { total: totalLeido, subtotal: base?.header?.subtotal ?? null }, null, alicuotaDelRenglon).baseSugerida,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renglones, totalLeido, base, porId],
  )
  // Mientras no se elige el tipo, las cuentas de la pantalla usan lo que
  // sugiere el total (y si no sugiere nada, A). No se puede cargar sin elegir.
  const tipo: TipoComprobante = tipoElegido ?? (baseSugerida === 'final' ? 'X' : 'A')
  const pasaje = useMemo(
    () =>
      armarPasajeACompras(
        cuenta,
        tipo,
        priceMode,
        (articleId) => {
          const a = porId.get(articleId)
          return a ? Number(a.vatRate) : null
        },
        (articleId) => {
          const a = porId.get(articleId)
          return a ? Number(a.costPrice) : null
        },
      ),
    [cuenta, tipo, priceMode, porId],
  )
  // Avisos que la cuenta de la factura no ve (IVA distinto al del artículo,
  // costo muy lejos del actual): el renglón se muestra como Revisar.
  const avisos = useMemo(() => {
    const m = new Map<number, string[]>()
    for (const f of filas) {
      const a = f.articulo ? porId.get(f.articulo.id) : undefined
      if (!a || !f.articulo) continue
      const lista = avisosDelRenglon(
        {
          precioUnitario: aNumero(f.precio),
          tasaIva: f.dto.tasaIva ?? null,
          esDescuento: f.dto.esDescuento,
          descripcion: f.dto.descripcion,
          cantidad: aNumero(f.cantidad),
          unidadesPorBulto: aNumero(f.uxb),
          uxbConfirmado: f.dto.uxbRecordado != null && f.articulo.id === f.dto.articulo?.id,
        },
        { alicuota: Number(a.vatRate), costoActual: Number(a.costPrice) },
        tipo,
        priceMode,
      )
      if (lista.length > 0) m.set(f.key, lista)
    }
    return m
  }, [filas, porId, tipo, priceMode])

  // Pie: lo que suma la factura según lo leído, y el control contra el total
  // del comprobante (del QR o impreso en el pie). La misma cuenta que hace el
  // servidor para la lista (`controlDeTotal`).
  const pie = useMemo(() => {
    let articulos = 0
    let descuentos = 0
    for (const r of renglones) {
      const importe = r.importe ?? 0
      if (r.esDescuento) descuentos += Math.abs(importe)
      else articulos += importe
    }
    const control = controlDeTotal(renglones, { total: totalLeido, subtotal: base?.header?.subtotal ?? null }, tipo, alicuotaDelRenglon)
    return { articulos, descuentos, neto: articulos - descuentos, control, totalLeido }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renglones, tipo, porId, base, totalLeido])
  const totalNoCoincide = pie.control.coincide === false
  /** Sin total no hay control: no se puede saber si falta (o sobra) un renglón. */
  const sinTotal = pie.control.coincide === null
  /** El tipo elegido contradice al total (Factura A con renglones que ya suman el total, o al revés). */
  const tipoDudoso = tipoElegido !== null && pie.control.tipoDudoso

  // El total que no coincide (o que contradice al tipo) cuenta como una cosa más para revisar (igual que en la lista).
  const porRevisar = filas.filter((f) => f.estado === 'revisar' || avisos.has(f.key)).length + (totalNoCoincide ? 1 : 0) + (tipoDudoso ? 1 : 0)
  const sinVincular = filas.filter((f) => !f.dto.esDescuento && !f.articulo && !f.esGasto).length

  function editar(key: number, campo: 'cantidad' | 'uxb' | 'precio' | 'importe', valor: string): void {
    setFilas((prev) =>
      prev.map((f) => {
        if (f.key !== key) return f
        const nueva = { ...f, [campo]: valor }
        // Se vuelve a hacer la cuenta con lo que quedó escrito.
        const r = estadoDelRenglon({
          cantidad: aNumero(nueva.cantidad),
          unidadesPorBulto: aNumero(nueva.uxb),
          precioUnitario: aNumero(nueva.precio),
          importe: aNumero(nueva.importe),
        })
        return { ...nueva, estado: r.estado, motivo: r.motivo }
      }),
    )
    setSucio(true)
  }
  function vincularArticulo(key: number, articulo: FacturaEscaneadaArticuloDTO | null): void {
    setFilas((prev) =>
      prev.map((f) => {
        // Quitar el vínculo queda anotado: no vuelve solo por el código. Lo
        // que elige el usuario deja de ser una sugerencia.
        if (f.key === key) return { ...f, articulo, sugerido: false, sinVinculo: articulo === null, esGasto: articulo === null ? f.esGasto : false }
        // El mismo código del proveedor en otro renglón sin vincular (o con
        // una sugerencia): se vincula igual (suele repetirse en las promociones).
        if (articulo && (!f.articulo || f.sugerido) && !f.dto.esDescuento && f.dto.codigo && f.dto.codigo === prev.find((x) => x.key === key)?.dto.codigo) {
          return { ...f, articulo, sugerido: false, sinVinculo: false }
        }
        return f
      }),
    )
    setSucio(true)
  }
  /** «Aceptar sugeridos»: los artículos que propuso el sistema pasan a elegidos (y se recuerdan al registrar la compra). */
  function aceptarSugeridos(): void {
    setFilas((prev) => prev.map((f) => (f.sugerido && f.articulo ? { ...f, sugerido: false } : f)))
    setSucio(true)
  }
  /** Marca (o desmarca) el renglón como gasto: flete, envío… No es mercadería. */
  function marcarGasto(key: number, esGasto: boolean): void {
    setFilas((prev) => prev.map((f) => (f.key === key ? { ...f, esGasto, articulo: esGasto ? null : f.articulo, sugerido: esGasto ? false : f.sugerido } : f)))
    setSucio(true)
  }
  /**
   * La factura cotiza por bulto y el artículo es la unidad: pone las unidades
   * por bulto y pasa el costo a costo por unidad (el importe no cambia).
   */
  function aplicarBulto(key: number, unidades: number): void {
    setFilas((prev) =>
      prev.map((f) => {
        if (f.key !== key) return f
        const precio = aNumero(f.precio)
        const nueva = { ...f, uxb: aTexto(unidades), precio: precio === null ? f.precio : aTexto(Math.round((precio / unidades) * 10000) / 10000) }
        const r = estadoDelRenglon({
          cantidad: aNumero(nueva.cantidad),
          unidadesPorBulto: aNumero(nueva.uxb),
          precioUnitario: aNumero(nueva.precio),
          importe: aNumero(nueva.importe),
        })
        return { ...nueva, estado: r.estado, motivo: r.motivo }
      }),
    )
    setSucio(true)
  }
  function quitar(key: number): void {
    setFilas((prev) => prev.filter((f) => f.key !== key))
    setSucio(true)
  }

  function encabezado(): FacturaEscaneadaEncabezadoDTO {
    const h = base?.header
    const entero = (s: string): number | null => {
      const n = Number(s.replace(/\D/g, ''))
      return s.replace(/\D/g, '') !== '' && Number.isFinite(n) ? n : null
    }
    return {
      fecha: fecha || null,
      cuit: h?.cuit ?? null,
      ptoVta: entero(ptoVta),
      tipoCmp: h?.tipoCmp ?? null,
      // El comprobante X no tiene letra fiscal. Si el QR decía M, se conserva.
      letra: tipoElegido === null ? (h?.letra ?? null) : tipoElegido === 'X' ? null : tipoElegido === 'A' && h?.letra === 'M' ? 'M' : tipoElegido,
      nroCmp: entero(nroCmp),
      // El total del QR fiscal no se toca; si no hay QR, vale el que quedó escrito.
      importe: totalLeido,
      codAut: h?.codAut ?? null,
      qr: h?.qr === true,
      origen: h?.origen ?? null,
      razonSocial: h?.razonSocial ?? null,
      subtotal: h?.subtotal ?? null,
      // El tipo elegido se guarda aparte de la letra: es el que define si los
      // precios son netos o finales, y «Comprobante X» no tiene letra.
      tipo: tipoElegido,
    }
  }

  /**
   * CUIT que se ofrece guardar en el proveedor elegido: no tiene CUIT y la
   * factura trae uno válido que ningún otro proveedor tiene.
   */
  const cuitOfrecido =
    proveedor != null && base != null && base.estado === 'lista' && puedeProveedores
      ? cuitParaGuardar(proveedor, base.header?.cuit, suppliers)
      : null

  /** Guarda y deja en pantalla lo que quedó guardado. Devuelve el detalle nuevo, o null si falló. */
  async function guardar(): Promise<FacturaEscaneadaDetalleDTO | null> {
    // «Guardar el CUIT … en este proveedor» (casilla marcada): con el canal de
    // Proveedores de siempre. Si falla, la factura se guarda igual.
    if (cuitOfrecido && guardarCuit && proveedor) {
      try {
        await api.suppliers.update(proveedor.id, { cuit: cuitConGuiones(cuitOfrecido) })
        await qc.invalidateQueries({ queryKey: ['suppliers'] })
        toast.success(`CUIT ${cuitConGuiones(cuitOfrecido)} guardado en ${proveedor.name}`)
      } catch (err) {
        toast.warning(`No se pudo guardar el CUIT en el proveedor: ${mensajeError(err)}`)
      }
    }
    try {
      const nuevo = await api.facturas.guardar({ id, supplierId, header: encabezado(), lines: renglones })
      aplicar(nuevo)
      qc.setQueryData(['facturas', 'detalle', id], nuevo)
      void qc.invalidateQueries({ queryKey: ['facturas', 'lista'] })
      return nuevo
    } catch (err) {
      toast.error(mensajeError(err))
      return null
    }
  }

  async function volver(): Promise<void> {
    // Lo corregido no se pierde por salir de la revisión.
    if (sucio && !soloLectura) {
      setTrabajando(true)
      const ok = (await guardar()) !== null
      setTrabajando(false)
      if (!ok) return
    }
    onVolver()
  }

  // Compras pidió otra factura con ésta abierta: se guarda lo corregido (si
  // falla, se avisa y esta revisión queda como está) y se pasa a la otra.
  useEffect(() => {
    if (cambioPendiente > 0 && base) void volver()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cambioPendiente, base !== null])

  async function ejecutar(accion: 'descartar' | 'releer' | 'cargar'): Promise<void> {
    setTrabajando(true)
    try {
      if (accion === 'descartar') {
        await api.facturas.descartar(id)
        toast.success('Factura descartada')
      } else if (accion === 'releer') {
        await api.facturas.releer(id)
        toast.success('La factura se vuelve a leer. Puede tardar unos minutos.')
      } else {
        // Primero se guarda: al registrarse la compra se recuerdan los códigos
        // para el proveedor que quedó guardado en la factura.
        const guardada = soloLectura ? base : await guardar()
        if (!guardada) return
        // Con el número recién guardado apareció una compra ya registrada (o
        // una factura escaneada «Cargada») con este comprobante que el usuario
        // todavía no vio: se le muestra antes.
        const aviso = claveDeYaCargada(guardada)
        if (aviso && aviso !== compraVista) {
          setCompraVista(aviso)
          setConfirmar('cargar')
          return
        }
        // La factura NO pasa a «Cargada» acá: la marca Compras cuando la compra
        // se registra. Si no se confirma, sigue «Lista».
        //
        // Si LA pantalla de Compras que abrió esta revisión («Cargar con el
        // teléfono», `pantalla`) la espera, la carga ella sola, sin recargarse
        // (y pregunta si ya tiene una compra a medio armar). Si nadie la
        // espera (revisión abierta desde la lista, ventana cerrada, otro
        // puesto), va por `extras`: Compras los recibe también sin recargarse.
        const comprasAbierta = ventanas.some((w) => w.pageKey === 'compras')
        const devuelta =
          !soloLectura && comprasAbierta && pantalla
            ? await api.facturas.aCompras(id, pantalla).catch(() => ({ recibe: false }))
            : { recibe: false }
        if (devuelta.recibe) {
          toast.success('La factura volvió a Compras: revise y confirme la compra.')
          openInWindow('compras')
        } else {
          openInWindow('compras', {
            extras: prefillDeFactura(
              id,
              {
                supplierId,
                tipo,
                ptoVta: encabezado().ptoVta,
                nroCmp: encabezado().nroCmp,
                fecha: fecha || null,
                yaCargada: guardada.yaCargada,
              },
              pasaje,
            ),
          })
        }
      }
      void qc.invalidateQueries({ queryKey: ['facturas', 'lista'] })
      onVolver()
    } catch (err) {
      toast.error(mensajeError(err))
    } finally {
      setTrabajando(false)
    }
  }

  if (detalle.isLoading || (detalle.data && !base)) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Abriendo la factura…
      </div>
    )
  }
  if (!base) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm">
        <p className="text-destructive">{detalle.error ? mensajeError(detalle.error) : 'No se pudo abrir la factura.'}</p>
        <Button variant="outline" size="sm" onClick={onVolver}>Volver</Button>
      </div>
    )
  }

  const est = ESTADOS[base.estado]
  const clase = claseDeComprobante(base.header?.tipoCmp)
  const esNotaCredito = clase === 'notaCredito'
  const puedeCargar =
    !esNotaCredito && proveedor != null && tipoElegido !== null && pasaje.lineas.length > 0 && !articlesQuery.isLoading && !trabajando
  const motivoNoCargar = esNotaCredito
    ? 'Es una nota de crédito: no se carga como compra'
    : proveedor == null
      ? 'Elija el proveedor para cargar la factura'
      : tipoElegido === null
        ? 'Elija el tipo de comprobante para cargar la factura'
        : pasaje.lineas.length === 0
        ? 'Vincule al menos un renglón con un artículo'
        : undefined
  // El alta de un artículo toma el costo de la factura: sin saber si los
  // precios son netos o finales, el costo quedaría mal guardado para siempre.
  const motivoNoCrear = tipoElegido === null ? 'Elija el tipo de comprobante para crear artículos: define si el costo leído es neto o final' : undefined
  const baseEmpresa = baseDeLaEmpresa(priceMode)
  const filaVinculando = vinculando != null ? (filas.find((f) => f.key === vinculando) ?? null) : null
  const filaCreando = creandoArticulo != null ? (filas.find((f) => f.key === creandoArticulo) ?? null) : null
  const sugeridos = filas.filter((f) => f.sugerido && f.articulo).length
  const yaCargada = avisoYaCargada(base.yaCargada)

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Barra superior */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void volver()} disabled={trabajando}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            Volver
          </Button>
          <h1 className="text-lg font-semibold">Revisar factura</h1>
          <span className="text-sm text-muted-foreground">Estado:</span>
          <Badge variant={est.variante}>{est.etiqueta}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {!soloLectura && sugeridos > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="border-amber-500 text-amber-700"
              disabled={trabajando}
              title="Los artículos que el sistema eligió por parecido pasan a elegidos. Al registrar la compra se recuerdan para este proveedor."
              onClick={aceptarSugeridos}
            >
              Aceptar sugeridos ({sugeridos})
            </Button>
          )}
          {!soloLectura && (
            <>
              <Button variant="ghost" size="sm" className="text-destructive" disabled={trabajando} onClick={() => setConfirmar('descartar')}>
                Descartar
              </Button>
              <Button variant="outline" size="sm" disabled={trabajando} onClick={() => setConfirmar('releer')}>
                Volver a leer
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!sucio || trabajando}
                onClick={() => {
                  setTrabajando(true)
                  void guardar().then((ok) => {
                    setTrabajando(false)
                    if (ok) toast.success('Cambios guardados')
                  })
                }}
              >
                Guardar
              </Button>
            </>
          )}
          <Button
            variant="success"
            disabled={!puedeCargar}
            title={motivoNoCargar}
            onClick={() => {
              setCompraVista(claveDeYaCargada(base))
              setConfirmar('cargar')
            }}
          >
            {trabajando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {soloLectura ? 'Cargar de nuevo en Compras' : 'Cargar en Compras'}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,2fr)_3fr] gap-3">
        {/* Foto de la hoja */}
        <div className="flex min-h-0 flex-col gap-2 rounded-lg border bg-card p-2">
          <div className="flex shrink-0 items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={hoja <= 1} onClick={() => setHoja((h) => h - 1)} title="Hoja anterior">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-1 tabular-nums">Hoja {hojas === 0 ? 0 : hoja} de {hojas}</span>
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={hoja >= hojas} onClick={() => setHoja((h) => h + 1)} title="Hoja siguiente">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={zoom <= 0} onClick={() => setZoom((z) => z - 1)} title="Alejar">
                <ZoomOut className="h-4 w-4" />
              </Button>
              <span className="w-12 text-center tabular-nums">{Math.round(ZOOMS[zoom]! * 100)}%</span>
              <Button variant="outline" size="icon" className="h-7 w-7" disabled={zoom >= ZOOMS.length - 1} onClick={() => setZoom((z) => z + 1)} title="Acercar">
                <ZoomIn className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/40">
            {foto.data ? (
              <img
                src={foto.data.dataUrl}
                alt={`Hoja ${hoja} de la factura`}
                className="block max-w-none"
                style={{ width: `${ZOOMS[zoom]! * 100}%` }}
                draggable={false}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {foto.isLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : foto.error ? (
                  mensajeError(foto.error)
                ) : (
                  'Sin foto'
                )}
              </div>
            )}
          </div>
        </div>

        {/* Encabezado + renglones */}
        <div className="flex min-h-0 flex-col gap-2">
          <div className="grid shrink-0 grid-cols-[2fr_1fr_1.4fr_1fr] gap-2 rounded-lg border bg-card p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Label>Proveedor</Label>
              <Button variant="outline" className="justify-between" disabled={soloLectura} onClick={() => setPickerProveedor(true)}>
                <span className="truncate">{proveedor ? `${proveedor.code} — ${proveedor.name}` : 'Elegir proveedor…'}</span>
                <Search className="h-4 w-4 shrink-0 opacity-60" />
              </Button>
              {!proveedor && (base.header?.razonSocial || base.header?.cuit) && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-amber-600">
                  <span>
                    Proveedor leído: {[base.header.razonSocial, base.header.cuit ? `CUIT ${cuitConGuiones(base.header.cuit)}` : null].filter(Boolean).join(' · ')}
                  </span>
                  {!soloLectura && puedeProveedores && (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={trabajando} onClick={() => setCreandoProveedor(true)}>
                      Crear proveedor
                    </Button>
                  )}
                  {!soloLectura && !puedeProveedores && (
                    <span className="text-muted-foreground">Elíjalo de la lista; si no figura, solicite el alta en Proveedores.</span>
                  )}
                </div>
              )}
              {!proveedor && !soloLectura && base.proveedoresSugeridos.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  <span>¿Es alguno de éstos?</span>
                  {base.proveedoresSugeridos.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="max-w-full truncate rounded bg-primary/10 px-1.5 py-0.5 text-left text-[11px] text-primary hover:bg-primary/20"
                      title={`Asociar la factura a ${s.name}${s.cuit ? ` (CUIT ${s.cuit})` : ' (sin CUIT cargado)'}`}
                      onClick={() => { setSupplierId(s.id); setSucio(true) }}
                    >
                      {s.code} — {s.name}
                    </button>
                  ))}
                </div>
              )}
              {cuitOfrecido && (
                <label
                  className="flex cursor-pointer items-start gap-1.5 text-xs text-muted-foreground"
                  title="Contrólelo contra la factura. Con el CUIT guardado, las próximas facturas de este proveedor se asocian solas."
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 rounded border-input"
                    checked={guardarCuit}
                    disabled={trabajando}
                    onChange={(e) => {
                      setGuardarCuit(e.target.checked)
                      setSucio(true)
                    }}
                  />
                  <span>
                    Guardar el CUIT {cuitConGuiones(cuitOfrecido)} en este proveedor (no tiene CUIT cargado). Se guarda al guardar la
                    revisión o al cargarla en Compras.
                  </span>
                </label>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label>Tipo</Label>
              <Select
                value={tipoElegido ?? ''}
                disabled={soloLectura}
                className={cn(tipoElegido === null && 'border-amber-500')}
                onChange={(e) => { if (e.target.value) { setTipoElegido(e.target.value as TipoComprobante); setSucio(true) } }}
              >
                {tipoElegido === null && <option value="">Elegir…</option>}
                {TIPOS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Número</Label>
              <div className="flex items-center gap-1">
                <Input
                  className="w-16 text-right tabular-nums"
                  inputMode="numeric"
                  placeholder="0001"
                  title="Punto de venta"
                  value={ptoVta}
                  disabled={soloLectura}
                  onChange={(e) => { setPtoVta(e.target.value); setSucio(true) }}
                  // Mientras escribe se acepta cualquier cosa; al salir queda con 4 dígitos ("4" → "0004").
                  onBlur={() => setPtoVta((v) => normalizarNumero(v, 4, 5))}
                />
                <span className="text-muted-foreground">-</span>
                <Input
                  className="min-w-0 flex-1 text-right tabular-nums"
                  inputMode="numeric"
                  placeholder="00012345"
                  title="Número de comprobante"
                  value={nroCmp}
                  disabled={soloLectura}
                  onChange={(e) => { setNroCmp(e.target.value); setSucio(true) }}
                  onBlur={() => setNroCmp((v) => normalizarNumero(v, 8, 8))}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Fecha</Label>
              <Input type="date" value={fecha} disabled={soloLectura} onChange={(e) => { setFecha(e.target.value); setSucio(true) }} />
            </div>
            <div className="col-span-4 text-xs text-muted-foreground">
              {base.header?.qr
                ? 'Datos del comprobante leídos del código QR fiscal.'
                : base.header?.origen === 'texto'
                  ? 'Datos del comprobante leídos del texto de la factura (no se leyó el código QR fiscal): contrólelos.'
                  : 'No se leyeron los datos del comprobante: complételos.'}
              {' '}
              {tipoElegido === null ? '' : tipo === 'A' ? 'Factura A: los precios leídos son netos (sin IVA).' : 'Los precios leídos son finales.'}
            </div>
            {desdeCompras && !soloLectura && (
              <div className="col-span-4 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-xs">
                Esta factura llegó desde «Cargar con el teléfono». Al tocar «Cargar en Compras», vuelve al formulario de Compras
                que la espera; la compra se confirma allí.
              </div>
            )}
            {base.lecturaVieja && !soloLectura && (
              <div className="col-span-4 text-xs text-amber-600">
                Esta factura se leyó con una versión anterior del lector. «Volver a leer» la actualiza (se pierden las correcciones hechas).
              </div>
            )}
            {tipoElegido === null && !soloLectura && (
              <div className="col-span-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs font-semibold text-amber-700">
                No se leyó la letra del comprobante: elija el tipo antes de cargar.
                <span className="font-normal">
                  {baseSugerida === 'final'
                    ? ' La suma de los renglones ya da el total: los precios parecen finales (Factura B, C o comprobante X).'
                    : baseSugerida === 'neto'
                      ? ' La suma de los renglones da el total recién con el IVA: los precios parecen netos (Factura A).'
                      : ' En Factura A los precios son netos; en B, C y comprobante X son finales.'}
                </span>
              </div>
            )}
            {tipoDudoso && (
              <div className="col-span-4 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
                {tipo === 'A'
                  ? 'La suma de los renglones sin IVA ya da el total de la factura: los precios parecen finales. Revise el tipo de comprobante.'
                  : 'La suma de los renglones da el total recién con el IVA: los precios parecen netos. Revise el tipo de comprobante.'}
              </div>
            )}
            {sinTotal && !soloLectura && (
              <div className="col-span-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs font-semibold text-amber-700">
                No se leyó el total de la factura: no se puede controlar si falta un renglón. Ingréselo en «Total de la factura».
              </div>
            )}
            {esNotaCredito && (
              <div className="col-span-4 text-xs font-semibold text-destructive">
                Nota de crédito: este comprobante resta mercadería y deuda. No se carga como compra.
              </div>
            )}
            {clase === 'notaDebito' && (
              <div className="col-span-4 text-xs font-semibold text-amber-600">
                Nota de débito: controle que corresponda cargarla como una compra.
              </div>
            )}
            {totalNoCoincide && pie.control.total !== null && (
              <div className="col-span-4 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
                La suma de los renglones ({formatCurrency(tipo === 'A' ? pie.control.sumaConIva : pie.control.suma)}
                {tipo === 'A' ? ' con IVA' : ''}) no coincide con el total de la factura ({formatCurrency(pie.control.total)}). Puede
                faltar un renglón.
                {tipo === 'A' && (
                  <span className="font-normal"> La diferencia también puede ser de percepciones o impuestos internos.</span>
                )}
              </div>
            )}
            {yaCargada && base.estado === 'lista' && (
              <div className="col-span-4 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs font-semibold text-destructive">
                {yaCargada}
                {base.compraExistente ? (
                  <span className="font-normal">
                    {' '}
                    Compra {base.compraExistente.type} #{base.compraExistente.number} del {formatDate(base.compraExistente.date)}, por{' '}
                    {formatCurrency(base.compraExistente.total)}.
                  </span>
                ) : (
                  <span className="font-normal"> Figura como Cargada en otra factura escaneada con el mismo comprobante.</span>
                )}
              </div>
            )}
            {base.estado !== 'lista' && base.compraExistente && (
              <div className="col-span-4 text-xs text-muted-foreground">
                Compra registrada: {base.compraExistente.type} #{base.compraExistente.number} del {formatDate(base.compraExistente.date)}, por{' '}
                {formatCurrency(base.compraExistente.total)}.
              </div>
            )}
            {base.repetida && !yaCargada && (
              <div className="col-span-4 text-xs font-semibold text-destructive">
                Este comprobante ya fue escaneado: hay otra factura en la lista con el mismo número.
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="w-24 px-2 py-1.5">Código</th>
                  <th className="px-2 py-1.5">Descripción leída</th>
                  <th className="px-2 py-1.5">Artículo</th>
                  <th className="w-20 px-2 py-1.5" title="De dónde salió el artículo del renglón">Vínculo</th>
                  <th className="w-[4.5rem] px-1 py-1.5 text-right">Cant.</th>
                  <th className="w-14 px-1 py-1.5 text-right" title="Unidades por bulto">UxB</th>
                  <th className="w-24 px-1 py-1.5 text-right">{tipo === 'A' ? 'Costo neto' : 'Costo'}</th>
                  <th className="w-24 px-1 py-1.5 text-right">Importe</th>
                  <th className="w-20 px-2 py-1.5">Estado</th>
                  <th className="w-8 px-1 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {filas.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-10 text-center text-sm text-muted-foreground">
                      No se leyó ningún renglón. Pruebe «Volver a leer» o cargue la compra a mano.
                    </td>
                  </tr>
                ) : (
                  filas.map((f) => {
                    const avisosFila = avisos.get(f.key) ?? []
                    const estadoFila = avisosFila.length > 0 ? 'revisar' : f.estado
                    const e = ESTADO_RENGLON[estadoFila]
                    const motivoFila = [f.motivo, ...avisosFila].filter(Boolean).join(' · ') || null
                    const vinculo = vinculoDe(f)
                    const campo = (nombre: 'cantidad' | 'uxb' | 'precio' | 'importe') => (
                      <Input
                        className="h-7 px-1.5 text-right tabular-nums"
                        inputMode="decimal"
                        value={f[nombre]}
                        disabled={soloLectura}
                        onChange={(ev) => editar(f.key, nombre, ev.target.value)}
                      />
                    )
                    return (
                      <tr
                        key={f.key}
                        className={cn(
                          'border-t align-top',
                          estadoFila === 'revisar' && 'bg-destructive/5',
                          seleccion === f.key && 'outline outline-1 -outline-offset-1 outline-primary',
                        )}
                        onClick={() => {
                          // Tocar un renglón lleva la foto a su hoja.
                          setSeleccion(f.key)
                          if (f.dto.hoja >= 1 && f.dto.hoja <= hojas) setHoja(f.dto.hoja)
                        }}
                      >
                        <td
                          className={cn('px-2 py-1.5 font-mono text-xs', f.dto.codigoDudoso && 'cursor-help text-amber-600 underline decoration-dotted')}
                          title={
                            f.dto.codigoDudoso
                              ? 'Código dudoso: la hoja salió cortada en un borde (puede estar incompleto) o el código se leyó en una línea aparte (puede ser del renglón vecino). No vincula solo ni se recuerda para el proveedor.'
                              : undefined
                          }
                        >
                          {f.dto.codigo ?? '—'}
                        </td>
                        <td className="px-2 py-1.5" title={f.dto.original}>
                          {f.dto.descripcion || <span className="text-muted-foreground">(sin descripción)</span>}
                          <div className="text-[10px] text-muted-foreground">Hoja {f.dto.hoja}</div>
                        </td>
                        <td className="px-2 py-1.5">
                          {f.dto.esDescuento ? (
                            <span className="text-xs text-muted-foreground">Descuento</span>
                          ) : f.esGasto && !f.articulo ? (
                            <div className="flex flex-col items-start gap-0.5">
                              <span className="text-xs font-medium text-amber-600" title="Cuenta para el total de la factura, pero no se carga como renglón de la compra.">
                                Gasto, no es mercadería
                              </span>
                              {!soloLectura && (
                                <button
                                  type="button"
                                  className="text-[11px] text-primary hover:underline"
                                  onClick={(ev) => { ev.stopPropagation(); marcarGasto(f.key, false) }}
                                >
                                  Es mercadería
                                </button>
                              )}
                            </div>
                          ) : f.articulo ? (
                            <div className="flex items-start justify-between gap-1">
                              <div className="min-w-0" title={vinculo.detalle}>
                                <div className="truncate font-medium">{f.articulo.description}</div>
                                <div className="font-mono text-[10px] text-muted-foreground">{f.articulo.barcode}</div>
                                {!porId.has(f.articulo.id) && !articlesQuery.isLoading && (
                                  <div className="text-[10px] text-destructive">Artículo dado de baja: no se carga</div>
                                )}
                              </div>
                              {!soloLectura && (
                                <button
                                  type="button"
                                  className="shrink-0 text-xs text-primary hover:underline"
                                  onClick={(ev) => { ev.stopPropagation(); setVinculando(f.key) }}
                                >
                                  Cambiar
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-col items-start gap-1">
                              {!soloLectura && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 border-dashed text-xs"
                                  onClick={(ev) => { ev.stopPropagation(); setVinculando(f.key) }}
                                >
                                  <Search className="mr-1 h-3 w-3" />
                                  Vincular
                                </Button>
                              )}
                              {!soloLectura &&
                                f.dto.sugerencias.slice(0, 1).map((s) => (
                                  <button
                                    key={s.id}
                                    type="button"
                                    className="max-w-full truncate rounded bg-primary/10 px-1.5 py-0.5 text-left text-[11px] text-primary hover:bg-primary/20"
                                    title={`Vincular con ${s.description} (${s.barcode})`}
                                    onClick={(ev) => { ev.stopPropagation(); vincularArticulo(f.key, s) }}
                                  >
                                    ¿{s.description}?
                                  </button>
                                ))}
                              {!soloLectura && (
                                <div className="flex flex-wrap gap-x-2">
                                  {puedeArticulos && (
                                    <button
                                      type="button"
                                      className="text-[11px] text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                                      disabled={motivoNoCrear !== undefined}
                                      title={motivoNoCrear ?? 'El producto no está en el sistema: se da de alta con los datos de la factura y queda vinculado.'}
                                      onClick={(ev) => { ev.stopPropagation(); setCreandoArticulo(f.key) }}
                                    >
                                      Crear artículo
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="text-[11px] text-muted-foreground hover:underline"
                                    title="Flete, envío u otro gasto: no es mercadería y no lleva artículo."
                                    onClick={(ev) => { ev.stopPropagation(); marcarGasto(f.key, true) }}
                                  >
                                    Es un gasto
                                  </button>
                                </div>
                              )}
                              {soloLectura && <span className="text-xs text-muted-foreground">Sin vincular</span>}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          {!f.dto.esDescuento && !(f.esGasto && !f.articulo) && (
                            <span className={cn('cursor-help text-xs font-semibold', vinculo.clase)} title={vinculo.detalle}>
                              {vinculo.etiqueta}
                            </span>
                          )}
                        </td>
                        <td className="px-1 py-1">{campo('cantidad')}</td>
                        <td className="px-1 py-1">
                          {campo('uxb')}
                          {(() => {
                            // Bulto para proponer: el que se confirmó antes para este código o el que dice la descripción.
                            // Si la factura ya trae la cantidad en unidades (bultos × pack = cantidad), no se propone nada.
                            if (soloLectura || f.dto.esDescuento || f.esGasto || f.uxb.trim() !== '' || f.dto.packResuelto) return null
                            const recordado = f.dto.uxbRecordado != null && f.articulo?.id === f.dto.articulo?.id ? f.dto.uxbRecordado : null
                            if (recordado === 1) return null
                            const n = recordado ?? packEnDescripcion(f.dto.descripcion)
                            if (!n || n <= 1) return null
                            return (
                              <button
                                type="button"
                                className="mt-0.5 w-full rounded bg-primary/10 px-1 text-[10px] text-primary hover:bg-primary/20"
                                title={`Aplicar ${n} unidades por bulto: el costo pasa a ser por unidad (se divide por ${n}) y entran ${n} unidades por cada bulto.`}
                                onClick={(ev) => { ev.stopPropagation(); aplicarBulto(f.key, n) }}
                              >
                                × {n}
                              </button>
                            )
                          })()}
                        </td>
                        <td className="px-1 py-1">{campo('precio')}</td>
                        <td className="px-1 py-1">{campo('importe')}</td>
                        <td className="px-2 py-1.5">
                          <span
                            className={cn('text-xs font-semibold', e.clase, motivoFila && 'cursor-help underline decoration-dotted')}
                            title={motivoFila ?? undefined}
                          >
                            {e.etiqueta}
                          </span>
                        </td>
                        <td className="px-1 py-1">
                          {!soloLectura && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              title="Quitar renglón"
                              onClick={(ev) => { ev.stopPropagation(); quitar(f.key) }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pie */}
          <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 rounded-lg border bg-card p-3 text-sm">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Suma de renglones{tipo === 'A' ? ' (neto)' : ''}</span>
                <span className="tabular-nums">{formatCurrency(pie.articulos)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Descuentos</span>
                <span className="tabular-nums">{pie.descuentos > 0 ? `− ${formatCurrency(pie.descuentos)}` : formatCurrency(0)}</span>
              </div>
              <div className="flex justify-between border-t pt-1 font-semibold">
                <span>Subtotal{tipo === 'A' ? ' neto' : ''}</span>
                <span className="tabular-nums">{formatCurrency(pie.neto)}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              {tipo === 'A' && (
                <div className="flex justify-between" title="Subtotal neto más el IVA de cada renglón (el de la factura si se leyó; si no, el del artículo, o 21 % sin vincular). No incluye percepciones ni impuestos internos.">
                  <span className="text-muted-foreground">Total estimado con IVA</span>
                  <span className="tabular-nums">{formatCurrency(pie.control.sumaConIva)}</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <span className={cn('text-muted-foreground', sinTotal && !soloLectura && 'font-semibold text-amber-700')}>
                  Total de la factura{base.header?.qr ? ' (QR)' : ''}
                </span>
                {base.header?.qr || soloLectura ? (
                  <span className="tabular-nums">{pie.totalLeido !== null ? formatCurrency(pie.totalLeido) : 'No se leyó'}</span>
                ) : (
                  <Input
                    className={cn('h-7 w-36 px-1.5 text-right tabular-nums', sinTotal && 'border-amber-500')}
                    inputMode="decimal"
                    placeholder="No se leyó"
                    title="Total impreso en la factura. Sirve para controlar que no falte ningún renglón."
                    value={total}
                    onChange={(e) => { setTotal(e.target.value); setSucio(true) }}
                  />
                )}
              </div>
              {pie.control.coincide !== null && (
                <div className="flex justify-between border-t pt-1 font-semibold">
                  <span>Control</span>
                  {pie.control.coincide ? (
                    <span className="text-success">Coincide</span>
                  ) : (
                    <span
                      className="cursor-help text-destructive underline decoration-dotted"
                      title="La suma de lo leído no da el total del comprobante. Puede faltar un renglón, o la diferencia ser de percepciones, impuestos internos u otra alícuota de IVA."
                    >
                      Difiere en {formatCurrency(Math.abs(pie.control.diferencia))}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="col-span-2 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
              <span>{filas.length} renglones</span>
              <span className={cn(porRevisar > 0 && 'font-semibold text-destructive')}>{porRevisar} a revisar</span>
              <span className={cn(sinVincular > 0 && 'font-semibold text-amber-600')}>{sinVincular} sin artículo</span>
              {pasaje.gastos > 0 && (
                <span className="font-semibold text-amber-600">
                  {pasaje.gastos} {pasaje.gastos === 1 ? 'gasto' : 'gastos'} por {formatCurrency(pasaje.importeGastos)}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <SupplierPicker
        open={pickerProveedor}
        suppliers={suppliers}
        onClose={() => setPickerProveedor(false)}
        onSelect={(s) => { setSupplierId(s.id); setSucio(true); setPickerProveedor(false) }}
      />

      {creandoProveedor && (
        <CrearProveedorDialog
          suppliers={suppliers}
          nombre={base.header?.razonSocial ?? ''}
          cuit={base.header?.cuit ?? ''}
          onClose={() => setCreandoProveedor(false)}
          onCreado={(nuevo) => {
            setCreandoProveedor(false)
            setSupplierId(nuevo.id)
            setSucio(true)
            void qc.invalidateQueries({ queryKey: ['suppliers'] })
          }}
          onElegido={(existente) => {
            setCreandoProveedor(false)
            setSupplierId(existente.id)
            setSucio(true)
          }}
        />
      )}

      {filaVinculando && (
        <ArticuloPicker
          fila={filaVinculando}
          articulos={activos}
          buscar={(a, q) => articleMatches(a, q, searchCtx)}
          onClose={() => setVinculando(null)}
          onSelect={(a) => { vincularArticulo(filaVinculando.key, a); setVinculando(null) }}
          onCrear={
            puedeArticulos && !filaVinculando.dto.esDescuento
              ? () => {
                  setCreandoArticulo(filaVinculando.key)
                  setVinculando(null)
                }
              : undefined
          }
          motivoNoCrear={motivoNoCrear}
        />
      )}

      {filaCreando && (
        <CrearArticuloDialog
          fila={filaCreando}
          tipo={tipoElegido}
          modo={priceMode}
          proveedor={proveedor}
          articulos={articlesQuery.data ?? []}
          onClose={() => setCreandoArticulo(null)}
          onElegido={(a) => {
            vincularArticulo(filaCreando.key, a)
            setCreandoArticulo(null)
          }}
          onCreado={(nuevo) => {
            // Que la pantalla lo conozca ya (si no, figuraría «dado de baja» hasta refrescar).
            qc.setQueryData<ArticleDTO[]>(['articles'], (prev) => (prev ? [...prev.filter((a) => a.id !== nuevo.id), nuevo] : [nuevo]))
            void qc.invalidateQueries({ queryKey: ['articles'] })
            vincularArticulo(filaCreando.key, {
              id: nuevo.id,
              barcode: nuevo.barcode,
              description: nuevo.description,
              costPrice: nuevo.costPrice,
              active: nuevo.active,
            })
            setCreandoArticulo(null)
            toast.success('Artículo creado y vinculado al renglón')
          }}
        />
      )}

      <AlertDialog open={confirmar != null} onOpenChange={(o) => { if (!o) setConfirmar(null) }}>
        <AlertDialogContent>
          {confirmar === 'descartar' && (
            <AlertDialogHeader>
              <AlertDialogTitle>¿Descartar la factura?</AlertDialogTitle>
              <AlertDialogDescription>Se borran las fotos y lo leído. Esta acción no se puede deshacer.</AlertDialogDescription>
            </AlertDialogHeader>
          )}
          {confirmar === 'releer' && (
            <AlertDialogHeader>
              <AlertDialogTitle>¿Volver a leer la factura?</AlertDialogTitle>
              <AlertDialogDescription>
                Se leen de nuevo las fotos y se pierden las correcciones hechas en los renglones. Puede tardar unos minutos.
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          {confirmar === 'cargar' && (
            <AlertDialogHeader>
              <AlertDialogTitle>¿Cargar en Compras?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                  <p>
                    Se abre Compras con {pasaje.lineas.length} {pasaje.lineas.length === 1 ? 'artículo' : 'artículos'} por{' '}
                    {formatCurrency(pasaje.subtotal)} ({baseEmpresa === 'neto' ? 'costos netos, el IVA se suma aparte' : 'costos con IVA incluido'}).
                    La compra no se registra hasta que usted la confirme allí; recién entonces la factura queda como Cargada.
                  </p>
                  {yaCargada && (
                    <p className="font-semibold text-destructive">
                      {yaCargada}
                      {base.compraExistente &&
                        ` (compra ${base.compraExistente.type} #${base.compraExistente.number} del ${formatDate(base.compraExistente.date)})`}{' '}
                      Si la carga de nuevo, el stock y la deuda quedan duplicados.
                    </p>
                  )}
                  {base.repetida && !yaCargada && (
                    <p className="font-semibold text-destructive">
                      Este comprobante figura en otra factura escaneada. Controle que no se cargue dos veces.
                    </p>
                  )}
                  {pasaje.sugeridos > 0 && (
                    <p className="font-medium text-amber-600">
                      {pasaje.sugeridos === 1
                        ? '1 renglón tiene un artículo sugerido por el sistema: contrólelo en Compras. No se recuerda para el proveedor hasta que lo acepte.'
                        : `${pasaje.sugeridos} renglones tienen artículos sugeridos por el sistema: contrólelos en Compras. No se recuerdan para el proveedor hasta que los acepte.`}
                    </p>
                  )}
                  {clase === 'notaDebito' && (
                    <p className="font-medium text-amber-600">El comprobante es una nota de débito.</p>
                  )}
                  {sinTotal && (
                    <p className="font-semibold text-amber-600">
                      No se leyó el total de la factura: no se pudo controlar si falta un renglón. Compare la cantidad de renglones y
                      el importe con la factura antes de confirmar la compra.
                    </p>
                  )}
                  {totalNoCoincide && (
                    <p className="font-semibold text-destructive">
                      La suma de los renglones no coincide con el total de la factura (difiere en{' '}
                      {formatCurrency(Math.abs(pie.control.diferencia))}). Puede faltar un renglón.
                    </p>
                  )}
                  {tipoDudoso && (
                    <p className="font-semibold text-destructive">
                      {tipo === 'A'
                        ? 'La suma de los renglones sin IVA ya da el total: los precios parecen finales y se cargarían con el IVA sumado de nuevo. Revise el tipo de comprobante.'
                        : 'La suma de los renglones da el total recién con el IVA: los precios parecen netos. Revise el tipo de comprobante.'}
                    </p>
                  )}
                  {pasaje.gastos > 0 && (
                    <p className="font-medium text-amber-600">
                      {pasaje.gastos === 1 ? '1 renglón es un gasto' : `${pasaje.gastos} renglones son gastos`} (flete, envío) por{' '}
                      {formatCurrency(pasaje.importeGastos)}: no es mercadería y no se carga. La compra queda por ese importe menos que
                      la factura; agréguelo en Compras si corresponde.
                    </p>
                  )}
                  {pasaje.sinArticulo > 0 && (
                    <p className="font-medium text-destructive">
                      {pasaje.sinArticulo === 1
                        ? '1 renglón sin artículo vinculado queda afuera.'
                        : `${pasaje.sinArticulo} renglones sin artículo vinculado quedan afuera.`}
                    </p>
                  )}
                  {pasaje.sinDatos > 0 && (
                    <p className="font-medium text-destructive">
                      {pasaje.sinDatos === 1
                        ? '1 renglón sin cantidad o sin precio queda afuera.'
                        : `${pasaje.sinDatos} renglones sin cantidad o sin precio quedan afuera.`}
                    </p>
                  )}
                  {pasaje.porRevisar > 0 && (
                    <p className="font-medium text-amber-600">
                      {pasaje.porRevisar === 1
                        ? '1 renglón que se carga figura como Revisar.'
                        : `${pasaje.porRevisar} renglones que se cargan figuran como Revisar.`}
                    </p>
                  )}
                  {pasaje.descuentosPorRevisar > 0 && (
                    <p className="font-medium text-amber-600">
                      {pasaje.descuentosPorRevisar === 1
                        ? '1 descuento figura como Revisar: controle el descuento de la compra.'
                        : `${pasaje.descuentosPorRevisar} descuentos figuran como Revisar: controle el descuento de la compra.`}
                    </p>
                  )}
                  {!pasaje.mismaBase && (
                    <p>
                      {pasaje.baseFactura === 'neto'
                        ? 'Los precios de la factura son netos y la empresa trabaja con precios con IVA incluido: a cada costo se le suma el IVA (el de la factura si se leyó; si no, el del artículo).'
                        : 'Los precios de la factura son finales y la empresa trabaja con precios netos: a cada costo se le descuenta el IVA del artículo.'}
                    </p>
                  )}
                  {pasaje.descuentos > 0 &&
                    (pasaje.descuentoACargar !== '0' ? (
                      <p>
                        Los descuentos de la factura ({formatCurrency(pasaje.descuentos)}
                        {pasaje.mismaBase ? '' : pasaje.baseFactura === 'neto' ? ' netos' : ' finales'}) se precargan en el descuento de
                        la compra
                        {pasaje.mismaBase
                          ? '.'
                          : ` por ${formatCurrency(pasaje.descuentoACargar)} (${pasaje.baseFactura === 'neto' ? 'con el IVA sumado' : 'sin el IVA'}, como los costos).`}
                        {(pasaje.sinArticulo > 0 || pasaje.sinDatos > 0) && ' Revise el importe: hay renglones que quedan afuera.'}
                      </p>
                    ) : (
                      <p className="font-medium text-amber-600">
                        Los descuentos de la factura ({formatCurrency(pasaje.descuentos)}
                        {pasaje.baseFactura === 'neto' ? ' netos' : ''}) NO se cargan
                        {pasaje.descuentosEnBase === null
                          ? ': están en otra base que los costos de la compra y no traen la alícuota de IVA para convertirlos'
                          : ''}
                        . Ingréselos en el descuento de Compras si corresponde.
                      </p>
                    ))}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const accion = confirmar
                setConfirmar(null)
                if (accion) void ejecutar(accion)
              }}
            >
              {confirmar === 'descartar' ? 'Descartar' : confirmar === 'releer' ? 'Volver a leer' : 'Cargar en Compras'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ─────────────────────────── Crear proveedor ─────────────────────────── */

/** Próximo código libre: el mayor código numérico + 1 (los códigos de proveedor suelen ser correlativos). */
function proximoCodigo(suppliers: SupplierDTO[]): string {
  let mayor = 0
  for (const s of suppliers) if (/^\d{1,9}$/.test(s.code.trim())) mayor = Math.max(mayor, Number(s.code))
  let n = mayor + 1
  const usados = new Set(suppliers.map((s) => s.code.trim()))
  while (usados.has(String(n))) n++
  return String(n)
}

/**
 * Alta rápida del proveedor leído en la factura: nombre y CUIT vienen
 * precargados (se pueden corregir) y el código es el próximo libre. Usa el
 * alta de Proveedores de siempre (`suppliers:create`): mismos controles y
 * permiso. El resto de los datos se completa después en Proveedores.
 */
function CrearProveedorDialog({
  suppliers,
  nombre,
  cuit,
  onClose,
  onCreado,
  onElegido,
}: {
  suppliers: SupplierDTO[]
  nombre: string
  cuit: string
  onClose: () => void
  onCreado: (s: SupplierDTO) => void
  /** El usuario eligió uno que ya existía en vez de crear otro. */
  onElegido: (s: SupplierDTO) => void
}) {
  const [codigo, setCodigo] = useState(() => proximoCodigo(suppliers))
  const [name, setName] = useState(nombre)
  const [cuitTxt, setCuitTxt] = useState(cuit ? cuitConGuiones(cuit) : '')
  const [guardando, setGuardando] = useState(false)
  const codigoRepetido = suppliers.some((s) => s.code.trim() === codigo.trim())
  // Antes de crear: ¿ya está cargado? Por CUIT (no se crea otro con el mismo)
  // o por una palabra propia del nombre (se ofrece usar el que ya existe: un
  // segundo proveedor parte la cuenta corriente y los códigos recordados).
  const cuitDigitos = cuitTxt.replace(/\D/g, '')
  const conEseCuit = cuitDigitos.length === 11 ? suppliers.filter((s) => (s.cuit ?? '').replace(/\D/g, '') === cuitDigitos) : []
  const parecidos = useMemo(
    () => proveedoresParecidos({ razonSocial: name, cuit: cuitDigitos.length === 11 ? cuitDigitos : null }, suppliers, 4),
    [name, cuitDigitos, suppliers],
  )
  const puede = codigo.trim() !== '' && name.trim() !== '' && !codigoRepetido && conEseCuit.length === 0 && !guardando

  async function crear(): Promise<void> {
    setGuardando(true)
    try {
      const nuevo = await api.suppliers.create({ code: codigo.trim(), name: name.trim(), cuit: cuitTxt.trim() || null })
      toast.success('Proveedor creado')
      onCreado(nuevo)
    } catch (err) {
      toast.error(mensajeError(err))
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !guardando) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Crear proveedor</DialogTitle>
          <DialogDescription>
            Datos leídos de la factura. Contrólelos antes de crear el proveedor; el resto se completa en Proveedores.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[7rem_1fr] items-center gap-x-3 gap-y-2">
          <Label htmlFor="prov-codigo">Código</Label>
          <div className="flex flex-col gap-0.5">
            <Input id="prov-codigo" className="w-32" value={codigo} onChange={(e) => setCodigo(e.target.value)} />
            {codigoRepetido && <span className="text-xs text-destructive">Ya hay un proveedor con ese código.</span>}
          </div>
          <Label htmlFor="prov-nombre">Nombre</Label>
          <Input id="prov-nombre" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          <Label htmlFor="prov-cuit">CUIT</Label>
          <div className="flex flex-col gap-0.5">
            <Input id="prov-cuit" className="w-44" placeholder="30-12345678-9" value={cuitTxt} onChange={(e) => setCuitTxt(e.target.value)} />
            {conEseCuit.length > 0 && <span className="text-xs text-destructive">Ya hay un proveedor con ese CUIT.</span>}
          </div>
        </div>
        {parecidos.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-amber-600">¿Es alguno de éstos? Ya están cargados:</span>
            <div className="rounded-md border">
              {parecidos.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-muted-foreground">{s.code}</span> · {s.name}
                    <span className="ml-2 text-xs text-muted-foreground">{s.cuit ? `CUIT ${s.cuit}` : 'sin CUIT'}</span>
                  </span>
                  <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" disabled={guardando} onClick={() => onElegido(s)}>
                    Usar éste
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={guardando} onClick={onClose}>Cancelar</Button>
          <Button disabled={!puede} onClick={() => void crear()}>
            {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Crear proveedor
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ─────────────────────────── Crear artículo ─────────────────────────── */

const ETIQUETA_IVA: Record<string, string> = { '0.00': '0%', '10.50': '10,5%', '21.00': '21%', '27.00': '27%' }

/**
 * Alta de un artículo desde un renglón sin vínculo. Viene precargado con lo de
 * la factura: la descripción, el código de barras si el código leído lo es (el
 * código interno del proveedor no es el del comercio: si no, se escanea o se
 * genera uno interno), el costo por unidad (el precio de la factura con la
 * misma regla neto/IVA del pasaje a Compras), el proveedor de la factura y el
 * IVA. Usa el alta de Artículos de siempre (`articles:create`: código único,
 * mismo permiso) y el renglón queda vinculado al artículo nuevo.
 */
function CrearArticuloDialog({
  fila,
  tipo,
  modo,
  proveedor,
  articulos,
  onClose,
  onCreado,
  onElegido,
}: {
  fila: Fila
  /** null = el usuario todavía no eligió el tipo: el costo no se puede convertir, no se crea. */
  tipo: TipoComprobante | null
  modo: ModoPrecios
  proveedor: SupplierDTO | null
  /** Todos los artículos (también los dados de baja: el código no se puede repetir). */
  articulos: ArticleDTO[]
  onClose: () => void
  onCreado: (a: ArticleDTO) => void
  /** El código ya es de un artículo y el usuario prefiere vincular ése. */
  onElegido: (a: FacturaEscaneadaArticuloDTO) => void
}) {
  const precioFactura = aNumero(fila.precio)
  const datos = (vatRate?: string) =>
    datosArticuloNuevo(
      { codigo: fila.dto.codigo, descripcion: fila.dto.descripcion, precioUnitario: precioFactura, tasaIva: fila.dto.tasaIva ?? null },
      tipo,
      modo,
      vatRate,
    )
  const [inicial] = useState(() => datos())
  const [descripcion, setDescripcion] = useState(inicial.description)
  const [codigo, setCodigo] = useState(inicial.barcode)
  const [iva, setIva] = useState(inicial.vatRate)
  const [costo, setCosto] = useState(inicial.costPrice)
  const [costoEditado, setCostoEditado] = useState(false)
  const [precioVenta, setPrecioVenta] = useState('')
  const [guardando, setGuardando] = useState(false)

  const codigoLimpio = codigo.trim()
  const conEseCodigo = codigoLimpio ? (articulos.find((a) => a.barcode === codigoLimpio) ?? null) : null
  const costoNum = Number(costo)
  const costoValido = costo.trim() !== '' && Number.isFinite(costoNum) && costoNum >= 0
  const ventaNum = precioVenta.trim() === '' ? 0 : Number(precioVenta)
  const ventaValida = Number.isFinite(ventaNum) && ventaNum >= 0
  const puede = tipo !== null && descripcion.trim().length >= 2 && codigoLimpio !== '' && !conEseCodigo && costoValido && ventaValida && !guardando
  const convierte =
    tipo !== null && precioFactura !== null && precioFactura > 0 && Math.abs(costoParaCompras(precioFactura, Number(iva), tipo, modo) - precioFactura) > 0.00005

  function cambiarIva(v: string): void {
    setIva(v)
    // El costo sale del precio de la factura con la alícuota elegida (salvo que se lo haya escrito a mano).
    if (!costoEditado) setCosto(datos(v).costPrice)
  }

  async function crear(): Promise<void> {
    setGuardando(true)
    try {
      const nuevo = await api.articles.create({
        barcode: codigoLimpio,
        description: descripcion.trim().slice(0, 200),
        supplierId: proveedor?.id ?? null,
        costPrice: costoNum.toFixed(4),
        listPrice1: ventaNum.toFixed(4),
        vatRate: iva,
      })
      onCreado(nuevo)
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === 'CONSTRAINT' ? 'Ya hay un artículo con ese código.' : mensajeError(err))
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !guardando) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Crear artículo</DialogTitle>
          <DialogDescription>
            Renglón leído: <span className="font-medium text-foreground">{fila.dto.descripcion || '(sin descripción)'}</span>
            {fila.dto.codigo && <> · código del proveedor <span className="font-mono">{fila.dto.codigo}</span></>}. Controle los datos;
            el resto se completa después en Artículos.
          </DialogDescription>
        </DialogHeader>
        {tipo === null && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs font-semibold text-amber-700">
            Elija el tipo de comprobante en el encabezado antes de crear artículos: define si el costo leído es neto o final.
          </div>
        )}
        <div className="grid grid-cols-[8.5rem_1fr] items-center gap-x-3 gap-y-2">
          <Label htmlFor="art-desc">Descripción</Label>
          <Input id="art-desc" autoFocus maxLength={200} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />

          <Label htmlFor="art-codigo">Código de barras</Label>
          <div className="flex flex-col gap-1">
            <div className="flex gap-2">
              <Input
                id="art-codigo"
                className="font-mono"
                placeholder="Escanee o escriba el código"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0"
                title="Para productos sin código de barras: el próximo código interno libre."
                onClick={() => setCodigo(proximoCodigoInterno(articulos.map((a) => a.barcode)))}
              >
                Generar
              </Button>
            </div>
            {conEseCodigo ? (
              <span className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                Ya hay un artículo con ese código: {conEseCodigo.description}
                {conEseCodigo.active && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    onClick={() =>
                      onElegido({
                        id: conEseCodigo.id,
                        barcode: conEseCodigo.barcode,
                        description: conEseCodigo.description,
                        costPrice: conEseCodigo.costPrice,
                        active: conEseCodigo.active,
                      })
                    }
                  >
                    Vincular con ése
                  </Button>
                )}
              </span>
            ) : codigoLimpio === '' ? (
              <span className="text-xs text-muted-foreground">
                {fila.dto.codigo && !esCodigoDeBarras(fila.dto.codigo.trim())
                  ? 'El código de la factura es el interno del proveedor: escanee el del producto o genere uno.'
                  : 'Escanee el código del producto o genere uno interno.'}
              </span>
            ) : null}
          </div>

          <Label htmlFor="art-iva">IVA</Label>
          <Select id="art-iva" className="w-32" value={iva} onChange={(e) => cambiarIva(e.target.value)}>
            {ALICUOTAS_DE_ARTICULO.map((v) => (
              <option key={v} value={v}>{ETIQUETA_IVA[v]}</option>
            ))}
          </Select>

          <Label htmlFor="art-costo">{modo === 'net' ? 'Costo (neto)' : 'Costo (con IVA)'}</Label>
          <div className="flex flex-col gap-0.5">
            <CurrencyInput
              id="art-costo"
              className="w-40 text-right tabular-nums"
              value={costo}
              onChange={(v) => {
                setCosto(v)
                setCostoEditado(true)
              }}
            />
            {precioFactura !== null && (
              <span className="text-xs text-muted-foreground">
                Precio por unidad en la factura: {formatCurrency(precioFactura)}
                {convierte ? (tipo === 'A' ? ' (neto; se le suma el IVA)' : ' (final; se le descuenta el IVA)') : ''}.
              </span>
            )}
          </div>

          <Label>Proveedor</Label>
          <span className="text-sm">{proveedor ? `${proveedor.code} — ${proveedor.name}` : <span className="text-muted-foreground">Sin proveedor</span>}</span>

          <Label htmlFor="art-venta">Precio de venta</Label>
          <div className="flex flex-col gap-0.5">
            <CurrencyInput id="art-venta" className="w-40 text-right tabular-nums" placeholder="Opcional" value={precioVenta} onChange={setPrecioVenta} />
            {ventaNum === 0 && (
              <span className="text-xs text-amber-600">
                Sin precio de venta: cárguelo antes de venderlo (en Compras, con «Actualizar precios», o en Artículos).
              </span>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={guardando} onClick={onClose}>Cancelar</Button>
          <Button disabled={!puede} onClick={() => void crear()}>
            {guardando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Crear y vincular
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ─────────────────────────── Vincular artículo ─────────────────────────── */

function ArticuloPicker({
  fila,
  articulos,
  buscar,
  onClose,
  onSelect,
  onCrear,
  motivoNoCrear,
}: {
  fila: Fila
  articulos: ArticleDTO[]
  buscar: (a: ArticleDTO, q: string) => boolean
  onClose: () => void
  onSelect: (a: FacturaEscaneadaArticuloDTO | null) => void
  /** «Crear artículo» (sólo con permiso de Artículos). */
  onCrear?: () => void
  /** Por qué no se puede crear ahora (el botón queda deshabilitado con este texto). */
  motivoNoCrear?: string
}) {
  const [q, setQ] = useState('')
  const resultados = useMemo(() => {
    const v = q.trim().toLowerCase()
    if (v.length < 1) return []
    const rank = (a: ArticleDTO): number => {
      const bc = a.barcode.toLowerCase()
      return bc === v ? 0 : bc.startsWith(v) ? 1 : 2
    }
    return articulos
      .filter((a) => buscar(a, v))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, 100)
  }, [q, articulos, buscar])
  const elegir = (a: { id: string; barcode: string; description: string; costPrice: string; active: boolean }): void =>
    onSelect({ id: a.id, barcode: a.barcode, description: a.description, costPrice: a.costPrice, active: a.active })
  const precio = aNumero(fila.precio)

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Vincular artículo</DialogTitle>
          <DialogDescription>
            Renglón leído: <span className="font-medium text-foreground">{fila.dto.descripcion || '(sin descripción)'}</span>
            {fila.dto.codigo && <> · código <span className="font-mono">{fila.dto.codigo}</span></>}
            {precio !== null && <> · costo {formatCurrency(precio)}</>}
          </DialogDescription>
        </DialogHeader>

        {fila.dto.sugerencias.length > 0 && q.trim() === '' && (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sugerencias</span>
            <div className="rounded-md border">
              {fila.dto.sugerencias.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => elegir(s)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-muted-foreground">{s.barcode}</span> · {s.description}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">costo {formatCurrency(s.costPrice)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <Input autoFocus placeholder="Buscar por código, descripción o marca…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-72 overflow-auto rounded-md border">
          {q.trim() === '' ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Escriba para buscar en los artículos.</div>
          ) : resultados.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Sin resultados</div>
          ) : (
            resultados.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => elegir(a)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono text-xs text-muted-foreground">{a.barcode}</span> · {a.description}
                </span>
                {a.brand && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">{a.brand}</span>}
                <span className="shrink-0 tabular-nums text-muted-foreground">costo {formatCurrency(a.costPrice)}</span>
              </button>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Al registrar la compra, el sistema recuerda el código del proveedor (o la descripción, si no usa códigos): la próxima
          factura sale vinculada sola.
        </p>
        {(fila.articulo || onCrear) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {onCrear ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onCrear}
                disabled={motivoNoCrear !== undefined}
                title={motivoNoCrear ?? 'El producto no está en el sistema: se da de alta con los datos de la factura.'}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Crear artículo
              </Button>
            ) : (
              <span />
            )}
            {fila.articulo && (
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onSelect(null)}>
                <X className="mr-1 h-3.5 w-3.5" />
                Quitar el vínculo
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
