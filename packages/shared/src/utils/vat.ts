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
import { addDecimal, decimalString, mulDecimal, subDecimal } from './decimal';

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

/** Una línea para el prorrateo del descuento global sobre el IVA. */
export interface ProratedVatLine {
  /** importe de la línea (con IVA en 'gross', neto en 'net'), ya con su descuento de línea aplicado */
  lineTotal: string | number;
  /** alícuota de la línea */
  vatRate: string | number;
}

export interface ProratedVatResult {
  /** suma de las bases por línea tras prorratear el descuento global (== total en 'gross') */
  base: string;
  /** neto total (sin IVA) */
  net: string;
  /** IVA total prorrateado */
  vatAmount: string;
}

/**
 * Desglosa el IVA de una venta prorrateando el DESCUENTO GLOBAL de cabecera
 * sobre las líneas ANTES de calcular el IVA por línea. Es el cálculo canónico
 * para que se cumpla `net + vatAmount == total` (problema fiscal: Neto+IVA debe
 * coincidir con el Total efectivamente cobrado; sin esto el Libro IVA y la
 * posición IVA quedan inflados porque el descuento no baja la base imponible).
 *
 * Regla (modo 'gross'):
 *   lineDiscount_i = discount * lineTotal_i / subtotal
 *   baseLine_i     = lineTotal_i - lineDiscount_i
 *   vat_i          = vatBreakdown(baseLine_i, vatRate_i, 'gross').vat
 *   vatAmount      = Σ vat_i      (y Σ baseLine_i == total)
 *
 * En modo 'net' se aplica el mismo prorrateo del descuento sobre la base neta y
 * el IVA se calcula con la semántica 'net' de `vatBreakdown`.
 *
 * Casos borde:
 *   - discount == 0 → comportamiento idéntico al cálculo sin prorrateo.
 *   - subtotal == 0 → no se prorratea (evita división por cero).
 */
export function proratedVatBreakdown(
  lines: ReadonlyArray<ProratedVatLine>,
  discount: string | number,
  subtotal: string | number,
  mode: PriceMode = 'gross',
): ProratedVatResult {
  const discountNum = Number(discount);
  const subtotalNum = Number(subtotal);
  const prorate =
    Number.isFinite(discountNum) &&
    discountNum !== 0 &&
    Number.isFinite(subtotalNum) &&
    subtotalNum !== 0;

  let base = '0.0000';
  let net = '0.0000';
  let vatAmount = '0.0000';
  for (const l of lines) {
    const lineDiscount = prorate
      ? mulDecimal(discount, (Number(l.lineTotal) / subtotalNum).toFixed(8), 4)
      : '0.0000';
    const baseLine = subDecimal(l.lineTotal, lineDiscount, 4);
    const br = vatBreakdown(baseLine, l.vatRate, mode);
    base = addDecimal(base, baseLine, 4);
    net = addDecimal(net, br.net, 4);
    vatAmount = addDecimal(vatAmount, br.vat, 4);
  }
  return { base, net, vatAmount };
}
