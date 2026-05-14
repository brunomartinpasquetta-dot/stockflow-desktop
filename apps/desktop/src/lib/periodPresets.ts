/**
 * Helpers para presets de período (mes actual, mes anterior, trimestre, año).
 * Devuelven `from`/`to` como ISO `YYYY-MM-DD` listos para `<input type="date">`.
 */
export function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
