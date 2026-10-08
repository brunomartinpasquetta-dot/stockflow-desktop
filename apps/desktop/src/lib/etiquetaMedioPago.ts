/**
 * Cómo se lee una forma de pago en los desplegables.
 *
 * A los medios que son plata en mano se les agregaba «(efectivo)» para que el
 * cajero supiera cuáles cuentan en el arqueo del cajón. El problema es que el
 * medio suele llamarse justamente «Efectivo», y quedaba «Efectivo (efectivo)»
 * (Bruno, 8-oct-2026: "¿para qué aclarás? no entiendo"). La aclaración sólo
 * aparece cuando el nombre no lo dice ya: «Caja chica (efectivo)» sí, «Efectivo»
 * a secas no.
 */
const sinAcentos = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function etiquetaMedioPago(medio: { name: string; isPhysicalCash?: boolean }): string {
  const nombre = (medio.name ?? '').trim();
  if (!medio.isPhysicalCash) return nombre;
  return /efectivo|contado/.test(sinAcentos(nombre)) ? nombre : `${nombre} (efectivo)`;
}
