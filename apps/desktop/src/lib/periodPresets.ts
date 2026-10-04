/**
 * Helpers de fechas para los filtros de período de las pantallas (hoy, primero
 * de mes, hace N días, presets de mes actual / anterior / trimestre / año).
 * Devuelven ISO `YYYY-MM-DD` en hora local, listos para `<input type="date">`,
 * y `dayStart`/`dayEnd` convierten ese ISO al rango de timestamps del día.
 */
export function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function todayIso(): string {
  return toIso(new Date())
}

export function firstOfMonthIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return toIso(d)
}

export function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}

export function dayEnd(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

export interface PeriodPreset {
  key: string
  label: string
  range: () => { fromIso: string; toIso: string }
}

export const PERIOD_PRESETS: PeriodPreset[] = [
  {
    key: 'current-month',
    label: 'Mes actual',
    range: () => {
      const now = new Date()
      const first = new Date(now.getFullYear(), now.getMonth(), 1)
      return { fromIso: toIso(first), toIso: toIso(now) }
    },
  },
  {
    key: 'previous-month',
    label: 'Mes anterior',
    range: () => {
      const now = new Date()
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return { fromIso: toIso(first), toIso: toIso(last) }
    },
  },
  {
    key: 'current-quarter',
    label: 'Trimestre actual',
    range: () => {
      const now = new Date()
      const q = Math.floor(now.getMonth() / 3)
      const first = new Date(now.getFullYear(), q * 3, 1)
      return { fromIso: toIso(first), toIso: toIso(now) }
    },
  },
  {
    key: 'current-year',
    label: 'Año actual',
    range: () => {
      const now = new Date()
      const first = new Date(now.getFullYear(), 0, 1)
      return { fromIso: toIso(first), toIso: toIso(now) }
    },
  },
]
