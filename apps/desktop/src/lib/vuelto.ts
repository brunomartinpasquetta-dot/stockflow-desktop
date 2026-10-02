/**
 * Calculador de vuelto de Ventas (casilla "Calcular vuelto").
 *
 * Es SÓLO informativo: no cambia lo que se registra. Los pagos siguen sumando
 * exactamente el total de la venta (así quedó desde mayo de 2026, cuando se
 * sacó el "Recibido/Vuelto" del cobro), y el vuelto se calcula sobre lo que se
 * cobra en EFECTIVO: con pago mixto, sobre la parte en efectivo.
 */
export interface Vuelto {
  /** Lo que hay que devolverle al cliente. */
  vuelto: number
  /** Lo que falta si el billete no alcanza. */
  falta: number
}

export function calcularVuelto(pagaCon: number, enEfectivo: number): Vuelto {
  if (!Number.isFinite(pagaCon) || !Number.isFinite(enEfectivo) || pagaCon <= 0 || enEfectivo <= 0) {
    return { vuelto: 0, falta: 0 }
  }
  const diferencia = Number((pagaCon - enEfectivo).toFixed(2))
  return diferencia >= 0 ? { vuelto: diferencia, falta: 0 } : { vuelto: 0, falta: -diferencia }
}

const CLAVE = 'stockflow:ventas:calcularVuelto'

/** La casilla se recuerda en cada PC (cada caja decide si la usa). */
export function leerPreferenciaVuelto(): boolean {
  try {
    return localStorage.getItem(CLAVE) === '1'
  } catch {
    return false
  }
}

export function guardarPreferenciaVuelto(activo: boolean): void {
  try {
    localStorage.setItem(CLAVE, activo ? '1' : '0')
  } catch {
    /* sin almacenamiento: vale sólo para esta sesión */
  }
}
