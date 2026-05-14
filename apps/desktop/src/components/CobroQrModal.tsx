import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from 'lucide-react'

import { api } from '@/lib/api'
import { useBeep } from '@/lib/useBeep'
import { useCountdown } from '@/lib/useCountdown'
import { formatCurrency } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { QrDisplay } from '@/components/QrDisplay'
import type { MpOrderDTO } from '@/types/api'

type Phase = 'loading' | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'error'

export interface CobroQrModalProps {
  open: boolean
  amount: string
  cashRegisterId: string
  description: string
  onApproved: (orderId: string, mpPaymentId: string | null) => void
  onCancelled: () => void
  onClose: () => void
}

/**
 * Modal de cobro MercadoPago QR Atendido.
 * Crea una orden, muestra el QR, hace polling cada 3s, beep al aprobar
 * y auto-cancela en MP al cerrarse sin confirmar.
 */
export function CobroQrModal({
  open,
  amount,
  cashRegisterId,
  description,
  onApproved,
  onCancelled,
  onClose,
}: CobroQrModalProps) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [order, setOrder] = useState<MpOrderDTO | null>(null)
  const [qr, setQr] = useState<{ qrUrl: string; qrImageBase64: string | null } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)

  // Refs para que cleanup (al cerrar) tenga la última versión sin depender de re-render.
  const orderRef = useRef<MpOrderDTO | null>(null)
  const phaseRef = useRef<Phase>('loading')
  useEffect(() => { orderRef.current = order }, [order])
  useEffect(() => { phaseRef.current = phase }, [phase])

  const beep = useBeep()

  // 1) Crear orden + cargar QR al abrir. Reset y fetch siempre dentro de microtask para
  // evitar setState síncrono en el cuerpo del effect.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      setPhase('loading')
      setOrder(null)
      setQr(null)
      setErrorMsg(null)
      try {
        const [ord, qrData] = await Promise.all([
          api.mpQr.createOrder({ cashRegisterId, amount, description }),
          api.mpQr.getQrForCashRegister(cashRegisterId),
        ])
        if (cancelled) return
        setOrder(ord)
        setQr(qrData)
        setPhase('pending')
      } catch (err) {
        if (cancelled) return
        setErrorMsg(err instanceof Error ? err.message : 'Error al generar el cobro')
        setPhase('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, cashRegisterId, amount, description])

  // 2) Polling cada 3s mientras está pending y no expiró.
  useEffect(() => {
    if (phase !== 'pending' || !order) return
    if (order.expiresAt <= Date.now()) return
    const id = setInterval(async () => {
      try {
        const updated = await api.mpQr.verifyPayment(order.id)
        setOrder(updated)
        if (updated.status === 'approved') setPhase('approved')
        else if (updated.status === 'rejected') setPhase('rejected')
        else if (updated.status === 'cancelled') setPhase('cancelled')
        else if (updated.status === 'expired') setPhase('expired')
      } catch {
        // silent — reintenta en el próximo tick
      }
    }, 3000)
    return () => clearInterval(id)
  }, [phase, order])

  // 3) Countdown sobre expiresAt. Si expira mientras está pending, mostramos el estado expirado
  // como valor derivado (sin setState en effect) — el polling de fondo igual deja de hacer sentido.
  const { minutes, seconds, expired } = useCountdown(order?.expiresAt ?? null)
  const effectivePhase: Phase = phase === 'pending' && expired ? 'expired' : phase

  // 4) Beep + auto-callback al aprobar.
  useEffect(() => {
    if (phase !== 'approved' || !order) return
    beep()
    const t = setTimeout(() => onApproved(order.id, order.mpPaymentId ?? null), 1500)
    return () => clearTimeout(t)
  }, [phase, order, beep, onApproved])

  // 5) Cleanup: si el modal se desmonta o se cierra estando pending, cancelar en MP best-effort.
  useEffect(() => {
    return () => {
      const ord = orderRef.current
      const ph = phaseRef.current
      if (ord && ph === 'pending') {
        api.mpQr.cancelOrder(ord.id).catch(() => {})
      }
    }
  }, [])

  const handleCancel = useCallback(async () => {
    if (!window.confirm('¿Cancelar este cobro?')) return
    const ord = orderRef.current
    if (ord) {
      try {
        await api.mpQr.cancelOrder(ord.id)
      } catch {
        // silent
      }
    }
    onCancelled()
    onClose()
  }, [onCancelled, onClose])

  const handleVerify = useCallback(async () => {
    if (!order) return
    setVerifying(true)
    try {
      const updated = await api.mpQr.verifyPayment(order.id)
      setOrder(updated)
      if (updated.status === 'approved') setPhase('approved')
      else if (updated.status === 'rejected') setPhase('rejected')
      else if (updated.status === 'cancelled') setPhase('cancelled')
      else if (updated.status === 'expired') setPhase('expired')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo verificar el pago')
    } finally {
      setVerifying(false)
    }
  }, [order])

  const handleClose = useCallback(() => {
    // Si está pending el cleanup del useEffect intentará cancelar.
    onClose()
  }, [onClose])

  const isFinal =
    effectivePhase === 'approved' ||
    effectivePhase === 'rejected' ||
    effectivePhase === 'cancelled' ||
    effectivePhase === 'expired' ||
    effectivePhase === 'error'

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cobrar con QR MercadoPago</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          {effectivePhase === 'loading' && (
            <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-sm">Generando orden de cobro…</p>
            </div>
          )}

          {effectivePhase === 'pending' && (
            <>
              <div className="text-3xl font-bold tabular-nums">{formatCurrency(amount)}</div>
              <QrDisplay qrBase64={qr?.qrImageBase64} qrUrl={qr?.qrUrl} />
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="tabular-nums">
                  Tiempo restante: {minutes}:{seconds.toString().padStart(2, '0')}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Esperando pago…</span>
              </div>
              <p className="text-center text-xs text-muted-foreground">
                Escaneá con tu app de MercadoPago, MODO o tu banco.
              </p>
            </>
          )}

          {effectivePhase === 'approved' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="h-16 w-16 text-emerald-500" />
              <p className="text-lg font-semibold">Pago aprobado</p>
              <p className="text-2xl font-bold tabular-nums">{formatCurrency(order?.amount ?? amount)}</p>
              <p className="text-xs text-muted-foreground">Registrando la venta…</p>
            </div>
          )}

          {effectivePhase === 'cancelled' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <XCircle className="h-16 w-16 text-destructive" />
              <p className="text-lg font-semibold">Cobro cancelado</p>
            </div>
          )}

          {effectivePhase === 'expired' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <Clock className="h-16 w-16 text-amber-500" />
              <p className="text-lg font-semibold">Tiempo agotado</p>
              <p className="text-sm text-muted-foreground">El cobro expiró sin recibir pago.</p>
            </div>
          )}

          {effectivePhase === 'rejected' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <XCircle className="h-16 w-16 text-destructive" />
              <p className="text-lg font-semibold">Pago rechazado</p>
            </div>
          )}

          {effectivePhase === 'error' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <AlertTriangle className="h-16 w-16 text-destructive" />
              <p className="text-lg font-semibold">No se pudo generar el cobro</p>
              {errorMsg && <p className="text-center text-xs text-muted-foreground">{errorMsg}</p>}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          {effectivePhase === 'pending' ? (
            <>
              <Button variant="ghost" onClick={handleCancel}>
                Cancelar
              </Button>
              <Button variant="outline" onClick={handleVerify} disabled={verifying}>
                {verifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Verificar pago
              </Button>
            </>
          ) : isFinal && effectivePhase !== 'approved' ? (
            <Button variant="outline" onClick={handleClose}>
              Cerrar
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
