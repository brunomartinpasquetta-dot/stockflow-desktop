/**
 * "Contar por día de caja": opción de los filtros por fecha de ventas.
 *
 * Apagada (por defecto) cada venta cuenta por su hora real, como siempre.
 * Prendida, cuenta para el día en que se abrió su caja: lo vendido el martes a
 * la 1:30 con la caja del lunes abierta es del lunes. Sirve al comercio que
 * trabaja de noche; al que abre y cierra de día no le cambia nada.
 *
 * Es una OPCIÓN y no un cambio de criterio a propósito: redefinir "día" para
 * todos rompía "hoy" a la madrugada (resumen del día, anular las de hoy) y les
 * cambiaba los números a todos los comercios. Se recuerda en cada PC.
 */
import { useState } from 'react'

const CLAVE = 'stockflow:filtros:porCaja'

export function usePorCaja(): [boolean, (v: boolean) => void] {
  const [valor, setValor] = useState<boolean>(() => {
    try {
      return localStorage.getItem(CLAVE) === '1'
    } catch {
      return false
    }
  })
  const cambiar = (v: boolean): void => {
    setValor(v)
    try {
      localStorage.setItem(CLAVE, v ? '1' : '0')
    } catch {
      /* sin almacenamiento: queda sólo para esta sesión */
    }
  }
  return [valor, cambiar]
}

export function PorCajaToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
      title="Cada venta cuenta para el día en que se abrió su caja: lo vendido después de medianoche con la caja del día anterior abierta va a ese día."
    >
      <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={value} onChange={(e) => onChange(e.target.checked)} />
      Contar por día de caja
    </label>
  )
}
