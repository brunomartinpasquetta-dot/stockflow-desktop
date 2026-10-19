/**
 * Topes de cantidades e importes (19-oct-2026).
 *
 * Un código de barras tipeado en un casillero numérico (el lector escribe
 * donde está el cursor) deja cantidades de 77.900.000.000.311 y totales de
 * $985.435.000.003.963.008. Además de frenarlo en la pantalla, el SERVIDOR
 * rechaza todo lo que supere estos topes, aunque la pantalla falle, la
 * terminal sea vieja o el pedido llegue por la red local.
 *
 * ESTE ES EL ÚNICO LUGAR donde se ajustan los topes. La pantalla (renderer)
 * y los servicios los importan de acá; ningún otro archivo repite estos
 * números. Este archivo no importa nada a propósito: lo lee también el
 * renderer sin arrastrar el resto del paquete.
 *
 * CÓMO SE ELIGIERON (máximos reales, con margen amplio):
 *  - Bases reales de Bruno (61.636 ventas, 92.273 renglones, 62.615 movimientos
 *    de caja): cantidad máxima vendida 65; precio unitario máximo $198.000;
 *    total de venta máximo $210.500; precio de lista máximo $898.900; apertura
 *    de caja máxima $934.300; cierre máximo $4.180.660; stock máximo 909.
 *  - Los topes dejan pasar con holgura lo que un comercio puede hacer de
 *    verdad: 100.000 unidades de un artículo barato en una compra, un arma de
 *    $3.000.000, un bien de varios millones. No dejan pasar un código de
 *    barras de 12 o 13 dígitos (siempre mayor que cualquiera de estos topes) ni
 *    la mayoría de los de 9 a 11 dígitos. Los de 8 dígitos (EAN-8) y los
 *    internos más cortos los frena la pantalla, que mira la forma del número.
 */
export const TOPES = {
  /** Cantidad de un renglón de venta, compra, presupuesto, devolución o promoción. */
  cantidad: 1_000_000,
  /** Stock de un artículo (existencia, mínimo, ideal y cantidad mínima mayorista). */
  stock: 100_000_000,
  /** Precio unitario, costo, precio de lista y descuento de un renglón (en pesos). */
  precio: 100_000_000,
  /**
   * Importe total: renglón, venta, compra, presupuesto, descuento global,
   * pago, cobranza, movimiento de caja, apertura, cierre y límite de crédito.
   */
  importe: 1_000_000_000,
} as const;

export type ClaveDeTope = keyof typeof TOPES;

/** Texto de rechazo para importes (precio, descuento, pago, total, caja). */
export const MENSAJE_IMPORTE_ALTO =
  'El importe ingresado es inusualmente alto. Verifique que no sea un código de barras.';

/** Texto de rechazo para cantidades y stock. */
export const MENSAJE_CANTIDAD_ALTA =
  'La cantidad ingresada es inusualmente alta. Verifique que no sea un código de barras.';

/** El mensaje que corresponde a cada tope. */
export function mensajeDeTope(clave: ClaveDeTope): string {
  return clave === 'cantidad' || clave === 'stock' ? MENSAJE_CANTIDAD_ALTA : MENSAJE_IMPORTE_ALTO;
}

/**
 * ¿El valor supera el tope? Un valor que no es número finito (NaN, Infinity,
 * notación científica desbordada) también cuenta como excedido. Se compara el
 * valor absoluto: el arqueo de una caja en rojo es negativo, y un -7790000000031
 * es tan absurdo como el positivo.
 */
export function superaElTope(valor: string | number | null | undefined, clave: ClaveDeTope): boolean {
  if (valor == null || valor === '') return false;
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isFinite(n)) return true;
  return Math.abs(n) > TOPES[clave];
}
