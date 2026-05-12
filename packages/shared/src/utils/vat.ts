/**
 * Desglose de IVA según el "modo de precios" de la empresa.
 *
 *  - 'gross' (default): el importe YA incluye IVA ("IVA contenido").
 *      vat  = importe * rate / (100 + rate)
 *      net  = importe - vat
 *      gross = importe
 *  - 'net': el importe es neto y el IVA se agrega.
 *      net   = importe
 *      vat   = importe * rate / 100
 *      gross = importe + vat
 *
 * Devuelve siempre los tres valores como strings con 4 decimales.
 */
import { addDecimal, decimalString, subDecimal } from './decimal';

export type PriceMode = 'gross' | 'net';

export function vatBreakdown(
  amount: string | number,
  rate: string | number,
  mode: PriceMode = 'gross',
): { net: string; vat: string; gross: string } {
  const a = Number(amount);
  const r = Number(rate);
  const amt = decimalString(Number.isFinite(a) ? a : 0, 4);
  if (!Number.isFinite(a) || !Number.isFinite(r) || r <= 0) {
    return { net: amt, vat: '0.0000', gross: amt };
  }
  if (mode === 'net') {
    const vat = decimalString((a * r) / 100, 4);
    return { net: amt, vat, gross: addDecimal(amt, vat, 4) };
  }
  const vat = decimalString((a * r) / (100 + r), 4);
  return { net: subDecimal(amt, vat, 4), vat, gross: amt };
}
