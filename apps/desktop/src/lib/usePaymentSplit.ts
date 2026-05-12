/**
 * Estado del "split" de pago: N medios de pago, un monto por cada uno.
 *
 * `allowOverpay: true` (PDV) → la suma puede superar el total; el excedente se
 * informa como "vuelto" y se descuenta de la línea de efectivo al armar los pagos
 * (los `payments` devueltos siempre suman exactamente `total`).
 * `allowOverpay: false` (cobranzas) → la suma debe coincidir con el total.
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
  sumNum: number
  /** total − suma, ≥ 0 (lo que falta cobrar). */
  restante: number
  /** suma − total, ≥ 0 (vuelto; sólo informativo, no se guarda). */
  change: number
  valid: boolean
  /** Pagos a enviar al backend (sólo los > 0; suman exactamente `total`). */
  payments: Array<{ paymentMethodId: string; amount: string }>
}

function num(v: string | undefined): number {
  return v ? Number(parseCurrencyInput(v)) : 0
}

export function usePaymentSplit(
  activeMethods: PaymentMethodDTO[],
  total: number,
  opts: { allowOverpay: boolean },
): PaymentSplit {
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

  const sumNum = useMemo(
    () => Object.values(numByPm).reduce((a, b) => a + b, 0),
    [numByPm],
  )
  const restante = Math.max(0, Number((total - sumNum).toFixed(2)))
  const change = Math.max(0, Number((sumNum - total).toFixed(2)))

  const valid = opts.allowOverpay
    ? total > 0 &&
      sumNum >= total - 0.005 &&
      (change <= 0.005 || (cashMethod != null && (numByPm[cashMethod.id] ?? 0) >= change - 0.005))
    : total > 0 && Math.abs(sumNum - total) < 0.005

  const payments = useMemo(() => {
    const list: Array<{ paymentMethodId: string; amount: string }> = []
    for (const m of activeMethods) {
      let amt = numByPm[m.id] ?? 0
      if (opts.allowOverpay && change > 0.005 && cashMethod && m.id === cashMethod.id) {
        amt = Number((amt - change).toFixed(4))
      }
      if (amt > 0.0001) list.push({ paymentMethodId: m.id, amount: amt.toFixed(4) })
    }
    return list
  }, [activeMethods, numByPm, change, cashMethod, opts.allowOverpay])

  return { amounts, setAmount, fillAllInCash, reset, cashMethod, sumNum, restante, change, valid, payments }
}
