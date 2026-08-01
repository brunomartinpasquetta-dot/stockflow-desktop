/**
 * Helpers de formato del renderer Electron.
 *
 * Las primitivas monetarias replican el contrato de
 * `@stockflow/shared/utils/currency` para no romper renderer + desktop ↔
 * shared/cloud. Mantenemos esta copia local en `apps/desktop/src` para
 * que el tsconfig del renderer (`erasableSyntaxOnly`, `verbatimModuleSyntax`)
 * no tenga que crawlear las re-exports `export type ... from '@stockflow/db'`.
 *
 * Si necesitás tocar la fórmula, sincronizá ambos lados.
 */
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

function toNumber(value: string | number | null | undefined): number {
  if (value == null) return 0
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? n : 0
}

/**
 * Formatea un importe a string es-AR para mostrar (`"$1.234,56"`).
 *
 *  formatCurrency('1234.56')                       // "$1.234,56"
 *  formatCurrency(1234.56, { showSymbol: false })  // "1.234,56"
 *  formatCurrency(null)                            // "$0,00"
 */
export function formatCurrency(
  value: string | number | null | undefined,
  options?: { showSymbol?: boolean; decimals?: number },
): string {
  const { showSymbol = true, decimals = 2 } = options ?? {}
  const num = toNumber(value)
  const formatted = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num)
  return showSymbol ? `$${formatted}` : formatted
}

/** "1.234,567" (decimales fijos, sin símbolo de moneda) */
export function formatNumber(value: string | number | null | undefined, decimals = 2): string {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(toNumber(value))
}

/**
 * Cantidad "limpia" para mostrar: sin decimales cuando el número es entero y
 * sin ceros de relleno a la derecha cuando no lo es.
 *
 *   formatQty(0)        // "0"       (antes: "0,000")
 *   formatQty(12)       // "12"
 *   formatQty(1.5)      // "1,5"
 *   formatQty(2.250)    // "2,25"
 *   formatQty(null)     // "0"
 *
 * `maxDecimals` es el tope de decimales a mostrar (3 = stock/cantidades).
 */
export function formatQty(value: string | number | null | undefined, maxDecimals = 3): string {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  }).format(toNumber(value))
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
  if (!Number.isFinite(n)) return '0'
  // Garantizar el contrato `^\d+(\.\d{1,4})?$`: redondear a 4 decimales y
  // evitar notación científica (toFixed nunca la produce). Luego quitar los
  // ceros/punto sobrantes a la derecha ("12.3400"→"12.34", "12.0000"→"12").
  const fixed = Math.abs(n).toFixed(4)
  return fixed.replace(/\.?0+$/, '')
}

/** Versión numérica útil para cálculos derivados en vivo. */
export function parseCurrencyToNumber(input: string | number | null | undefined): number {
  return Number(parseCurrencyInput(input))
}

/**
 * Convierte un valor canónico ("1234.56") a la forma editable del input
 * en es-AR ("1234,56"). No agrega separador de miles para no molestar
 * al usuario mientras escribe.
 */
export function toInputString(value: string | number | null | undefined): string {
  if (value == null || value === '') return ''
  const num = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(num)) return ''
  return String(num).replace('.', ',')
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
