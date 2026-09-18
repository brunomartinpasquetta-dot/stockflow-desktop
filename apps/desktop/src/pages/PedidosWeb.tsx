/**
 * PEDIDOS WEB — la bandeja de lo que se vendió por el catálogo.
 *
 * Un pedido web no es una venta hasta que el comerciante lo confirma: recién
 * ahí descuenta stock, entra a la caja con la forma de pago que se elija y
 * queda en el historial como cualquier otra venta. No se convierten solos
 * porque un pedido de la madrugada no puede caer en una caja cerrada ni
 * adivinar cómo pagaron.
 */
import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  Inbox,
  Loader2,
  PackageX,
  RefreshCw,
  ShoppingBag,
  ShoppingCart,
  Truck,
  WifiOff,
} from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { formatCurrency, formatRelativeTime } from '@/lib/format'
import { useCompany } from '@/lib/hooks'
import { useWindowNav } from '@/lib/useWindowNav'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PaymentMethodSelect } from '@/components/PaymentMethodSelect'
import type { PedidoWebDTO } from '@/types/api'

function EstadoBadge({ p }: { p: PedidoWebDTO }) {
  if (p.ventaAnulada) return <Badge variant="destructive">Venta anulada — pedido cancelado</Badge>
  if (p.estado === 'convertido') return <Badge variant="success">Convertido en venta</Badge>
  if (p.estado === 'rechazado') return <Badge variant="outline">Rechazado</Badge>
  return <Badge variant="warning">Pendiente</Badge>
}

/**
 * Tarjeta compacta de resumen, mismo lenguaje visual que el resto del sistema
 * (Estadísticas): un dato grande, un rótulo chico, sin adorno de más.
 */
function Resumen({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof Inbox
  label: string
  value: string
  tone?: 'default' | 'warning' | 'success'
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5">
      <div
        className={
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full ' +
          (tone === 'warning'
            ? 'bg-amber-100 text-amber-700'
            : tone === 'success'
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-secondary text-muted-foreground')
        }
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-lg font-semibold tabular-nums">{value}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  )
}

function Pedido({ p, onCambio }: { p: PedidoWebDTO; onCambio: () => void }) {
  const [metodo, setMetodo] = useState<string>('')
  const metodosQuery = useQuery({ queryKey: ['paymentMethods'], queryFn: () => api.paymentMethods.list() })
  const metodos = (metodosQuery.data ?? []).filter((m) => m.active)
  const metodoMp = metodos.find((m) => m.type === 'mp')
  const openInWindow = useWindowNav()

  // Ya pagado en el catálogo (Mercado Pago): se registra con ese medio, sin
  // preguntarle al comerciante cómo lo cobró — ya se cobró.
  const metodoEfectivo = p.pagado && metodoMp ? metodoMp.id : metodo

  const convertir = useMutation({
    mutationFn: () => api.catalogo.pedidoConvertir(p.id, metodoEfectivo),
    onSuccess: (r) => {
      toast.success(`Venta ${r.ventaTipo} #${r.ventaNumero} registrada`)
      onCambio()
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo convertir', { duration: 12_000 }),
  })

  const rechazar = useMutation({
    mutationFn: () => api.catalogo.pedidoRechazar(p.id),
    onSuccess: () => {
      toast.success('Pedido rechazado — se le devolvió el stock al catálogo')
      onCambio()
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo rechazar'),
  })

  function cargarEnVentas(): void {
    openInWindow('ventas', {
      extras: {
        pedidoWebId: p.id,
        // Cambia en cada click: si Ventas ya está abierta, la URL nueva tiene
        // que ser distinta a la anterior para que la ventana reciba el pedido.
        nonce: Date.now(),
        notes: `Pedido web N° ${p.numero} — ${p.clienteNombre}`,
        prefilledLines: p.lineas.map((l) => ({
          articleId: l.articleId ?? undefined,
          description: l.articleId ? undefined : (l.nombreSistema ?? l.nombre),
          quantity: String(l.cantidad),
          unitPrice: String(l.precio),
        })),
      },
    })
  }

  const trabajando = convertir.isPending || rechazar.isPending
  const haySinPrecio = p.lineas.some((l) => l.sinPrecio)
  const haySinVincular = p.lineas.some((l) => l.articleId == null)
  const cantidadArticulos = p.lineas.reduce((acc, l) => acc + l.cantidad, 0)
  const esPendiente = p.estado === 'pendiente'

  return (
    <Card className={esPendiente ? 'border-amber-200' : undefined}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold">Pedido N° {p.numero}</span>
              <EstadoBadge p={p} />
              {p.pagado && <Badge variant="success">Pagado con Mercado Pago</Badge>}
            </div>
            <span className="text-sm font-medium">{p.clienteNombre}</span>
          </div>
          <div className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1" title={new Date(p.fecha).toLocaleString('es-AR')}>
              <Clock className="h-3 w-3" />
              {formatRelativeTime(p.fecha)}
            </span>
            {p.clienteTelefono && <span>{p.clienteTelefono}</span>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            {p.entrega === 'envio' ? <Truck className="h-3.5 w-3.5" /> : <ShoppingBag className="h-3.5 w-3.5" />}
            {p.entrega === 'envio' ? `Envío a ${p.direccion ?? 'domicilio sin indicar'}` : 'Retira en el local'}
          </span>
          <span>
            {cantidadArticulos} {cantidadArticulos === 1 ? 'artículo' : 'artículos'}
          </span>
        </div>
        {p.notas && <p className="text-sm italic text-muted-foreground">“{p.notas}”</p>}

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-medium">Cant.</th>
                <th className="px-3 py-1.5 text-left font-medium">Artículo</th>
                <th className="px-3 py-1.5 text-right font-medium">Precio</th>
                <th className="px-3 py-1.5 text-right font-medium">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {p.lineas.map((l, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-3 py-1.5 tabular-nums">{l.cantidad}</td>
                  <td className="px-3 py-1.5">
                    {l.nombreSistema ?? l.nombre}
                    {l.articleId == null && (
                      <Badge variant="warning" className="ml-2 align-middle text-[10px]">
                        sin vincular
                      </Badge>
                    )}
                    {l.stockActual != null && l.stockActual < l.cantidad && (
                      <span className="ml-2 text-xs text-destructive">stock actual: {l.stockActual}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {l.sinPrecio ? <span className="text-destructive">sin precio</span> : formatCurrency(String(l.precio))}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatCurrency(String(l.subtotal))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t pt-2.5">
          <span className="text-sm text-muted-foreground">Total del pedido</span>
          <span className="text-lg font-semibold tabular-nums">{formatCurrency(p.total)}</span>
        </div>

        {p.ventaAnulada ? (
          <p className="text-xs text-muted-foreground">
            La venta se anuló: el stock volvió al sistema y el pedido quedó cancelado en el catálogo.
          </p>
        ) : (
          p.estado === 'convertido' && (
            <p className="text-xs text-muted-foreground">
              Registrado como venta{p.saleId ? '' : ' (ver Historial de Ventas)'}.
            </p>
          )
        )}

        {esPendiente && (
          <>
            {haySinPrecio && (
              <p className="text-xs text-destructive">
                Hay artículos sin precio. Cárguelos en el catálogo antes de convertir el pedido.
              </p>
            )}
            {haySinVincular && !haySinPrecio && (
              <p className="text-xs text-amber-600">
                Hay artículos que no existen en el sistema: se van a cobrar igual, pero sin mover stock.
              </p>
            )}
            {p.pagado && !metodoMp && (
              <p className="text-xs text-amber-600">
                Ya está pagado con Mercado Pago, pero no hay un medio de pago "Mercado Pago"
                cargado en Medios de pago. Elegí uno para poder registrarlo.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              {p.pagado ? (
                <>
                  {!metodoMp && (
                    <div className="flex min-w-56 flex-1 flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">Cómo lo pagó</span>
                      <PaymentMethodSelect methods={metodos} value={metodo || null} onChange={setMetodo} />
                    </div>
                  )}
                  <Button disabled={trabajando || !metodoEfectivo || haySinPrecio} onClick={() => convertir.mutate()}>
                    {convertir.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Registrar venta
                  </Button>
                </>
              ) : (
                <Button disabled={trabajando || haySinPrecio} onClick={cargarEnVentas}>
                  <ShoppingCart className="h-4 w-4" />
                  Cargar en Ventas
                </Button>
              )}
              <Button
                variant="outline"
                disabled={trabajando}
                onClick={() => {
                  if (window.confirm(`¿Rechazar el pedido N° ${p.numero}? Se le devuelve el stock al catálogo.`)) {
                    rechazar.mutate()
                  }
                }}
              >
                <PackageX className="h-4 w-4" />
                Rechazar
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function PedidosWeb() {
  const qc = useQueryClient()
  const [verTodos, setVerTodos] = useState(false)

  const config = useQuery({ queryKey: ['catalogo', 'syncEstado'], queryFn: () => api.catalogo.syncEstado() })
  const catalogoConfigurado = config.data != null

  const pedidos = useQuery({
    queryKey: ['catalogo', 'pedidos', verTodos],
    queryFn: () => api.catalogo.pedidosListar(verTodos ? undefined : 'pendiente'),
    refetchInterval: 30_000,
  })

  const buscar = useMutation({
    mutationFn: () => api.catalogo.syncAhora(false),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['catalogo', 'pedidos'] })
      void qc.invalidateQueries({ queryKey: ['catalogo', 'pedidosContarPendientes'] })
      if (!r.ok) toast.error(`No se pudo consultar el catálogo: ${r.motivo ?? 'error desconocido'}`, { duration: 10_000 })
      else toast.success('Consulta al catálogo hecha')
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo consultar el catálogo'),
  })

  const recargar = (): void => {
    void qc.invalidateQueries({ queryKey: ['catalogo', 'pedidos'] })
    void qc.invalidateQueries({ queryKey: ['catalogo', 'pedidosContarPendientes'] })
  }

  const lista = pedidos.data ?? []

  // Los pendientes siempre arriba: son los que requieren una decisión.
  const ordenados = useMemo(
    () =>
      [...lista].sort((a, b) => {
        if (a.estado === 'pendiente' && b.estado !== 'pendiente') return -1
        if (a.estado !== 'pendiente' && b.estado === 'pendiente') return 1
        return b.fecha - a.fecha
      }),
    [lista],
  )

  const pendientesHoy = lista.filter((p) => p.estado === 'pendiente')
  const totalPendiente = pendientesHoy.reduce((acc, p) => acc + Number(p.total || 0), 0)
  const convertidosVisibles = verTodos ? lista.filter((p) => p.estado === 'convertido').length : null

  // La tienda tal como la ve el cliente: la dirección pública si se cargó una
  // distinta, si no la misma del catálogo (en producción son el mismo dominio).
  const company = useCompany()
  const tiendaUrl = (company.data?.catalogoWebUrl || company.data?.catalogoUrl || '').trim().replace(/\/$/, '')
  const [pestana, setPestana] = useState<'pedidos' | 'tienda'>('pedidos')
  // La tienda se carga recién la primera vez que se abre la pestaña y después
  // queda viva: cambiar de pestaña no la recarga.
  const [tiendaVista, setTiendaVista] = useState(false)
  const webviewRef = useRef<HTMLElement | null>(null)

  return (
    <Tabs
      value={pestana}
      onValueChange={(v) => {
        setPestana(v as 'pedidos' | 'tienda')
        if (v === 'tienda') setTiendaVista(true)
      }}
      className="flex h-full flex-col gap-3 overflow-hidden p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Catálogo web</h1>
          <p className="text-sm text-muted-foreground">
            {pestana === 'tienda'
              ? 'La tienda del comercio, tal como la ve el cliente.'
              : 'Lo que se compró en el catálogo, a la espera de convertirse en venta.'}
          </p>
        </div>
        <TabsList>
          <TabsTrigger value="pedidos">
            Pedidos web
            {pendientesHoy.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">
                {pendientesHoy.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="tienda">
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            Ver catálogo
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="pedidos" className="mt-0 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-primary"
              checked={verTodos}
              onChange={(e) => setVerTodos(e.target.checked)}
            />
            Ver también los ya resueltos
          </label>
          <Button size="sm" variant="outline" disabled={buscar.isPending} onClick={() => buscar.mutate()}>
            {buscar.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Buscar pedidos nuevos
          </Button>
        </div>
      </div>

      {!config.isLoading && !catalogoConfigurado && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            El catálogo web todavía no está configurado. Cargá la dirección y la clave en{' '}
            <span className="font-medium">Mi Empresa → Catálogo web</span> para empezar a recibir pedidos.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Resumen icon={Clock} label="Pedidos pendientes" value={String(pendientesHoy.length)} tone={pendientesHoy.length > 0 ? 'warning' : 'default'} />
        <Resumen icon={ShoppingBag} label="Monto por confirmar" value={formatCurrency(String(totalPendiente))} tone={totalPendiente > 0 ? 'warning' : 'default'} />
        {verTodos && convertidosVisibles != null && (
          <Resumen icon={CheckCircle2} label="Convertidos en venta" value={String(convertidosVisibles)} tone="success" />
        )}
      </div>

      {pedidos.isLoading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!pedidos.isLoading && lista.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
          <Inbox className="h-8 w-8 opacity-50" />
          <p className="text-sm">
            {verTodos ? 'Todavía no entró ningún pedido por el catálogo.' : 'No hay pedidos pendientes.'}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {ordenados.map((p) => (
          <Pedido key={p.id} p={p} onCambio={recargar} />
        ))}
      </div>
      </TabsContent>

      {/* forceMount: la tienda no se destruye al volver a Pedidos (el global
          data-[state=inactive]:hidden de Tabs la esconde). */}
      <TabsContent value="tienda" forceMount className="mt-0 flex min-h-0 flex-1 flex-col gap-2">
        {!tiendaUrl ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center text-muted-foreground">
            <Globe className="h-8 w-8 opacity-50" />
            <p className="text-sm">
              Falta la dirección del catálogo. Cargala en <span className="font-medium">Mi Empresa → Catálogo web</span>.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate font-mono">{tiendaUrl}</span>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const wv = webviewRef.current as (HTMLElement & { reload?: () => void }) | null
                  wv?.reload?.()
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Recargar
              </Button>
              <Button size="sm" variant="outline" onClick={() => void api.system.openExternal(tiendaUrl)}>
                <ExternalLink className="h-3.5 w-3.5" />
                Abrir en el navegador
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded-md border bg-white">
              {tiendaVista && (
                <webview
                  ref={webviewRef}
                  src={tiendaUrl}
                  partition="persist:catalogo"
                  style={{ width: '100%', height: '100%' }}
                />
              )}
            </div>
          </>
        )}
      </TabsContent>
    </Tabs>
  )
}
