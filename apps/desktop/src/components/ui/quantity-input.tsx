/**
 * <QuantityInput>
 *
 * Casillero de CANTIDAD (renglones de compras y presupuestos, artículo rápido,
 * promociones, existencias, peso). Es un `<Input>` común con la misma defensa
 * que `CurrencyInput` contra el lector de códigos de barras (19-oct-2026):
 *
 *  - mientras se escribe emite lo tipeado tal cual (`onChange`), para que los
 *    cálculos de la pantalla sigan en vivo;
 *  - al terminar de editar (salir del campo o Enter) NO acepta lo que tiene
 *    forma de código de barras (ocho dígitos o más; nunca se lo compara con los
 *    códigos cortos del padrón) ni lo que supera el tope del servidor:
 *    vuelve la cantidad que tenía, avisa, y NO llama a `onCommit`;
 *  - si se acepta, `onCommit` recibe la cantidad canónica (`"1.5"`);
 *  - una cantidad inusualmente alta pero posible (`confirmarDesde`, por
 *    defecto 10.000) pide confirmar una vez.
 */
import * as React from 'react'
import { toast } from 'sonner'

import { evaluarEntrada } from '@/lib/entradaNumerica'
import { CANTIDAD_ALTA, textoSospecha } from '@/lib/cantidadSospechosa'
import { parseCurrencyInput } from '@/lib/format'
import type { ClaveDeTope } from '@/lib/topes'
import { Input, type InputProps } from '@/components/ui/input'

export interface QuantityInputProps extends Omit<InputProps, 'value' | 'onChange'> {
  value: string
  /** Lo tipeado, en vivo. */
  onChange: (valor: string) => void
  /** La cantidad canónica ya aceptada, al terminar de editar. */
  onCommit?: (canonico: string) => void
  /** 'cantidad' (renglones, default) o 'stock' (existencias del artículo). */
  tipo?: Extract<ClaveDeTope, 'cantidad' | 'stock'>
  /** A partir de qué cantidad se pide confirmar. 0 o `Infinity` = nunca. */
  confirmarDesde?: number
}

export const QuantityInput = React.forwardRef<HTMLInputElement, QuantityInputProps>(function QuantityInput(
  { value, onChange, onCommit, onFocus, onBlur, onKeyDown, tipo = 'cantidad', confirmarDesde, ...rest },
  ref,
) {
  /** La cantidad que tenía al entrar: a eso se vuelve si lo escrito se rechaza. */
  const alEntrarRef = React.useRef<string>('')
  // Las existencias no piden confirmación (un stock de 12.000 es normal); las cantidades de un renglón, sí.
  const umbral = confirmarDesde ?? (tipo === 'stock' ? 0 : CANTIDAD_ALTA)

  /** Termina la edición. Devuelve true si se rechazó (y ya se restauró y avisó). */
  function terminar(texto: string): boolean {
    const d = evaluarEntrada(tipo, texto, alEntrarRef.current)
    if (d.tipo !== 'aceptar') {
      onChange(alEntrarRef.current)
      toast.warning(d.mensaje, { duration: 10_000 })
      return true
    }
    const canonico = parseCurrencyInput(texto)
    const hayQueConfirmar =
      umbral > 0 &&
      Number.isFinite(umbral) &&
      texto.trim() !== alEntrarRef.current.trim() &&
      Number(canonico) >= umbral
    if (hayQueConfirmar && !window.confirm(`${textoSospecha('muy-alta')} ¿Confirma una cantidad de ${texto.trim()}?`)) {
      onChange(alEntrarRef.current)
      return true
    }
    // Lo aceptado es la base de lo próximo: el Enter y la salida del campo que le sigue no vuelven a preguntar.
    alEntrarRef.current = texto
    onCommit?.(canonico)
    return false
  }

  return (
    <Input
      ref={ref}
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => {
        alEntrarRef.current = value
        onFocus?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          // Enter con un código leído: se frena antes de que la pantalla lo use.
          if (terminar(e.currentTarget.value)) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
        }
        onKeyDown?.(e)
      }}
      onBlur={(e) => {
        terminar(e.currentTarget.value)
        onBlur?.(e)
      }}
      {...rest}
    />
  )
})
