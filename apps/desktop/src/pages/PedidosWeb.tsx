/**
 * PEDIDOS WEB — la bandeja de lo que se vendió por el catálogo.
 *
 * Un pedido web no es una venta hasta que el comerciante lo confirma: recién
 * ahí descuenta stock, entra a la caja con la forma de pago que se elija y
 * queda en el historial como cualquier otra venta. No se convierten solos
 * porque un pedido de la madrugada no puede caer en una caja cerrada ni
 * adivinar cómo pagaron.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, PackageX, RefreshCw, ShoppingBag, Truck } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { formatCurrency, formatDateTime } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { PaymentMethodSelect } from '@/components/PaymentMethodSelect'
import type { PedidoWebDTO } from '@/types/api'

function EstadoBadge({ estado }: { estado: PedidoWebDTO['estado'] }) {
  if (estado === 'convertido') return <Badge variant="outline">Convertido en venta</Badge>
  if (estado === 'rechazado') return <Badge variant="outline">Rechazado</Badge>
  return <Badge variant="warning">Pendiente</Badge>
}

function Pedido({ p, onCambio }: { p: PedidoWebDTO; onCambio: () => void }) {
  const [metodo, setMetodo] = useState<string>('')
  const metodosQuery = useQuery({ queryKey: ['paymentMethods'], queryFn: () => api.paymentMethods.list() })
  const metodos = (metodosQuery.data ?? []).filter((m) => m.active)

  const convertir = useMutation({
    mutationFn: () => api.catalogo.pedidoConvertir(p.id, metodo),
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

  const trabajando = convertir.isPending || rechazar.isPending
  const haySinPrecio = p.lineas.some((l) => l.sinPrecio)
  const haySinVincular = p.lineas.some((l) => l.articleId == null)

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold">Pedido N° {p.numero}</span>
            <EstadoBadge estado={p.estado} />
          </div>
          <span className="text-xs text-muted-foreground">{formatDateTime(p.fecha)}</span>
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span className="font-medium">{p.clienteNombre}</span>
          {p.clienteTelefono && <span className="text-muted-foreground">{p.clienteTelefono}</span>}
          <span className="flex items-center gap-1 text-muted-foreground">
            {p.entrega === 'envio' ? <Truck className="h-3.5 w-3.5" /> : <ShoppingBag className="h-3.5 w-3.5" />}
            {p.entrega === 'envio' ? `Envío a ${p.direccion ?? 'domicilio sin indicar'}` : 'Retira en el local'}
          </span>
        </div>
        {p.notas && <p className="text-sm italic text-muted-foreground">“{p.notas}”</p>}

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <tbody>
              {p.lineas.map((l, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-3 py-1.5 tabular-nums">{l.cantidad}</td>
                  <td className="px-3 py-1.5">
                    {l.nombreSistema ?? l.nombre}
                    {l.articleId == null && (
                      <span className="ml-2 text-xs text-amber-600">sin vincular al sistema</span>
                    )}
                    {l.stockActual != null && l.stockActual < l.cantidad && (
                      <span className="ml-2 text-xs text-destructive">
                        stock actual: {l.stockActual}
                      </span>
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

        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Total del pedido</span>
          <span className="text-lg font-semibold tabular-nums">{formatCurrency(p.total)}</span>
        </div>

        {p.estado === 'pendiente' && (
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
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Cómo lo pagó</span>
                <PaymentMethodSelect methods={metodos} value={metodo || null} onChange={setMetodo} />
              </div>
              <Button disabled={trabajando || !metodo || haySinPrecio} onClick={() => convertir.mutate()}>
                {convertir.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Confirmar y registrar la venta
              </Button>
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
  const pedidos = useQuery({
    queryKey: ['catalogo', 'pedidos', verTodos],
    queryFn: () => api.catalogo.pedidosListar(verTodos ? undefined : 'pendiente'),
    refetchInterval: 30_000,
  })

  const buscar = useMutation({
    mutationFn: () => api.catalogo.syncAhora(false),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['catalogo', 'pedidos'] })
      toast.success('Consulta al catálogo hecha')
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo consultar el catálogo'),
  })

  const recargar = (): void => {
    void qc.invalidateQueries({ queryKey: ['catalogo', 'pedidos'] })
  }

  const lista = pedidos.data ?? []

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Pedidos web</h1>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={verTodos} onChange={(e) => setVerTodos(e.target.checked)} />
            Ver también los ya resueltos
          </label>
          <Button size="sm" variant="outline" disabled={buscar.isPending} onClick={() => buscar.mutate()}>
            {buscar.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Buscar pedidos nuevos
          </Button>
        </div>
      </div>

      {pedidos.isLoading && <p className="text-sm text-muted-foreground">Cargando…</p>}

      {!pedidos.isLoading && lista.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {verTodos ? 'Todavía no entró ningún pedido por el catálogo.' : 'No hay pedidos pendientes.'}
        </p>
      )}

      <div className="flex flex-col gap-3">
        {lista.map((p) => (
          <Pedido key={p.id} p={p} onCambio={recargar} />
        ))}
      </div>
    </div>
  )
}
