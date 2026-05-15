/**
 * Utilidades de formato monetario es-AR.
 *
 * Convenciones:
 *  - DB / canónico: string decimal con punto (`"1234.56"`).
 *  - Display: `$1.234,56` (puntos miles, coma decimal).
 *  - Input crudo del usuario: acepta tanto `"1.234,56"` como `"1234,56"` o `"1234.56"`.
 *
 * Se usa desde @stockflow/desktop (renderer Electron) y @stockflow/cloud.
 * No depende de Node ni de Electron — sólo `Intl` y `Number`.
 */

function toNumber(value: string | number | null | undefined): number {
  if (value == null) return 0
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? n : 0
}

/**
 * Formatea un importe a string es-AR para mostrar.
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

/**
 * Convierte un importe ingresado por el usuario (es-AR: "1.234,56", "1234,56",
 * "1234", o formato "programador" "1234.56") a la cadena canónica para guardar
 * en la DB ("1234.56"). Siempre devuelve string con `.` decimal o `"0"`.
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

/** Versión numérica; útil para calcular en vivo. */
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
