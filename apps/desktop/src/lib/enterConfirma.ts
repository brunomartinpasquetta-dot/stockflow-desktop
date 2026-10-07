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

/** Lo mínimo que hace falta saber del elemento que tiene el foco. */
export interface ElementoDelEnter {
  tagName?: string
  type?: string
  role?: string | null
  isContentEditable?: boolean
}

/**
 * Qué hacer con un Enter según dónde esté el foco. El Enter confirma desde
 * CUALQUIER lugar de la pantalla —después de destildar una casilla, de cambiar
 * una lista, de hacer clic en blanco— y no sólo con el cursor en el buscador:
 *  - buscador: tiene su propio Enter (carga el artículo; vacío, confirma).
 *  - boton: Enter ya lo activa; no se le suma otra acción.
 *  - campo: se está escribiendo (cantidad, precio, documento…): Enter acepta el
 *    campo y vuelve al buscador, así el siguiente Enter ya confirma.
 *  - libre: casilla, lista desplegable o fondo; ahí Enter no hace nada propio.
 */
export type DestinoDelEnter = 'buscador' | 'boton' | 'campo' | 'libre'

export function destinoDelEnter(el: ElementoDelEnter | null, esBuscador: boolean): DestinoDelEnter {
  if (esBuscador) return 'buscador'
  if (!el) return 'libre'
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' || el.role === 'button') return 'boton'
  if (tag === 'TEXTAREA' || el.isContentEditable) return 'campo'
  if (tag === 'INPUT') {
    const tipo = (el.type ?? 'text').toLowerCase()
    if (tipo === 'checkbox' || tipo === 'radio') return 'libre'
    if (tipo === 'button' || tipo === 'submit' || tipo === 'reset') return 'boton'
    return 'campo'
  }
  return 'libre'
}

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
