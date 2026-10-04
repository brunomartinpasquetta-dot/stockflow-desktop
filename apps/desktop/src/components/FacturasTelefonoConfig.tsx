/**
 * Configuración → "Facturas por teléfono": activar la carga de facturas de
 * compra con la cámara del teléfono (ver docs/PLAN_FACTURAS_TELEFONO.md).
 * Acá sólo se activa y se elige «Mejorar lectura»: el teléfono se vincula
 * desde Compras («Cargar con el teléfono»).
 *
 * Apagado por defecto. Al activarlo, esta PC recibe las fotos y las lee con el
 * lector de texto del sistema operativo (al instante, sin instalar nada). La
 * casilla «Mejorar lectura» cambia a un lector más preciso y mucho más lento
 * (Ollama, 1,6 GB): recién ahí se muestra el estado de Ollama y la descarga.
 * Nada sale a internet.
 *
 * En un puesto de la red sólo se ve el estado: las fotos las recibe y las lee
 * la PC servidor, y ahí es donde se activa y se descarga el lector.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { mensajeError } from '@/lib/mensajeError'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useLanMode } from '@/contexts/LanContext'
import type { EstadoFacturasDTO } from '@/types/api'

function Barra({ fraccion }: { fraccion: number | null }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
      <div
        className={cn('h-full bg-primary transition-all', fraccion == null && 'w-1/3 animate-pulse')}
        style={fraccion != null ? { width: `${Math.round(fraccion * 100)}%` } : undefined}
      />
    </div>
  )
}

/** Un estado, una palabra (`valor`); lo que haya que aclarar va en `detalle`, en una línea aparte. */
function Fila({ etiqueta, valor, ok, detalle }: { etiqueta: string; valor: string; ok: boolean; detalle?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{etiqueta}</span>
        <span className={cn('font-medium', ok ? 'text-success' : 'text-foreground')}>{valor}</span>
      </div>
      {detalle && <span className="text-right text-xs text-muted-foreground">{detalle}</span>}
    </div>
  )
}

export function FacturasTelefonoConfig() {
  const qc = useQueryClient()
  const esPuesto = useLanMode() === 'client'

  const estado = useQuery({
    queryKey: ['facturas', 'estado'],
    queryFn: () => api.facturas.estado(),
    retry: false,
    // Mientras descarga el lector o lee una factura, se refresca seguido.
    refetchInterval: (q) => {
      const e = q.state.data as EstadoFacturasDTO | undefined
      return e?.descarga != null || e?.cola.leyendo != null ? 1500 : 8000
    },
  })
  const e = estado.data

  const configurar = useMutation({
    mutationFn: (cambios: { activo?: boolean; mejorLectura?: boolean }) => api.facturas.configurar(cambios),
    onSuccess: (nuevo) => {
      qc.setQueryData(['facturas', 'estado'], nuevo)
      void qc.invalidateQueries({ queryKey: ['facturas'] })
    },
    onError: (err) => toast.error(mensajeError(err)),
  })
  const descargar = useMutation({
    mutationFn: () => api.facturas.descargarLector(),
    onSuccess: (nuevo) => qc.setQueryData(['facturas', 'estado'], nuevo),
    onError: (err) => toast.error(mensajeError(err)),
  })

  if (estado.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 pt-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Consultando el estado…
        </CardContent>
      </Card>
    )
  }
  if (!e) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          {estado.error ? mensajeError(estado.error) : 'No se pudo consultar el estado de las facturas por teléfono.'}
        </CardContent>
      </Card>
    )
  }

  const bloqueado = esPuesto || configurar.isPending
  const conSistema = e.lectorSistema.disponible
  // Ollama hace falta sólo con «Mejorar lectura», o si esta PC no tiene lector del sistema.
  const usaOllama = e.mejorLectura || !conSistema
  const ollamaListo = e.ollama.disponible && e.lector.descargado
  const lectorListo = conSistema || ollamaListo
  const leyendo = e.cola.leyendo

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold">Facturas de compra por teléfono</h2>
          <p className="text-xs text-muted-foreground">
            Se fotografían las hojas de la factura del proveedor con el teléfono y el sistema lee los renglones. La carga se
            hace desde Compras, con «Cargar con el teléfono»: la factura completa el formulario de compra (o se abre su
            revisión si hace falta). La compra siempre la confirma el usuario: el sistema no registra ninguna por su cuenta.
          </p>
        </div>

        {esPuesto && (
          <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            Esta PC es un puesto de la red: las fotos las recibe y las lee la PC servidor. La función se activa y el lector se
            descarga allí.
          </div>
        )}

        <label
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
            e.activo ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
            bloqueado && 'cursor-not-allowed opacity-70',
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-input"
            checked={e.activo}
            disabled={bloqueado}
            onChange={(ev) => configurar.mutate({ activo: ev.target.checked })}
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Activar las facturas por teléfono</span>
            <span className="text-xs text-muted-foreground">
              Al activarlo, esta PC acepta fotos de los teléfonos vinculados por la red del local. La primera vez, Windows puede
              pedir permiso en el Firewall: debe aceptarse para redes privadas.
            </span>
          </span>
        </label>

        {e.activo && (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <Fila
              etiqueta="Lector"
              valor={conSistema ? 'Incluido en el sistema' : 'Ausente'}
              detalle={conSistema ? 'Lee cada hoja al instante. No requiere instalar nada.' : undefined}
              ok={conSistema}
            />
            {!conSistema && (
              <p className="text-xs text-muted-foreground">
                Esta computadora no tiene lector de texto del sistema: las facturas se leen con el lector de Ollama, que se
                instala y se descarga aquí abajo.
              </p>
            )}

            {conSistema && (
              <label
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
                  e.mejorLectura ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                  bloqueado && 'cursor-not-allowed opacity-70',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-input"
                  checked={e.mejorLectura}
                  disabled={bloqueado}
                  onChange={(ev) => configurar.mutate({ mejorLectura: ev.target.checked })}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">Mejorar lectura</span>
                  <span className="text-xs text-muted-foreground">
                    {e.mejorLectura
                      ? 'Esta opción lee con más precisión las facturas difíciles, pero cada hoja puede demorar varios minutos según la computadora. La lectura se hace de fondo: puede seguir trabajando y el sistema le avisa cuando la factura está lista. Requiere una descarga de 1,6 GB.'
                      : 'Lee con más precisión las facturas difíciles. Es opcional.'}
                  </span>
                </span>
              </label>
            )}

            {usaOllama && (
              <Fila
                etiqueta="Ollama"
                valor={e.ollama.disponible ? 'Instalado' : 'Ausente'}
                detalle={e.ollama.disponible && e.ollama.version ? `Versión ${e.ollama.version}` : undefined}
                ok={e.ollama.disponible}
              />
            )}
            {usaOllama && !e.ollama.disponible && (
              <p className="text-xs text-muted-foreground">
                Ollama es el programa que hace funcionar {conSistema ? 'la lectura mejorada' : 'el lector'}. Se instala desde la
                pestaña «Flowy con IA» (no hace falta activar a Flowy) y debe estar abierto en esta PC.
                {conSistema && ' Mientras tanto, las facturas se leen con el lector del sistema.'}
              </p>
            )}

            {usaOllama && e.ollama.disponible && (
              <>
                <Fila
                  etiqueta={conSistema ? 'Lectura mejorada' : 'Lector de Ollama'}
                  valor={e.lector.descargado ? 'Descargado' : 'Pendiente'}
                  ok={e.lector.descargado}
                />
                {e.descarga ? (
                  <div className="flex flex-col gap-1">
                    <Barra fraccion={e.descarga.fraccion} />
                    <span className="text-xs text-muted-foreground">
                      Descargando el lector
                      {e.descarga.total > 0
                        ? `: ${Math.round(e.descarga.bytes / 1048576)} de ${Math.round(e.descarga.total / 1048576)} MB`
                        : '…'}
                    </span>
                  </div>
                ) : (
                  !e.lector.descargado && (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        El lector se descarga una sola vez. Con una conexión lenta puede tardar bastante.
                        {conSistema && ' Mientras tanto, las facturas se leen con el lector del sistema.'}
                      </p>
                      <div>
                        <Button size="sm" onClick={() => descargar.mutate()} disabled={esPuesto || descargar.isPending}>
                          {descargar.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                          Descargar lector (1,6 GB)
                        </Button>
                      </div>
                    </div>
                  )
                )}
              </>
            )}

            <Fila
              etiqueta="Recepción de fotos"
              valor={e.servidorFotos.puerto != null ? 'Activa' : 'Inactiva'}
              detalle={e.servidorFotos.puerto != null ? `Puerto ${e.servidorFotos.puerto}` : undefined}
              ok={e.servidorFotos.puerto != null}
            />
            {e.servidorFotos.error && <p className="text-xs text-destructive">{e.servidorFotos.error}</p>}

            <Fila
              etiqueta="Lectura"
              valor={leyendo ? 'Leyendo' : e.cola.enCola > 0 ? 'Pendiente' : 'Libre'}
              detalle={
                leyendo
                  ? `Leyendo hoja ${Math.min(leyendo.hoja, leyendo.hojas)} de ${leyendo.hojas}${leyendo.lento ? ', puede demorar unos minutos' : ''}${e.cola.enCola > 0 ? ` · ${e.cola.enCola} en cola` : ''}`
                  : e.cola.enCola > 0
                    ? `${e.cola.enCola} en cola`
                    : undefined
              }
              ok={false}
            />
            {leyendo && <Barra fraccion={leyendo.hojas > 0 ? Math.max(0, leyendo.hoja - 1) / leyendo.hojas : null} />}
            {(leyendo?.lento || (e.mejorLectura && ollamaListo)) && (
              <p className="text-xs text-muted-foreground">
                Con «Mejorar lectura», cada hoja puede demorar varios minutos según la computadora. Se puede seguir trabajando
                mientras tanto.
              </p>
            )}

            <Fila etiqueta="Estado" valor={lectorListo ? 'Listo' : 'Incompleto'} ok={lectorListo} />
            {e.ultimoError && !e.descarga && <p className="text-xs text-destructive">{e.ultimoError}</p>}

            <p className="text-xs text-muted-foreground">
              Para cargar una factura: Compras → «Cargar con el teléfono». Las facturas recibidas se ven en Compras → «Facturas
              escaneadas».
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
