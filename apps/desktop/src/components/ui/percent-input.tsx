/**
 * <PercentInput>
 *
 * Casillero de PORCENTAJE (descuento en %). Es el `<input type="number">` de
 * siempre, con una defensa contra el lector de códigos de barras (19-oct-2026):
 * al terminar de editar (salir del campo o Enter) un porcentaje mayor que 100,
 * o con forma de código de barras, NO se acepta: vuelve el valor que tenía y se
 * avisa. Un `max="100"` de HTML no impide tipear 7790000000031.
 */
import * as React from 'react'
import { toast } from 'sonner'

import { AVISO_PORCENTAJE, porcentajeValido } from '@/lib/entradaNumerica'

export interface PercentInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string
  onChange: (valor: string) => void
}

export function PercentInput({ value, onChange, onFocus, onBlur, onKeyDown, ...rest }: PercentInputProps) {
  const alEntrarRef = React.useRef<string>('')
  /** true si se rechazó (ya se restauró y avisó). */
  function terminar(texto: string): boolean {
    if (porcentajeValido(texto)) {
      alEntrarRef.current = texto
      return false
    }
    onChange(alEntrarRef.current)
    toast.warning(`${AVISO_PORCENTAJE} Se mantuvo el valor anterior.`, { duration: 10_000 })
    return true
  }
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => {
        alEntrarRef.current = value
        onFocus?.(e)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && terminar(e.currentTarget.value)) {
          e.preventDefault()
          e.stopPropagation()
          return
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
}
