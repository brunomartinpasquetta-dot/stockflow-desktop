/**
 * "Enter confirma la venta".
 *
 * Un Enter con el buscador VACÍO y artículos cargados confirma la venta, igual
 * que F2: se carga el artículo, Enter, y listo. VIENE ACTIVADO (Bruno, 6-oct-2026:
 * lo pidió como comportamiento, no como una casilla para tildar); la casilla de
 * Opciones de venta sólo sirve para apagarlo en una PC donde moleste. Se recuerda
 * en cada PC.
 */

const CLAVE = 'stockflow:ventas:enterConfirma'

export function leerEnterConfirma(): boolean {
  try {
    return localStorage.getItem(CLAVE) !== '0'
  } catch {
    return true
  }
}

export function guardarEnterConfirma(activo: boolean): void {
  try {
    localStorage.setItem(CLAVE, activo ? '1' : '0')
  } catch {
    /* sin almacenamiento: vale sólo para esta sesión */
  }
}

/**
 * Un lector configurado con "CR+LF" manda DOS Enter pegados tras cada código:
 * el primero carga el artículo y el segundo, sin este margen, confirmaría la
 * venta. Una persona no repite Enter en menos de esto.
 */
export const MS_ENTRE_AGREGAR_Y_CONFIRMAR = 250

export interface EstadoDelEnter {
  /** La casilla "Enter confirma la venta". */
  activo: boolean
  /** Lo escrito en el buscador. */
  busqueda: string
  hayArticulos: boolean
  /** Lo mismo que habilita el botón "Confirmar venta". */
  puedeConfirmar: boolean
  /** Tecla mantenida apretada: el sistema la repite, no es una decisión. */
  repetida: boolean
  msDesdeElUltimoArticulo: number
}

export function enterDebeConfirmar(s: EstadoDelEnter): boolean {
  return (
    s.activo &&
    !s.repetida &&
    s.busqueda.trim() === '' &&
    s.hayArticulos &&
    s.puedeConfirmar &&
    s.msDesdeElUltimoArticulo >= MS_ENTRE_AGREGAR_Y_CONFIRMAR
  )
}
