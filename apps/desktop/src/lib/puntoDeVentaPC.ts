/**
 * PUNTO DE VENTA RECORDADO POR PC (ítem 15 del plan multisucursal).
 *
 * Con varios puntos de venta (una caja con su PV, o mañana una sucursal con
 * el suyo), cada PC factura casi siempre con el mismo. Ventas lo recuerda en
 * ESTA PC y lo usa por defecto; con un solo PV activo no cambia nada (el
 * selector ni aparece).
 *
 * Por qué localStorage y no `sale_points.terminal_id`: es una preferencia de
 * la PC, no un dato del comercio. En Electron cada PC tiene su propio
 * almacenamiento (también las terminales) y en el navegador cada navegador
 * el suyo, así que no hace falta tocar la base ni el servidor, y dos PC
 * pueden compartir el mismo PV sin pisarse (`terminal_id` admite una sola PC
 * por PV). La asignación de PV a una sucursal es otra cosa y va en la etapa 3
 * (`sale_points.branch_id`); el recordado se elige siempre entre los activos.
 */

const CLAVE = 'stockflow.ventas.puntoDeVenta'

/** El PV que se usó por última vez en esta PC, o null. Sin localStorage (modo privado) = null. */
export function leerPuntoDeVentaPC(): number | null {
  try {
    const n = Number(localStorage.getItem(CLAVE))
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function guardarPuntoDeVentaPC(numero: number): void {
  try {
    if (Number.isInteger(numero) && numero > 0) localStorage.setItem(CLAVE, String(numero))
  } catch {
    /* sin localStorage: vale para esta sesión */
  }
}

/**
 * PV con que se factura: el elegido en pantalla, si no el recordado en esta
 * PC, si no el primero activo. Sólo se aceptan PV activos: si el recordado se
 * dio de baja, se cae al primero.
 */
export function elegirPuntoDeVenta(
  activos: ReadonlyArray<{ number: number }>,
  elegido: number | null,
  recordado: number | null = leerPuntoDeVentaPC(),
): number | null {
  const activo = (n: number | null): n is number => n != null && activos.some((p) => p.number === n)
  if (activo(elegido)) return elegido
  if (activo(recordado)) return recordado
  return activos[0]?.number ?? null
}
