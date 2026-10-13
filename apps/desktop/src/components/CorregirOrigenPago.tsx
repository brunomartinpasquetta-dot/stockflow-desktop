/**
 * «Corregir origen» de un pago a proveedor: de la caja diaria a Caja General o
 * al revés. No anula el pago: la factura sigue pagada y la deuda no cambia.
 *
 * Vive en un componente propio porque hace falta en DOS lugares: el detalle del
 * comprobante y el estado de cuenta (Movimientos). Un comprobante ya pagado
 * desaparece de la lista de abiertos, así que desde Movimientos es el único
 * camino para corregir un pago total (Bruno, 13-oct-2026: «¿dónde revierto el
 * origen de los fondos de ese pago?»).
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Loader2 } from 'lucide-react'
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

export function CorregirOrigenPago({
  paymentId,
  amount,
  fundingSource,
  variante = 'texto',
}: {
  paymentId: string
  amount: string
  /** De dónde figura hoy; se muestra para que el usuario sepa qué está cambiando. */
  fundingSource?: 'daily' | 'general' | null
  /** «texto» = botón con rótulo; «icono» = sólo el ícono (filas angostas). */
  variante?: 'texto' | 'icono'
}) {
  const qc = useQueryClient()
  const canWrite = useCanWrite()
  const [abierto, setAbierto] = useState(false)
  const [corrigiendo, setCorrigiendo] = useState(false)

  async function aplicar(nuevoOrigen: 'daily' | 'general'): Promise<void> {
    setAbierto(false)
    setCorrigiendo(true)
    try {
      const r = await api.supplierAccounts.corregirOrigenDePago(paymentId, nuevoOrigen)
      toast.success(
        r.destino === 'general'
          ? 'Listo: el pago ahora figura como salido de Caja General y se le devolvió el dinero a la caja diaria.'
          : 'Listo: el pago ahora figura como salido de la caja diaria y se le devolvió el dinero a Caja General.',
        { duration: 10_000 },
      )
      // Todo lo que muestra plata o pagos se vuelve a leer (claves por prefijo).
      for (const k of ['supplierStatement', 'supplierAccountDetail', 'supplierBalances', 'supplierOpen', 'cash', 'cashGeneral']) {
        void qc.invalidateQueries({ queryKey: [k] })
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo corregir el origen del pago', { duration: 15_000 })
    } finally {
      setCorrigiendo(false)
    }
  }

  const origenActual =
    fundingSource === 'general' ? 'Caja General' : fundingSource === 'daily' ? 'la caja diaria' : null

  return (
    <>
      {variante === 'icono' ? (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="Corregir el origen del dinero (caja diaria ↔ Caja General)"
          disabled={!canWrite || corrigiendo}
          onClick={() => setAbierto(true)}
        >
          {corrigiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" disabled={!canWrite || corrigiendo} onClick={() => setAbierto(true)}>
          {corrigiendo && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
          Corregir origen
        </Button>
      )}

      <Dialog open={abierto} onOpenChange={(a) => !a && setAbierto(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>¿De dónde salió este pago?</DialogTitle>
            <DialogDescription>
              Se mueve el egreso de {formatCurrency(amount)} a la caja que corresponda.
              {origenActual ? ` Hoy figura como salido de ${origenActual}.` : ''} La factura sigue pagada y la
              deuda con el proveedor no cambia.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Si la caja diaria de ese pago ya está cerrada, el dinero se devuelve a la caja abierta de hoy: una
            caja cerrada ya está arqueada y no se toca.
          </p>
          <DialogFooter className="sm:justify-between">
            <Button variant="outline" onClick={() => setAbierto(false)}>
              Cancelar
            </Button>
            <div className="flex gap-2">
              <Button variant={fundingSource === 'general' ? 'default' : 'outline'} onClick={() => void aplicar('daily')}>
                Salió de la caja diaria
              </Button>
              <Button variant={fundingSource === 'general' ? 'outline' : 'default'} onClick={() => void aplicar('general')}>
                Salió de Caja General
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
