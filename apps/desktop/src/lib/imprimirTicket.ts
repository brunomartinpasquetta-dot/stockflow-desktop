/**
 * "Imprimir ticket" (casilla de Ventas / Configuración → Impresora).
 *
 * El valor vive en la configuración de la impresora, pero una PC que nunca
 * guardó esa configuración (instalación nueva, migrada, terminal por navegador)
 * NO tiene dónde guardarlo: destildar la casilla en Ventas valía sólo hasta
 * recargar y las devoluciones, que leen la configuración, seguían imprimiendo
 * (Bruno, 6-oct-2026). Por eso la elección también se recuerda en cada PC.
 *
 * Qué manda: la configuración de la impresora si trae el valor; si no, lo que se
 * eligió en esta PC; si nunca se tocó, activado (como siempre).
 */

const CLAVE = 'stockflow:ventas:imprimirTicket'

/** Lo elegido en esta PC; null si nunca se tocó (o no hay almacenamiento). */
export function leerImprimirTicketLocal(): boolean | null {
  try {
    const v = localStorage.getItem(CLAVE)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

export function guardarImprimirTicketLocal(activo: boolean): void {
  try {
    localStorage.setItem(CLAVE, activo ? '1' : '0')
  } catch {
    /* sin almacenamiento: vale sólo para esta sesión */
  }
}

export function imprimirTicketActivado(cfg: { autoPrintOnSale?: boolean } | null | undefined): boolean {
  if (cfg && typeof cfg.autoPrintOnSale === 'boolean') return cfg.autoPrintOnSale
  return leerImprimirTicketLocal() ?? true
}
