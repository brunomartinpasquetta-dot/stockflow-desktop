/**
 * Diálogo "Vincular teléfono": pide un enlace nuevo (`facturas.vincular`) y lo
 * muestra como QR. El teléfono lo escanea y abre la página para sacar las
 * fotos de la factura.
 *
 * Hay hasta dos enlaces con el mismo permiso: el de la red del local (Wi-Fi) y,
 * si el acceso remoto está conectado, el de internet. Se muestra uno por vez.
 *
 * Compras lo reutiliza para «Cargar con el teléfono» (CargaTelefonoCompras):
 * recibe el enlace (`onEnlace`, para seguir la factura de esa sesión), pone
 * debajo del QR lo que va pasando (`children`) y oculta el QR cuando el
 * teléfono ya empezó a mandar (`ocultarQr`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

import { api } from '@/lib/api'
import { mensajeError } from '@/lib/mensajeError'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { FacturasVincularDTO } from '@/types/api'

type Via = 'local' | 'internet'

function restante(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function VincularTelefonoDialog({
  open,
  onClose,
  titulo = 'Vincular teléfono',
  descripcion = 'Escanee el código con la cámara del teléfono. Se abre una página para fotografiar las hojas de la factura.',
  onEnlace,
  ocultarQr = false,
  error: errorExterno,
  children,
}: {
  open: boolean
  onClose: () => void
  titulo?: string
  descripcion?: string
  /** Avisa cada enlace nuevo (null mientras se pide otro o si falló). */
  onEnlace?: (enlace: FacturasVincularDTO | null) => void
  /** El teléfono ya está mandando: el QR deja lugar a `children`. */
  ocultarQr?: boolean
  /** Algo para mostrar si no se pudo generar el enlace (por ejemplo, ir a Configuración). */
  error?: (mensaje: string) => ReactNode
  /** Lo que va debajo del QR (o en su lugar, con `ocultarQr`). */
  children?: ReactNode
}) {
  const [enlace, setEnlace] = useState<FacturasVincularDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cargando, setCargando] = useState(false)
  const [via, setVia] = useState<Via>('local')
  const [qr, setQr] = useState<string | null>(null)
  const [ahora, setAhora] = useState(() => Date.now())
  /** Cambia para pedir otro enlace sin cerrar el diálogo. */
  const [pedido, setPedido] = useState(0)

  // `onEnlace` puede cambiar en cada render del que lo usa: se guarda aparte
  // para no pedir un enlace nuevo por eso.
  const avisarEnlace = useRef(onEnlace)
  useEffect(() => {
    avisarEnlace.current = onEnlace
  })

  // Cada vez que se abre (o se toca "Generar otro") se pide un enlace nuevo.
  useEffect(() => {
    if (!open) return
    let vivo = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCargando(true)
    setEnlace(null)
    setError(null)
    setQr(null)
    avisarEnlace.current?.(null)
    api.facturas
      .vincular()
      .then((r) => {
        if (!vivo) return
        setEnlace(r)
        setVia(r.urlLocal ? 'local' : 'internet')
        setAhora(Date.now())
        avisarEnlace.current?.(r)
      })
      .catch((e: unknown) => {
        if (vivo) setError(mensajeError(e, 'No se pudo generar el enlace.'))
      })
      .finally(() => {
        if (vivo) setCargando(false)
      })
    return () => {
      vivo = false
    }
  }, [open, pedido])

  const url = enlace ? (via === 'internet' ? enlace.urlInternet : enlace.urlLocal) ?? enlace.urlLocal ?? enlace.urlInternet : null

  useEffect(() => {
    let vivo = true
    if (!url) return
    void import('qrcode')
      .then((QR) => QR.toDataURL(url, { width: 520, margin: 1 }))
      .then((dataUrl) => {
        if (vivo) setQr(dataUrl)
      })
      .catch(() => {
        if (vivo) setQr(null)
      })
    return () => {
      vivo = false
    }
  }, [url])

  // Cuenta regresiva.
  useEffect(() => {
    if (!open || !enlace) return
    const t = window.setInterval(() => setAhora(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [open, enlace])

  const vencido = enlace != null && enlace.vence - ahora <= 0
  const hayDos = enlace?.urlLocal != null && enlace.urlInternet != null
  const porInternet = enlace != null && (via === 'internet' || enlace.urlLocal == null)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{titulo}</DialogTitle>
          <DialogDescription>{descripcion}</DialogDescription>
        </DialogHeader>

        {cargando && (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Generando el enlace…
          </div>
        )}

        {error && (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-center text-sm text-destructive">{error}</p>
            {errorExterno?.(error)}
            <Button size="sm" variant="outline" onClick={() => setPedido((n) => n + 1)}>
              Reintentar
            </Button>
          </div>
        )}

        {enlace && !cargando && ocultarQr && <div className="flex flex-col items-center gap-3">{children}</div>}

        {enlace && !cargando && !ocultarQr && (
          <div className="flex flex-col items-center gap-3">
            {hayDos && (
              <div className="flex rounded-md border p-0.5 text-sm">
                {(
                  [
                    ['local', 'Por Wi-Fi'],
                    ['internet', 'Por internet'],
                  ] as const
                ).map(([valor, etiqueta]) => (
                  <button
                    key={valor}
                    type="button"
                    onClick={() => setVia(valor)}
                    className={cn(
                      'rounded px-3 py-1 transition-colors',
                      via === valor ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {etiqueta}
                  </button>
                ))}
              </div>
            )}

            {/* Fondo blanco fijo: con el tema oscuro el QR no se lee. */}
            <div className={cn('rounded-lg border bg-white p-2', vencido && 'opacity-20')}>
              {qr ? (
                <img src={qr} alt="Código QR para vincular el teléfono" className="h-72 w-72" />
              ) : (
                <div className="flex h-72 w-72 items-center justify-center">
                  <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
                </div>
              )}
            </div>

            {vencido ? (
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm font-medium text-destructive">El enlace venció.</p>
                <Button size="sm" onClick={() => setPedido((n) => n + 1)}>
                  Generar otro
                </Button>
              </div>
            ) : (
              <>
                <p className="text-sm">
                  Vence en <span className="font-semibold tabular-nums">{restante(enlace.vence - ahora)}</span>
                </p>
                <p className="text-center text-xs text-muted-foreground">
                  {porInternet
                    ? 'El teléfono entra por internet: puede usar datos móviles o cualquier Wi-Fi.'
                    : 'El teléfono debe estar conectado a la misma red Wi-Fi que esta PC.'}
                </p>
                <p className="select-all break-all text-center font-mono text-[11px] text-muted-foreground">{url}</p>
                <p className="text-center text-xs text-muted-foreground">
                  Con el mismo enlace puede enviar varias facturas, una por vez. Mientras el teléfono envía hojas, el enlace no
                  vence.
                </p>
              </>
            )}
            {children}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
