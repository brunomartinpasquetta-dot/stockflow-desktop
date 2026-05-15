/**
 * <CurrencyInput>
 *
 * Input monetario es-AR con autoformato.
 *
 *  - `value`: string canónico (decimal con `.`, ej `"1234.56"`) o `""`.
 *  - `onChange(value)`: emite string canónico, listo para mandar a la DB.
 *  - Mientras el input tiene focus, muestra forma editable (`1234,56`).
 *  - Al blur, formatea a `$1.234,56` y normaliza el `value` emitido.
 *  - Sólo acepta dígitos, coma, punto y signo `-` (no símbolos de moneda).
 *
 * Persistencia: NO toca el contrato existente (`parseCurrencyInput`
 * sigue devolviendo string con `.`).
 */
import * as React from 'react'

import {
  formatCurrency,
  parseCurrencyInput,
  toInputString,
} from '@/lib/format'
import { Input, type InputProps } from '@/components/ui/input'

export interface CurrencyInputProps
  extends Omit<InputProps, 'value' | 'onChange' | 'type' | 'inputMode'> {
  /** Valor canónico decimal con `.`, ej `"1234.56"`. `""`/`null` aceptados. */
  value: string | number | null | undefined
  /** Recibe siempre string canónico decimal (`"1234.56"`) o `""`. */
  onChange: (value: string) => void
  /** Si true, no formatea al blur (útil para casos especiales). */
  noFormatOnBlur?: boolean
  /** Si true, permite negativos. Default false. */
  allowNegative?: boolean
}

const ALLOWED_RE = /[^\d,.-]/g

function clean(input: string, allowNegative: boolean): string {
  let s = input.replace(ALLOWED_RE, '')
  if (!allowNegative) s = s.replace(/-/g, '')
  else {
    // mantener `-` sólo al inicio
    const hasMinus = s.startsWith('-')
    s = (hasMinus ? '-' : '') + s.replace(/-/g, '')
  }
  return s
}

export const CurrencyInput = React.forwardRef<HTMLInputElement, CurrencyInputProps>(
  function CurrencyInput(
    { value, onChange, onFocus, onBlur, noFormatOnBlur, allowNegative = false, ...rest },
    ref,
  ) {
    const [focused, setFocused] = React.useState(false)
    const [draft, setDraft] = React.useState<string>('')

    // Mientras está enfocado, mostramos el draft. Si no, mostramos el formateado.
    const display = focused
      ? draft
      : value == null || value === ''
        ? ''
        : formatCurrency(value)

    return (
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        value={display}
        onChange={(e) => {
          const cleaned = clean(e.target.value, allowNegative)
          setDraft(cleaned)
          // Emitimos canónico en vivo para que los cálculos derivados se actualicen.
          onChange(parseCurrencyInput(cleaned))
        }}
        onFocus={(e) => {
          setFocused(true)
          setDraft(toInputString(value))
          // Seleccionar para overwrite rápido.
          requestAnimationFrame(() => {
            try { e.target.select() } catch { /* noop */ }
          })
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          if (!noFormatOnBlur) {
            const canonical = parseCurrencyInput(draft || String(value ?? ''))
            onChange(canonical)
          }
          onBlur?.(e)
        }}
        {...rest}
      />
    )
  },
)
