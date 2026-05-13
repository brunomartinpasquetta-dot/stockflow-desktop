import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Scale } from 'lucide-react'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { parseCurrencyInput } from '@/lib/format'

export function WeightDialog({
  open,
  articleDescription,
  onClose,
  onConfirm,
}: {
  open: boolean
  articleDescription?: string
  onClose: () => void
  onConfirm: (weightKg: string) => void
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
  function confirmFromManual() {
    const v = parseCurrencyInput(manual)
    if (!v || Number(v) <= 0) return
    onConfirm(v)
    setManual('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
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
            <p className="text-xs text-muted-foreground">Sin balanza configurada — ingresá el peso a mano.</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          {hasScale ? (
            <Button onClick={confirmFromScale} disabled={!liveReading || !liveReading.stable}>
              Confirmar peso
            </Button>
          ) : (
            <Button onClick={confirmFromManual} disabled={!manual || Number(parseCurrencyInput(manual)) <= 0}>
              Confirmar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
