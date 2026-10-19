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
 *  - Al terminar de editar (salir del campo o Enter) NO acepta lo que tiene forma
 *    de código de barras (ocho dígitos o más, sin separadores) ni lo que supera el
 *    tope del servidor (`tope`): vuelve el valor que tenía y avisa. Es la defensa
 *    contra el lector de códigos con el cursor en un casillero de importe
 *    (19-oct-2026). Se apaga con `sinGuardia` sólo donde la pantalla decide sola.
 *
 * Persistencia: NO toca el contrato existente (`parseCurrencyInput`
 * sigue devolviendo string con `.`).
 */
import * as React from 'react'
import { toast } from 'sonner'

import { evaluarEntrada } from '@/lib/entradaNumerica'
import {
  formatCurrency,
  parseCurrencyInput,
  toInputString,
} from '@/lib/format'
import type { ClaveDeTope } from '@/lib/topes'
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
  /** Tope que vale para este casillero: 'precio' (unitario/costo/lista) o 'importe' (default). */
  tope?: Extract<ClaveDeTope, 'precio' | 'importe'>
  /** Si true, no frena códigos de barras ni topes (la pantalla lo decide por su cuenta). */
  sinGuardia?: boolean
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
    { value, onChange, onFocus, onBlur, onKeyDown, noFormatOnBlur, allowNegative = false, tope = 'importe', sinGuardia = false, ...rest },
    ref,
  ) {
    const [focused, setFocused] = React.useState(false)
    const [draft, setDraft] = React.useState<string>('')
    /** El valor que tenía al entrar: a eso se vuelve si lo escrito era un código o un disparate. */
    const alEntrarRef = React.useRef<string>('')

    /**
     * ¿Se acepta lo escrito? Si no, vuelve el valor de antes y se avisa. Devuelve
     * true si se rechazó (el llamador no debe seguir con el valor rechazado).
     */
    function rechazaLoEscrito(texto: string): boolean {
      if (sinGuardia) return false
      const d = evaluarEntrada(tope, texto, toInputString(alEntrarRef.current))
      if (d.tipo === 'aceptar') return false
      onChange(alEntrarRef.current)
      setDraft(toInputString(alEntrarRef.current))
      toast.warning(d.mensaje, { duration: 10_000 })
      return true
    }

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
          alEntrarRef.current = value == null ? '' : String(value)
          setDraft(toInputString(value))
          // Seleccionar para overwrite rápido.
          requestAnimationFrame(() => {
            try { e.target.select() } catch { /* noop */ }
          })
          onFocus?.(e)
        }}
        onKeyDown={(e) => {
          // Enter con un código leído en el casillero: se frena ANTES de que la
          // pantalla (que lee su estado) confirme algo con ese valor.
          if (e.key === 'Enter' && rechazaLoEscrito(e.currentTarget.value)) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          onKeyDown?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          if (rechazaLoEscrito(e.currentTarget.value)) {
            onBlur?.(e)
            return
          }
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
