/**
 * Estado del "split" de pago: N medios de pago, un monto por cada uno.
 *
 * La suma de los montos debe ser EXACTAMENTE igual al total a cobrar — no hay
 * concepto de "vuelto": el cajero ingresa exactamente lo cobrado en cada medio.
 */
import { useCallback, useMemo, useState } from 'react'

import { parseCurrencyInput } from '@/lib/format'
import type { PaymentMethodDTO } from '@/types/api'

export interface PaymentSplit {
  amounts: Record<string, string>
  setAmount: (paymentMethodId: string, value: string) => void
  /** Pone `total − (otros medios)` en el medio de efectivo físico (o el primero activo). */
  fillAllInCash: () => void
  reset: () => void
  cashMethod: PaymentMethodDTO | undefined
  /** Suma de todos los montos ingresados. */
  totalPaid: number
  /** true si `totalPaid === total` (con tolerancia de centavos) y `total > 0`. */
  isComplete: boolean
  /** true si `totalPaid > total`. */
  isExcess: boolean
  /** `max(0, total − totalPaid)` — lo que falta cobrar. */
  remaining: number
  /** Pagos a enviar al backend (sólo los > 0). */
  payments: Array<{ paymentMethodId: string; amount: string }>
}

function num(v: string | undefined): number {
  return v ? Number(parseCurrencyInput(v)) : 0
}

export function usePaymentSplit(activeMethods: PaymentMethodDTO[], total: number): PaymentSplit {
  const [amounts, setAmounts] = useState<Record<string, string>>({})

  const setAmount = useCallback((paymentMethodId: string, value: string) => {
    setAmounts((prev) => ({ ...prev, [paymentMethodId]: value }))
  }, [])
  const reset = useCallback(() => setAmounts({}), [])

  const cashMethod = useMemo(
    () => activeMethods.find((m) => m.isPhysicalCash) ?? activeMethods[0],
    [activeMethods],
  )

  const fillAllInCash = useCallback(() => {
    const cm = cashMethod
    if (!cm) return
    setAmounts((prev) => {
      const othersSum = activeMethods
        .filter((m) => m.id !== cm.id)
        .reduce((acc, m) => acc + num(prev[m.id]), 0)
      const remaining = Math.max(0, Number((total - othersSum).toFixed(2)))
      return { ...prev, [cm.id]: remaining.toFixed(2) }
    })
  }, [activeMethods, cashMethod, total])

  const numByPm = useMemo(() => {
    const out: Record<string, number> = {}
    for (const m of activeMethods) out[m.id] = num(amounts[m.id])
    return out
  }, [activeMethods, amounts])

  const totalPaid = useMemo(() => Object.values(numByPm).reduce((a, b) => a + b, 0), [numByPm])
  const remaining = Math.max(0, Number((total - totalPaid).toFixed(2)))
  const isExcess = totalPaid - total > 0.005
  const isComplete = total > 0 && Math.abs(totalPaid - total) < 0.005

  const payments = useMemo(() => {
    const list: Array<{ paymentMethodId: string; amount: string }> = []
    for (const m of activeMethods) {
      const amt = numByPm[m.id] ?? 0
      if (amt > 0.0001) list.push({ paymentMethodId: m.id, amount: amt.toFixed(4) })
    }
    return list
  }, [activeMethods, numByPm])

  return { amounts, setAmount, fillAllInCash, reset, cashMethod, totalPaid, isComplete, isExcess, remaining, payments }
}
