/**
 * «Anular» una cobranza de cliente o un pago a proveedor, con motivo
 * obligatorio. No borra nada: el pago queda marcado como anulado, la deuda
 * vuelve a la cuenta y el dinero sale o vuelve con un movimiento nuevo en la
 * caja que corresponda (la abierta de hoy si la del pago ya cerró; Caja General
 * si el pago salió de ahí). Pedido de Bruno, 13-oct-2026: «me equivoqué de
 * cliente, ¿puedo revertir ese cobro?».
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'

import { api, ApiError } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { useCanWrite } from '@/contexts/LicenseContext'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function AnularPagoBoton({
  tipo,
  paymentId,
  amount,
  onDone,
}: {
  /** «cobro» = cobranza de cliente; «pago» = pago a proveedor. */
  tipo: 'cobro' | 'pago'
  paymentId: string
  amount: string
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const canWrite = useCanWrite()
  const [abierto, setAbierto] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [anulando, setAnulando] = useState(false)
  const esCobro = tipo === 'cobro'

  async function anular(): Promise<void> {
    const m = motivo.trim()
    if (!m) return
    setAnulando(true)
    try {
      if (esCobro) {
        const r = await api.accounts.anularCobro({ paymentId, motivo: m })
        toast.success(
          `Cobranza anulada: la deuda de ${formatCurrency(r.total)} volvió a la cuenta del cliente y el dinero salió de la caja.`,
          { duration: 10_000 },
        )
      } else {
        const r = await api.supplierAccounts.anularPago({ supplierPaymentId: paymentId, motivo: m })
        toast.success(
          r.destino === 'general'
            ? `Pago anulado: la deuda de ${formatCurrency(r.total)} volvió a la cuenta del proveedor y el dinero volvió a Caja General.`
            : `Pago anulado: la deuda de ${formatCurrency(r.total)} volvió a la cuenta del proveedor y el dinero volvió a la caja diaria.`,
          { duration: 10_000 },
        )
      }
      setAbierto(false)
      setMotivo('')
      // Claves de las dos pantallas (clientes y proveedores) y de las cajas.
      for (const k of [
        'accountStatement', 'accountOpen', 'accountDetail', 'customerBalances', 'customerStatement',
        'supplierStatement', 'supplierAccountDetail', 'supplierBalances', 'supplierOpen',
        'cash', 'cashGeneral',
      ]) {
        void qc.invalidateQueries({ queryKey: [k] })
      }
      onDone?.()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : `No se pudo anular ${esCobro ? 'la cobranza' : 'el pago'}`, {
        duration: 15_000,
      })
    } finally {
      setAnulando(false)
    }
  }

  return (
    <>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-destructive hover:text-destructive"
        title={esCobro ? 'Anular esta cobranza' : 'Anular este pago'}
        disabled={!canWrite || anulando}
        onClick={() => setAbierto(true)}
      >
        {anulando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
      </Button>

      <Dialog open={abierto} onOpenChange={(a) => !a && setAbierto(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{esCobro ? 'Anular cobranza' : 'Anular pago'}</DialogTitle>
            <DialogDescription>
              {esCobro
                ? `La deuda de ${formatCurrency(amount)} vuelve a la cuenta del cliente y el dinero sale de la caja (la abierta de hoy, si la de la cobranza ya cerró). Si la cobranza era de otro cliente, después regístrela en la cuenta correcta.`
                : `La deuda de ${formatCurrency(amount)} vuelve a la cuenta del proveedor y el dinero vuelve a la caja de donde salió (Caja General, o la caja diaria abierta de hoy).`}
              {' '}La operación queda registrada en Auditoría; nada se borra.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="motivo-anulacion">Motivo</Label>
            <Input
              id="motivo-anulacion"
              autoFocus
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={esCobro ? 'Ej.: se cobró al cliente equivocado' : 'Ej.: se pagó la factura equivocada'}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && motivo.trim()) void anular()
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
            <Button variant="destructive" disabled={!motivo.trim() || anulando} onClick={() => void anular()}>
              {anulando && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {esCobro ? 'Anular cobranza' : 'Anular pago'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
