import { format } from 'date-fns'
import { es } from 'date-fns/locale'

const currencyFmt = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function toNumber(value: string | number | null | undefined): number {
  if (value == null) return 0
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? n : 0
}

/** "$1.234,56" */
export function formatCurrency(amount: string | number | null | undefined): string {
  return currencyFmt.format(toNumber(amount))
}

/** "1.234,567" (decimales fijos) */
export function formatNumber(value: string | number | null | undefined, decimals = 2): string {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(toNumber(value))
}

function toDate(date: number | Date): Date {
  return date instanceof Date ? date : new Date(date)
}

/** "dd/MM/yyyy" */
export function formatDate(date: number | Date | null | undefined): string {
  if (date == null) return ''
  return format(toDate(date), 'dd/MM/yyyy', { locale: es })
}

/** "dd/MM/yyyy HH:mm" */
export function formatDateTime(date: number | Date | null | undefined): string {
  if (date == null) return ''
  return format(toDate(date), 'dd/MM/yyyy HH:mm', { locale: es })
}

/**
 * Convierte un importe ingresado por el usuario (es-AR: "1.234,56", "1234,56",
 * "1234", o formato "programador" "1234.56") a la cadena canónica para guardar
 * en la DB ("1234.56").
 */
export function parseCurrencyInput(input: string | number | null | undefined): string {
  if (input == null) return '0'
  let s = String(input).trim().replace(/\s/g, '').replace(/\$/g, '')
  if (s === '') return '0'
  if (s.includes(',')) {
    // hay coma -> es el separador decimal; los puntos son miles
    s = s.replace(/\./g, '').replace(',', '.')
  } else if ((s.match(/\./g) ?? []).length > 1) {
    // varios puntos sin coma -> son separadores de miles
    s = s.replace(/\./g, '')
  }
  // un solo punto sin coma -> se asume separador decimal ("programador")
  const n = Number(s)
  return Number.isFinite(n) ? String(n) : '0'
}
