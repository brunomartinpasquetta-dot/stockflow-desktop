/**
 * Selector compacto de "Forma de pago" único. 95% de las ventas usan un solo
 * medio, así que la UX por defecto del PDV no debe forzar el split.
 *
 * Renderiza un `<Select>` con todos los medios activos. Si el valor actual no
 * existe en la lista cae al medio de efectivo físico (o al primero activo).
 */
import { Select } from '@/components/ui/select'
import type { PaymentMethodDTO } from '@/types/api'

interface PaymentMethodSelectProps {
  methods: PaymentMethodDTO[]
  value: string | null
  onChange: (paymentMethodId: string) => void
  disabled?: boolean
  className?: string
  id?: string
}

export function PaymentMethodSelect({
  methods,
  value,
  onChange,
  disabled,
  className,
  id,
}: PaymentMethodSelectProps) {
  if (methods.length === 0) {
    return (
      <p className="text-xs text-destructive">
        No hay medios de pago activos. Configurá al menos uno en “Medios de pago”.
      </p>
    )
  }
  const effective = value && methods.some((m) => m.id === value) ? value : (methods[0]?.id ?? '')
  return (
    <Select
      id={id}
      className={className}
      value={effective}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {methods.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
          {m.isPhysicalCash ? ' (efectivo)' : ''}
        </option>
      ))}
    </Select>
  )
}
