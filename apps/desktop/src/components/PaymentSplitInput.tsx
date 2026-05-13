/**
 * Zona de pago con N filas (una por medio de pago activo) + indicador de estado
 * (restante / completo / excede) + atajo "Todo en Efectivo". El estado vive en
 * `usePaymentSplit`. La suma debe ser exactamente igual al total — no hay vuelto.
 */
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { formatCurrency, parseCurrencyInput } from '@/lib/format'
import type { PaymentSplit } from '@/lib/usePaymentSplit'
import type { PaymentMethodDTO } from '@/types/api'

export function PaymentSplitInput({
  methods,
  split,
}: {
  methods: PaymentMethodDTO[]
  split: PaymentSplit
}) {
  if (methods.length === 0) {
    return <p className="text-xs text-destructive">No hay medios de pago activos. Configurá al menos uno en “Medios de pago”.</p>
  }
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {methods.map((m) => (
        <div key={m.id} className="flex items-center justify-between gap-2">
          <span className="truncate text-muted-foreground">{m.name}</span>
          <Input
            className="h-8 w-32 text-right tabular-nums"
            inputMode="decimal"
            placeholder="0,00"
            value={split.amounts[m.id] ?? ''}
            onChange={(e) => split.setAmount(m.id, e.target.value)}
            onBlur={() => {
              const v = split.amounts[m.id]
              if (v && v.trim() !== '') split.setAmount(m.id, parseCurrencyInput(v))
            }}
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        {split.cashMethod && (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={split.fillAllInCash}>
            Todo en {split.cashMethod.name}
          </Button>
        )}
        <span className="ml-auto text-right">
          {split.isExcess ? (
            <span className="text-destructive">Excede el total. Ajustá los montos.</span>
          ) : split.remaining > 0.005 ? (
            <span className="text-destructive">Restante a cobrar: {formatCurrency(split.remaining)}</span>
          ) : split.isComplete ? (
            <span className="text-success">Pagos completos</span>
          ) : null}
        </span>
      </div>
    </div>
  )
}
