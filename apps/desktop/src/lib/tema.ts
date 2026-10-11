/**
 * Tema claro / oscuro (pedido de Bruno, 10-oct-2026).
 *
 * Tres opciones: «claro», «oscuro» y «según el dispositivo». La elección se
 * recuerda EN ESTA PC (localStorage), no en la base: el tema es de la pantalla
 * en la que uno trabaja, no del comercio. Una tablet puede ir en oscuro y la
 * PC del mostrador en claro, con los mismos datos.
 *
 * Por defecto CLARO (Bruno, 10-oct-2026: «el tema por defecto igual es el
 * blanco»): al actualizar nadie nota ningún cambio. El oscuro se elige a mano
 * —un clic en la barra de estado, al lado del usuario— o, desde Configuración,
 * «según el dispositivo» para una tablet que ya anda en oscuro.
 *
 * Se aplica poniendo la clase `dark` en <html> (tailwind `darkMode: 'class'`,
 * variables en index.css). Como todas las ventanas de la app comparten el
 * mismo almacenamiento, el cambio en una se propaga a las demás por el evento
 * `storage`.
 */

export type Tema = 'claro' | 'oscuro' | 'sistema'

const CLAVE = 'stockflow:tema'
const TEMAS: readonly Tema[] = ['claro', 'oscuro', 'sistema']

export const ETIQUETAS_TEMA: Record<Tema, string> = {
  claro: 'Claro',
  oscuro: 'Oscuro',
  sistema: 'Según el dispositivo',
}

/** Lo elegido en esta PC; si nunca se tocó, claro. */
export function leerTema(): Tema {
  try {
    const v = localStorage.getItem(CLAVE)
    return (TEMAS as readonly string[]).includes(v ?? '') ? (v as Tema) : 'claro'
  } catch {
    return 'claro'
  }
}

export function guardarTema(tema: Tema): void {
  try {
    localStorage.setItem(CLAVE, tema)
  } catch {
    /* sin almacenamiento: vale sólo para esta sesión */
  }
  aplicarTema(tema)
}

/**
 * ¿Oscuro o no? Función pura, separada para poder probarla sin navegador:
 * la decisión depende de la preferencia y de si el dispositivo está en oscuro.
 */
export function debeIrOscuro(tema: Tema, dispositivoOscuro: boolean): boolean {
  if (tema === 'oscuro') return true
  if (tema === 'claro') return false
  return dispositivoOscuro
}

function dispositivoEnOscuro(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

/** Pone o saca la clase `dark` en <html> según la preferencia. */
export function aplicarTema(tema: Tema = leerTema()): void {
  if (typeof document === 'undefined') return
  const oscuro = debeIrOscuro(tema, dispositivoEnOscuro())
  document.documentElement.classList.toggle('dark', oscuro)
  // Avisa a la propia ventana (el Toaster y cualquier componente que lo mire).
  try {
    window.dispatchEvent(new CustomEvent('stockflow:tema', { detail: { tema, oscuro } }))
  } catch {
    /* entorno sin CustomEvent: no pasa nada */
  }
}

/** ¿La pantalla está en oscuro ahora mismo? */
export function estaEnOscuro(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

/**
 * Arranque: aplica el tema y queda escuchando dos cosas —que cambie la
 * preferencia desde OTRA ventana de la app (evento `storage`) y que el
 * dispositivo cambie de claro a oscuro mientras la app está abierta.
 */
export function iniciarTema(): void {
  aplicarTema()
  try {
    window.addEventListener('storage', (e) => {
      if (e.key === CLAVE || e.key === null) aplicarTema()
    })
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => aplicarTema())
  } catch {
    /* sin matchMedia (entornos de prueba): ya quedó aplicado una vez */
  }
}
