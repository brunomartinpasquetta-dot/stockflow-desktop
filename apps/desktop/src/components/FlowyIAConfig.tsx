/**
 * Configuración → "Flowy con IA": activar la inteligencia artificial LOCAL de
 * Flowy (Ollama). Gratis, sin clave y sin internet para responder.
 *
 * Tres modos:
 *  - Apagado: el motor de siempre.
 *  - Entender (recomendado): encuentra el tema aunque la pregunta esté escrita
 *    de otra forma. Liviano.
 *  - Conversar: además redacta la respuesta. Necesita una PC con más memoria.
 *
 * En un puesto de la red sólo se ve el estado: Flowy responde desde la PC
 * servidor, y ahí es donde se instala y se configura.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { mensajeError } from '@/lib/mensajeError'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useLanMode } from '@/contexts/LanContext'
import type { EstadoIADTO, ModoIADTO } from '@/types/api'

const MODOS: { valor: ModoIADTO; titulo: string; detalle: string }[] = [
  { valor: 'apagado', titulo: 'Apagado', detalle: 'Flowy responde con su buscador de siempre.' },
  {
    valor: 'entender',
    titulo: 'Entender (recomendado)',
    detalle:
      'La IA encuentra el tema aunque la pregunta esté escrita de otra forma, y Flowy responde con su ficha revisada. Responde en menos de un segundo en cualquier PC. Descarga: 340 MB.',
  },
  {
    valor: 'conversar',
    titulo: 'Conversar (en prueba)',
    detalle:
      'Además, la IA redacta la respuesta con sus palabras. En una PC sin placa de video tarda entre 20 y 60 segundos por respuesta, y a veces inventa pasos o nombres de botones. No se recomienda para el uso diario. Descarga adicional: 1,4 GB.',
  },
]

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

function Fila({ etiqueta, valor, ok }: { etiqueta: string; valor: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{etiqueta}</span>
      <span className={cn('font-medium', ok ? 'text-success' : 'text-foreground')}>{valor}</span>
    </div>
  )
}

export function FlowyIAConfig() {
  const qc = useQueryClient()
  const esPuesto = useLanMode() === 'client'
  const [prueba, setPrueba] = useState<string | null>(null)

  const estado = useQuery({
    queryKey: ['assistant', 'iaEstado'],
    queryFn: () => api.assistant.iaEstado(),
    // Mientras descarga, instala o prepara, se refresca seguido.
    refetchInterval: (q) => {
      const e = q.state.data as EstadoIADTO | undefined
      const ocupado =
        e?.descarga != null ||
        e?.indice.estado === 'armando' ||
        e?.instalacion?.estado === 'descargando' ||
        e?.instalacion?.estado === 'instalando'
      return ocupado ? 1500 : 8000
    },
  })
  const e = estado.data

  const refrescar = (): void => void qc.invalidateQueries({ queryKey: ['assistant', 'iaEstado'] })

  const configurar = useMutation({
    mutationFn: (modo: ModoIADTO) => api.assistant.iaConfigurar({ modo }),
    onSuccess: (nuevo) => {
      qc.setQueryData(['assistant', 'iaEstado'], nuevo)
      setPrueba(null)
    },
    onError: (err) => toast.error(mensajeError(err)),
  })
  const descargar = useMutation({
    mutationFn: () => api.assistant.iaDescargar(),
    onSuccess: refrescar,
    onError: (err) => toast.error(mensajeError(err)),
  })
  const instalar = useMutation({
    mutationFn: () => api.assistant.iaInstalarOllama(),
    onSuccess: refrescar,
    onError: (err) => toast.error(mensajeError(err)),
  })
  const probar = useMutation({
    mutationFn: () => api.assistant.iaProbar(),
    onSuccess: (r) => {
      const tiempo =
        r.ms < 1000 ? 'menos de un segundo' : `${(r.ms / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })} segundos`
      setPrueba(r.ia ? `Flowy respondió con IA en ${tiempo}.` : 'La IA todavía no está lista: Flowy respondió con su buscador de siempre.')
    },
    onError: (err) => toast.error(mensajeError(err)),
  })

  if (estado.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 pt-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Consultando el estado de la IA…
        </CardContent>
      </Card>
    )
  }
  if (!e) {
    return (
      <Card>
        <CardContent className="pt-4 text-sm text-muted-foreground">
          {estado.error ? mensajeError(estado.error) : 'No se pudo consultar el estado de la IA.'}
        </CardContent>
      </Card>
    )
  }

  const faltaChat = e.modo === 'conversar' && !e.modelos.chat.descargado
  const faltanModelos = !e.modelos.embeddings.descargado || faltaChat
  const inst = e.instalacion
  const instalando = inst?.estado === 'descargando' || inst?.estado === 'instalando'
  const bloqueado = esPuesto || configurar.isPending

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold">Flowy con inteligencia artificial</h2>
          <p className="text-xs text-muted-foreground">
            Flowy puede entender mejor las preguntas con Ollama, una inteligencia artificial gratuita que funciona en esta PC.
            Para responder no usa internet: las preguntas no salen de esta PC.
          </p>
        </div>

        {esPuesto && (
          <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            Esta PC es un puesto de la red: Flowy responde desde la PC servidor. La IA se instala y se configura allí.
          </div>
        )}

        {/* Modo */}
        <div className="flex flex-col gap-2">
          {MODOS.map((m) => (
            <label
              key={m.valor}
              className={cn(
                'flex cursor-pointer gap-3 rounded-md border p-3 transition-colors',
                e.modo === m.valor ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
                bloqueado && 'cursor-not-allowed opacity-70',
              )}
            >
              <input
                type="radio"
                name="flowy-ia-modo"
                className="mt-1"
                checked={e.modo === m.valor}
                disabled={bloqueado}
                onChange={() => configurar.mutate(m.valor)}
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{m.titulo}</span>
                <span className="text-xs text-muted-foreground">{m.detalle}</span>
              </span>
            </label>
          ))}
        </div>

        {e.modo !== 'apagado' && (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            {/* Ollama */}
            <Fila
              etiqueta="Ollama"
              valor={e.ollama.disponible ? `Instalado${e.ollama.version ? ` (${e.ollama.version})` : ''}` : 'No instalado'}
              ok={e.ollama.disponible}
            />
            {!e.ollama.disponible && (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">
                  Ollama es el programa que hace funcionar la IA. El instalador pesa alrededor de 1,5 GB: con una conexión lenta
                  puede tardar bastante.
                </p>
                {instalando || inst?.mensaje ? (
                  <div className="flex flex-col gap-1">
                    {instalando && <Barra fraccion={inst?.fraccion ?? null} />}
                    <span className="text-xs text-muted-foreground">{inst?.mensaje}</span>
                  </div>
                ) : null}
                <div>
                  <Button size="sm" onClick={() => instalar.mutate()} disabled={esPuesto || instalando || instalar.isPending}>
                    {(instalando || instalar.isPending) && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                    Instalar Ollama
                  </Button>
                </div>
              </div>
            )}

            {/* Modelos */}
            {e.ollama.disponible && (
              <>
                <Fila etiqueta="Modelos" valor={faltanModelos ? 'Faltan descargar' : 'Descargados'} ok={!faltanModelos} />
                {e.descarga ? (
                  <div className="flex flex-col gap-1">
                    <Barra fraccion={e.descarga.fraccion} />
                    <span className="text-xs text-muted-foreground">
                      Descargando {e.descarga.modelo}
                      {e.descarga.total > 0
                        ? `: ${Math.round(e.descarga.bytes / 1048576)} de ${Math.round(e.descarga.total / 1048576)} MB`
                        : '…'}
                    </span>
                  </div>
                ) : (
                  faltanModelos && (
                    <div>
                      <Button size="sm" onClick={() => descargar.mutate()} disabled={esPuesto || descargar.isPending}>
                        {descargar.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                        Descargar modelos
                      </Button>
                    </div>
                  )
                )}
              </>
            )}

            {/* Preparación del índice */}
            {e.ollama.disponible && e.modelos.embeddings.descargado && (
              <>
                <Fila
                  etiqueta="Preparación"
                  valor={
                    e.indice.estado === 'listo'
                      ? 'Lista'
                      : e.indice.estado === 'armando'
                        ? `En curso (${Math.round(e.indice.progreso * 100)}%)`
                        : e.indice.estado === 'error'
                          ? 'Con error'
                          : 'Pendiente'
                  }
                  ok={e.indice.estado === 'listo'}
                />
                {e.indice.estado === 'armando' && <Barra fraccion={e.indice.progreso} />}
              </>
            )}

            <Fila etiqueta="Estado" valor={e.activa ? 'Activa' : 'Inactiva'} ok={e.activa} />
            {e.ultimoError && !e.descarga && <p className="text-xs text-destructive">{e.ultimoError}</p>}

            {e.activa && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => probar.mutate()} disabled={esPuesto || probar.isPending}>
                  {probar.isPending && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                  Probar
                </Button>
                {prueba && <span className="text-xs text-muted-foreground">{prueba}</span>}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
