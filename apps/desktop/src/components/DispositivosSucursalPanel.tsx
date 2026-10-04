/**
 * PC DE SUCURSAL (multisucursal) — en la PC servidor.
 *
 * El administrador genera un código de un solo uso (vence a los 15 minutos)
 * y se lo pasa a la sucursal junto con la dirección web y el usuario con que
 * va a trabajar esa PC (el panel muestra los tres datos, avisa si el Acceso
 * remoto no está encendido y arma el mensaje para mandar entero). La PC de la
 * sucursal los carga al instalar StockFlow («Conectar esta PC a la casa
 * central», en la Activación o en la Bienvenida) o en Configuración → Red
 * local → Cliente → Desde otro local. Queda emparejada: por internet
 * trabaja como una caja del local (factura y cobra con Mercado Pago). Desde
 * acá se ve la lista y se revoca cualquiera; la revocación corta en la
 * operación siguiente.
 *
 * Se muestra con la licencia Multisucursal (lo decide quien lo monta). Si el
 * comercio bajó a la licencia común y quedaron PC activas, se monta en modo
 * `soloRevocar`: sin "Generar código", sólo la lista y Revocar. Si no, esas
 * PC quedaban sin pantalla y revivían solas al volver a Multisucursal.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Copy, Loader2 } from 'lucide-react'

import { armarMensajeSucursal, ENLACE_CONECTAR_PC } from '../../electron/lan/mensaje-sucursal'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
import type { DispositivoSucursalDTO } from '@/types/api'

function fecha(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

function copiar(texto: string, que: string): void {
  void navigator.clipboard.writeText(texto).then(
    () => toast.success(`${que} copiado`),
    () => toast.error('No se pudo copiar'),
  )
}

export function DispositivosSucursalPanel({
  soloRevocar = false,
  irAAccesoRemoto,
}: { soloRevocar?: boolean; irAAccesoRemoto?: () => void } = {}) {
  const qc = useQueryClient()
  // La sucursal entra por el Acceso remoto de esta PC: sin él no hay por dónde.
  const remoto = useQuery({
    queryKey: ['lan', 'remoto'],
    queryFn: () => api.lan.remotoEstado(),
    enabled: !soloRevocar,
    refetchInterval: 15_000,
  })
  const er = remoto.data
  const direccionRemota =
    er?.aprovisionado && er.direccion && (er.estado === 'conectado' || er.estado === 'conectando') ? er.direccion : null
  const problemaRemoto = !er?.aprovisionado
    ? 'El Acceso remoto no está activado: sin él, las sucursales no pueden conectarse.'
    : er.estado === 'error'
      ? 'El Acceso remoto tiene problemas para conectarse: revíselo antes de pasar la dirección.'
      : 'El Acceso remoto está apagado: sin él, las sucursales no pueden conectarse.'
  const lista = useQuery({
    queryKey: ['lan', 'dispositivos'],
    queryFn: () => api.lan.dispositivosListar(),
    refetchInterval: 30_000,
  })
  const [codigo, setCodigo] = useState<{ codigo: string; venceEn: number } | null>(null)
  const [aRevocar, setARevocar] = useState<DispositivoSucursalDTO | null>(null)
  // Reloj para tachar el código cuando vence (sin leer la hora en el render).
  const [ahora, setAhora] = useState(() => Date.now())
  useEffect(() => {
    if (!codigo) return
    const t = setInterval(() => setAhora(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [codigo])

  const generar = useMutation({
    mutationFn: () => api.lan.emparejarGenerarCodigo(),
    onSuccess: (c) => {
      setAhora(Date.now())
      setCodigo(c)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo generar el código'),
  })

  const revocar = useMutation({
    mutationFn: (id: string) => api.lan.dispositivoRevocar(id),
    onSuccess: async () => {
      toast.success('PC revocada: deja de trabajar con la casa central apenas intente la próxima operación.')
      setARevocar(null)
      await qc.invalidateQueries({ queryKey: ['lan', 'dispositivos'] })
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo revocar'),
  })

  const vencido = codigo ? codigo.venceEn <= ahora : false

  return (
    // id: la pestaña Sucursales («Conectar una PC de otro local») baja hasta acá.
    <div id="pc-de-sucursal" className="flex scroll-mt-4 flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">PC de sucursal</span>
        {!soloRevocar && (
          <Button variant="outline" size="sm" type="button" onClick={() => generar.mutate()} disabled={generar.isPending}>
            {generar.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
            Generar código
          </Button>
        )}
      </div>
      {soloRevocar ? (
        <p className="text-xs text-muted-foreground">
          El comercio ya no tiene la licencia Multisucursal: estas PC no operan como sucursal. Si ya no se usan,
          revóquelas; si no, volverían a operar al renovar la licencia.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 text-xs">
          <p className="text-muted-foreground">
            Para conectar una PC de otro local, pásele estos tres datos. Se cargan en esa PC con «{ENLACE_CONECTAR_PC}»,
            al instalar StockFlow.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">1. Dirección:</span>
            {direccionRemota ? (
              <>
                <span className="font-mono">{direccionRemota}</span>
                {er?.estado === 'conectando' && <span className="text-muted-foreground">(conectando…)</span>}
                <Button variant="outline" size="sm" type="button" className="h-6 px-2" onClick={() => copiar(direccionRemota, 'Dirección')}>
                  <Copy className="mr-1 h-3 w-3" /> Copiar
                </Button>
              </>
            ) : remoto.isLoading ? (
              <span className="text-muted-foreground">…</span>
            ) : (
              <span className="flex flex-wrap items-center gap-1">
                <span className="text-destructive">{problemaRemoto}</span>
                {irAAccesoRemoto && (
                  <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={irAAccesoRemoto}>
                    Ir a Acceso remoto
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">2. Código:</span>
            <span className="text-muted-foreground">
              genérelo recién cuando la PC de la sucursal ya muestre «{ENLACE_CONECTAR_PC}». Sirve una sola vez y vence a
              los 15 minutos.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">3. Usuario:</span>
            <span className="text-muted-foreground">
              el usuario y la contraseña con que va a trabajar esa PC (se crean en Usuarios).
            </span>
          </div>
        </div>
      )}
      {codigo && (
        <div className="flex flex-wrap items-center gap-3 rounded border bg-background px-3 py-2">
          <span className={cn('font-mono text-lg font-semibold tracking-widest', vencido && 'text-muted-foreground line-through')}>
            {codigo.codigo}
          </span>
          <span className="flex-1 text-xs text-muted-foreground">
            {vencido ? 'Vencido: genere otro' : `Vence a las ${new Date(codigo.venceEn).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`}
          </span>
          {!vencido && (
            <Button variant="outline" size="sm" type="button" className="h-6 px-2" onClick={() => copiar(codigo.codigo, 'Código')}>
              <Copy className="mr-1 h-3 w-3" /> Copiar
            </Button>
          )}
          {/* Los datos en un solo mensaje, con dónde se cargan: la PC de la
              sucursal lo entiende si se pega entero en cualquiera de los dos
              campos. Sin dirección (Acceso remoto apagado) no hay mensaje. */}
          {!vencido && direccionRemota && (
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="h-6 px-2"
              onClick={() => copiar(armarMensajeSucursal(direccionRemota, codigo.codigo, codigo.venceEn), 'Mensaje')}
            >
              <Copy className="mr-1 h-3 w-3" /> Copiar mensaje para la sucursal
            </Button>
          )}
        </div>
      )}
      {(lista.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">Todavía no hay PC de sucursal emparejadas.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {(lista.data ?? []).map((d) => (
            <div key={d.id} className="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-xs">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', d.estado === 'activo' ? 'bg-success' : 'bg-muted-foreground')} />
              <span className="font-medium">{d.nombre}</span>
              <span className="text-muted-foreground">Estado: {d.estado === 'activo' ? 'Activa' : 'Revocada'}</span>
              {/* Los datos técnicos (red, identificadores) quedan en el
                  recuadro que aparece al pasar el mouse: sirven a soporte,
                  no al comerciante. */}
              <span
                className="flex-1 truncate text-muted-foreground"
                title={`Red: ${d.ultimaIp ?? '—'} · Dispositivo ${d.idCorto} · PC ${d.pcCorta}… · Emparejada desde: ${d.creadoDesde ?? '—'}`}
              >
                Emparejada: {fecha(d.creadoEn)} · Último uso: {fecha(d.ultimoUsoEn)}
              </span>
              {d.estado === 'activo' && (
                <Button variant="outline" size="sm" type="button" onClick={() => setARevocar(d)}>
                  Revocar
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={aRevocar !== null} onOpenChange={(o) => !o && setARevocar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Revocar «{aRevocar?.nombre}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Esa PC deja de trabajar con la casa central apenas intente la próxima operación. Para volver a usarla habrá
              que conectarla con un código nuevo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => aRevocar && revocar.mutate(aRevocar.id)} disabled={revocar.isPending}>
              Revocar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
