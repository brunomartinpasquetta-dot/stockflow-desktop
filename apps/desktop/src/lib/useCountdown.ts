import { useEffect, useState } from 'react'

/**
 * Cuenta regresiva en minutos/segundos hasta `endTimestamp` (epoch ms).
 * Si `endTimestamp` es null, devuelve { 0, 0, expired: true }.
 * Si ya pasó, expired = true.
 */
export function useCountdown(endTimestamp: number | null): { minutes: number; seconds: number; expired: boolean } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!endTimestamp) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [endTimestamp])
  if (!endTimestamp) return { minutes: 0, seconds: 0, expired: true }
  const remainingMs = Math.max(0, endTimestamp - now)
  return {
    minutes: Math.floor(remainingMs / 60_000),
    seconds: Math.floor((remainingMs % 60_000) / 1000),
    expired: remainingMs === 0,
  }
}
