import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Scale } from 'lucide-react'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'

import { evaluarEntrada } from '@/lib/entradaNumerica'
import { parseCurrencyInput } from '@/lib/format'

export function WeightDialog({
  open,
  articleDescription,
  onClose,
  onConfirm,
  onCloseAutoFocus,
}: {
  open: boolean
  articleDescription?: string
  onClose: () => void
  onConfirm: (weightKg: string) => void
  /** Al cerrar: a dónde va el foco (Ventas lo devuelve a su buscador). */
  onCloseAutoFocus?: (e: Event) => void
}) {
  const scaleConfigQuery = useQuery({
    queryKey: ['hardwareScaleConfig'],
    queryFn: () => api.hardware.scale.getConfig(),
    staleTime: 30_000,
    enabled: open,
  })
  const hasScale = scaleConfigQuery.data != null

  const [liveReading, setLiveReading] = useState<{ value: string; stable: boolean } | null>(null)
  const [manual, setManual] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!open || !hasScale) {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
      return
    }
    const tick = async () => {
      try {
        const r = await api.hardware.scale.read()
        setLiveReading({ value: r.value, stable: r.stable })
      } catch {
        setLiveReading(null)
      }
    }
    void tick()
    pollRef.current = setInterval(tick, 400)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [open, hasScale])

  function confirmFromScale() {
    if (!liveReading) return
    onConfirm(liveReading.value)
    onClose()
  }
  // Peso tipeado a mano: con el cursor acá, un código de barras leído entraba como
  // kilos (19-oct-2026). Lo que parece código o supera el tope no se acepta.
  const rechazoManual = manual.trim() ? evaluarEntrada('cantidad', manual) : null
  function confirmFromManual() {
    if (rechazoManual && rechazoManual.tipo !== 'aceptar') {
      toast.warning(rechazoManual.mensaje, { duration: 10_000 })
      setManual('')
      return
    }
    const v = parseCurrencyInput(manual)
    if (!v || Number(v) <= 0) return
    onConfirm(v)
    setManual('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5" /> Peso del producto
          </DialogTitle>
        </DialogHeader>
        {articleDescription && (
          <p className="text-sm text-muted-foreground">{articleDescription}</p>
        )}
        {hasScale ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="text-5xl font-bold tabular-nums">
              {liveReading ? `${liveReading.value} kg` : '— kg'}
            </div>
            {liveReading && (
              <Badge variant={liveReading.stable ? 'success' : 'warning'}>
                {liveReading.stable ? 'Estable' : 'Estabilizando…'}
              </Badge>
            )}
            <p className="text-xs text-muted-foreground">Esperando lectura estable de la balanza.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 py-2">
            <Label htmlFor="weight-manual">Cantidad (kg)</Label>
            <Input
              id="weight-manual"
              autoFocus
              inputMode="decimal"
              value={manual}
              placeholder="0.000"
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmFromManual() }}
            />
            {rechazoManual && rechazoManual.tipo !== 'aceptar' ? (
              <p className="text-xs text-destructive" data-testid="peso-rechazado">{rechazoManual.mensaje}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Sin balanza configurada. Ingrese el peso a mano.</p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          {hasScale ? (
            <Button onClick={confirmFromScale} disabled={!liveReading || !liveReading.stable}>
              Confirmar peso
            </Button>
          ) : (
            <Button onClick={confirmFromManual} disabled={!manual || Number(parseCurrencyInput(manual)) <= 0 || (rechazoManual != null && rechazoManual.tipo !== 'aceptar')}>
              Confirmar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
