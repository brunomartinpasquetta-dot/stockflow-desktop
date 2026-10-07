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
  /** El foco llegó con el TECLADO (Tab) y no con un clic del mouse (:focus-visible). */
  focusVisible?: boolean
}

/**
 * Qué hacer con un Enter según dónde esté el foco. El Enter confirma desde
 * CUALQUIER lugar de la pantalla —después de destildar una casilla, de cambiar
 * una lista, de editar una cantidad, de apretar un botón con el mouse— y no sólo
 * con el cursor en el buscador (Bruno, 6-oct-2026: "si toco cualquier otra cosa,
 * cuando presiono Enter no ejecuta la venta"):
 *  - buscador: tiene su propio Enter (carga el artículo; vacío, confirma).
 *  - propio: el elemento resuelve el Enter por sí mismo —un botón o enlace al que
 *    se llegó con Tab (ver `vigilarOrigenDelFoco`), un área de texto— y no se lo pisa.
 *  - confirmar: todo lo demás (casillas, listas, campos de texto, el fondo, y un
 *    botón que sólo quedó enfocado por un clic del mouse).
 */
export type DestinoDelEnter = 'buscador' | 'propio' | 'confirmar'

export function destinoDelEnter(el: ElementoDelEnter | null, esBuscador: boolean): DestinoDelEnter {
  if (esBuscador) return 'buscador'
  if (!el) return 'confirmar'
  const tag = (el.tagName ?? '').toUpperCase()
  const tipo = (el.type ?? '').toLowerCase()
  const esBoton =
    tag === 'BUTTON' ||
    tag === 'A' ||
    tag === 'SUMMARY' ||
    el.role === 'button' ||
    (tag === 'INPUT' && (tipo === 'button' || tipo === 'submit' || tipo === 'reset'))
  if (esBoton) return el.focusVisible ? 'propio' : 'confirmar'
  if (tag === 'TEXTAREA' || el.isContentEditable) return 'propio'
  return 'confirmar'
}

/**
 * ¿El foco actual llegó con el teclado (Tab) o con un clic del mouse?
 *
 * No se puede preguntar `:focus-visible` en el momento del Enter: el propio
 * Enter cuenta como "uso de teclado" y el navegador marca como enfocado-con-
 * teclado a un botón que se apretó con el mouse (probado en la ventana real:
 * Enter dejaba de confirmar después de tocar «Imprimir último ticket»). Se
 * anota, en el momento de enfocar, qué pasó último: un Tab o un clic.
 */
export function vigilarOrigenDelFoco(doc: Document = document): {
  focoPorTeclado: (el: Element | null) => boolean
  detener: () => void
} {
  let ultimoClic = 0
  let ultimoTab = 0
  let elemento: Element | null = null
  let porTeclado = false
  const alClic = (): void => {
    ultimoClic = performance.now()
  }
  const alTeclado = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') ultimoTab = performance.now()
  }
  const alEnfocar = (e: FocusEvent): void => {
    elemento = e.target instanceof Element ? e.target : null
    porTeclado = ultimoTab > ultimoClic
  }
  doc.addEventListener('mousedown', alClic, true)
  doc.addEventListener('keydown', alTeclado, true)
  doc.addEventListener('focusin', alEnfocar, true)
  return {
    focoPorTeclado: (el) => el != null && el === elemento && porTeclado,
    detener: () => {
      doc.removeEventListener('mousedown', alClic, true)
      doc.removeEventListener('keydown', alTeclado, true)
      doc.removeEventListener('focusin', alEnfocar, true)
    },
  }
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
