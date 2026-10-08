/**
 * Cuentas del cierre de caja.
 *
 * Réplica de `netoElectronico` / `totalParaCajaGeneral` de `@stockflow/shared`
 * (mismo criterio que `lib/cuit.ts` y `lib/format.ts`: la pantalla no importa
 * el paquete del servidor). Si se cambia una, se cambia la otra: que cada lado
 * calculara distinto es justamente lo que impedía cerrar la caja.
 */

/**
 * Cuánto cobró la caja por medios que NO son efectivo físico.
 *
 * El piso cero va AL FINAL, una sola vez. Poniéndolo por medio, con Tarjeta
 * +1000 y Transferencia −400 la pantalla mostraba 1000 y el servidor aceptaba
 * 600, y el cierre quedaba trabado. Una devolución por transferencia es plata
 * que el comercio devolvió: baja lo cobrado.
 */
export function netoElectronico(
  medios: ReadonlyArray<{ isPhysicalCash?: boolean | null; net?: string | number | null }>,
): string {
  let total = 0
  for (const m of medios) {
    if (m.isPhysicalCash) continue
    total += Number(m.net ?? 0)
  }
  return (total > 0 ? total : 0).toFixed(2)
}

/** Lo que pasa a Caja General: efectivo contado − cambio que queda + electrónico. */
export function totalParaCajaGeneral(
  efectivoContado: string | number,
  cambioQueQueda: string | number,
  electronico: string | number,
): { efectivo: string; electronico: string; total: string } {
  const bruto = Number(efectivoContado) - Number(cambioQueQueda)
  const efectivo = bruto > 0 ? bruto : 0
  return {
    efectivo: efectivo.toFixed(2),
    electronico: Number(electronico).toFixed(2),
    total: (efectivo + Number(electronico)).toFixed(2),
  }
}

/** El cambio no puede ser mayor que lo que hay contado en el cajón. */
export function cambioSuperaLoContado(
  efectivoContado: string | number,
  cambioQueQueda: string | number,
): boolean {
  return Number(cambioQueQueda) > Number(efectivoContado) + 0.005
}
