/**
 * Importes de un comprobante tal como los exige ARCA (WSFEv1).
 *
 * ARCA valida tres identidades AL CENTAVO y, si alguna falla, rechaza el
 * comprobante (10048 y familia). Como el reintento repite el mismo cálculo, la
 * venta queda infacturable:
 *   1. ImpNeto + ImpIVA = ImpTotal
 *   2. ImpNeto = Σ BaseImp de las alícuotas
 *   3. ImpIVA  = Σ Importe de las alícuotas
 *
 * Lo que las rompía: el IVA se calculaba con 4 decimales y neto e IVA se
 * redondeaban por separado ($1006 @21 % → 831,41 + 174,60 = 1006,01); las
 * bases de las alícuotas salían de las líneas SIN el descuento global
 * prorrateado mientras el neto sí lo llevaba (toda factura con descuento se
 * rechazaba); y con dos alícuotas la suma de bases redondeadas no daba el neto
 * redondeado (uno de cada cuatro totales).
 *
 * Cómo se garantiza acá: el total a 2 decimales es el dato fijo, porque es lo
 * que pagó el cliente. Se reparte EN CENTAVOS entre las alícuotas —cada una con
 * su bruto redondeado y el resto de redondeo en la mayor— y dentro de cada
 * alícuota el IVA se redondea y la base es bruto − IVA. Cada identidad se
 * cumple por construcción, y el IVA de cada alícuota nunca se aparta más de
 * medio centavo de base × tasa.
 */
import { mulDecimal, subDecimal, sumDecimals } from '../utils/decimal';
import { vatBreakdown, type PriceMode } from '../utils/vat';

import { VAT_IDS } from './arca';

/** Alícuota ("21.00") a partir del id de ARCA, inverso de `VAT_IDS`. */
export const VAT_RATE_BY_ID: Record<number, string> = Object.fromEntries(
  Object.entries(VAT_IDS).map(([rate, id]) => [id, rate]),
);

export interface ArcaLineInput {
  /** Importe de la línea ya con su descuento de renglón (con IVA en 'gross', neto en 'net'). */
  lineTotal: string | number;
  vatRate: string | number | null | undefined;
}

export interface ArcaVatDetail {
  /** Id de alícuota de ARCA (`Iva.Id`). */
  id: number;
  /** Alícuota normalizada ("21.00"), para persistir e imprimir. */
  rate: string;
  baseAmount: number;
  amount: number;
}

export interface ArcaAmounts {
  netAmount: number;
  vatAmount: number;
  total: number;
  /** Ordenado por alícuota ascendente; sin renglones de importe cero. */
  vatDetails: ArcaVatDetail[];
}

/**
 * Conversión a CENTAVOS enteros, que es la unidad en que ARCA valida (2
 * decimales). No es un cálculo sobre los importes de 4 decimales del sistema
 * —para eso están los helpers de `decimal`—: acá se pasa a la unidad de ARCA
 * una sola vez y de ahí en más todo es aritmética entera, que no arrastra
 * error de redondeo.
 */
function cents(v: string | number): number {
  return Math.round(Number(v) * 100);
}

/**
 * Neto, IVA, total y detalle por alícuota de un comprobante, a 2 decimales y
 * con las tres identidades garantizadas.
 *
 * El total se calcula con la MISMA regla que `SaleRepository.createWithLines`
 * (descuento global prorrateado sobre las líneas antes del IVA), así coincide
 * con el `total` de la venta que se cobró.
 */
export function arcaAmounts(
  lines: ReadonlyArray<ArcaLineInput>,
  discount: string | number = 0,
  mode: PriceMode = 'gross',
): ArcaAmounts {
  const subtotal = sumDecimals(lines.map((l) => l.lineTotal));
  const discountNum = Number(discount);
  const subtotalNum = Number(subtotal);
  const prorate =
    Number.isFinite(discountNum) && discountNum !== 0 && Number.isFinite(subtotalNum) && subtotalNum !== 0;

  // Bruto por alícuota (con IVA), con el descuento global ya prorrateado.
  const grossByRate = new Map<string, number>();
  let vatTotal = 0;
  for (const l of lines) {
    const rate = Number(l.vatRate ?? 21);
    const key = (Number.isFinite(rate) && rate > 0 ? rate : 0).toFixed(2);
    const lineDiscount = prorate
      ? mulDecimal(discount, (Number(l.lineTotal) / subtotalNum).toFixed(8), 4)
      : '0.0000';
    const baseLine = subDecimal(l.lineTotal, lineDiscount, 4);
    const br = vatBreakdown(baseLine, key, mode);
    vatTotal += Number(br.vat);
    grossByRate.set(key, (grossByRate.get(key) ?? 0) + Number(br.gross));
  }

  // Total cobrado, con la regla de la venta: en 'gross' el subtotal ya incluye
  // IVA; en 'net' se le suma el IVA calculado sobre las líneas descontadas.
  const disc = Number.isFinite(discountNum) ? discountNum : 0;
  const totalNum =
    mode === 'net' ? Number(subtotal) + vatTotal - disc : Number(subtotal) - disc;
  const totalC = cents(totalNum.toFixed(4));

  // Reparto del total EN CENTAVOS entre las alícuotas: cada una lleva su bruto
  // redondeado y el resto de redondeo va a la mayor, así Σ brutos = total.
  const groups = [...grossByRate.entries()]
    .map(([key, gross]) => ({ key, rate: Number(key), grossC: cents(gross.toFixed(4)) }))
    .filter((g) => g.grossC !== 0)
    .sort((a, b) => a.rate - b.rate);
  const residual = totalC - groups.reduce((acc, g) => acc + g.grossC, 0);
  if (residual !== 0 && groups.length > 0) {
    const mayor = groups.reduce((m, g) => (g.grossC > m.grossC ? g : m), groups[0]!);
    mayor.grossC += residual;
  }

  const vatDetails: ArcaVatDetail[] = [];
  let netC = 0;
  let vatC = 0;
  for (const g of groups) {
    const amountC = g.rate > 0 ? Math.round((g.grossC * g.rate) / (100 + g.rate)) : 0;
    const baseC = g.grossC - amountC;
    netC += baseC;
    vatC += amountC;
    vatDetails.push({
      id: VAT_IDS[g.key as keyof typeof VAT_IDS] ?? VAT_IDS['21.00'],
      rate: g.key,
      baseAmount: baseC / 100,
      amount: amountC / 100,
    });
  }
  // Sin alícuotas (venta de importe cero): todo el total es neto, para que la
  // identidad 1 se sostenga igual.
  if (groups.length === 0) netC = totalC;

  return { netAmount: netC / 100, vatAmount: vatC / 100, total: totalC / 100, vatDetails };
}
