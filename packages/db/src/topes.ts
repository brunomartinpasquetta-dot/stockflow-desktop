/**
 * Verificaciones de topes sobre lo que CALCULA el servidor (totales de venta,
 * compra y presupuesto) y sobre los datos que no pasan por un esquema zod. Los
 * topes de lo que llega de la pantalla los aplican los esquemas de
 * `@stockflow/shared`; todos salen de `limites.ts` de ese paquete.
 *
 * Los avisos son para el usuario: sin prefijo técnico, en tono formal.
 */
import { mensajeDeTope, superaElTope, type ClaveDeTope } from '@stockflow/shared';

import { ValidationError } from './errors';

/** Rechaza un valor suelto que supera el tope (el aviso es el del tope). */
export function exigirDentroDelTope(campo: string, valor: string | number | null | undefined, clave: ClaveDeTope): void {
  if (superaElTope(valor, clave)) throw new ValidationError(campo, mensajeDeTope(clave));
}

export type ComprobanteConTotales = 'venta' | 'compra' | 'presupuesto';

/**
 * Los totales que arma el servidor no pueden ser negativos ni superar el tope
 * de importe. Pasa por acá toda venta, compra y presupuesto ANTES de escribir:
 * si algo no cierra, no queda nada en la base.
 *
 *  - Cada renglón: importe de 0 a tope. Un descuento mayor que el importe lo
 *    deja en negativo.
 *  - El subtotal y el total: de 0 a tope. Un descuento global mayor que el
 *    subtotal deja el total en negativo (y una venta a cuenta corriente
 *    «cobraba» un importe negativo).
 */
export function exigirTotalesRazonables(
  t: { lineas: ReadonlyArray<string | number>; subtotal: string | number; total: string | number },
  comprobante: ComprobanteConTotales,
): void {
  const de = comprobante === 'venta' ? 'la venta' : comprobante === 'compra' ? 'la compra' : 'el presupuesto';
  for (const l of t.lineas) {
    if (superaElTope(l, 'importe')) throw new ValidationError('lines', mensajeDeTope('importe'));
    if (Number(l) < -0.005) {
      throw new ValidationError('lines', 'El descuento de un renglón no puede superar su importe. Revise el descuento ingresado.');
    }
  }
  if (superaElTope(t.subtotal, 'importe') || superaElTope(t.total, 'importe')) {
    throw new ValidationError('total', mensajeDeTope('importe'));
  }
  if (Number(t.total) < -0.005) {
    throw new ValidationError('discount', `El descuento no puede superar el total de ${de}. Revise el descuento ingresado.`);
  }
}
