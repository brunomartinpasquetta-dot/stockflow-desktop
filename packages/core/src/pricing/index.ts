/**
 * Lógica de precios e impuestos. Funciones puras: no tocan la DB.
 *
 * Los importes viajan como string (precisión exacta). Para el MVP se hacen las
 * cuentas con `Number` + helpers de `@stockflow/shared`.
 */
import {
  type Article,
  type Customer,
  type PriceMode,
  addDecimal,
  gteDecimal,
  mulDecimal,
  subDecimal,
  sumDecimals,
  vatBreakdown,
} from '@stockflow/shared';

export type { PriceMode } from '@stockflow/shared';
export { vatBreakdown } from '@stockflow/shared';

/**
 * Precio unitario que corresponde a una línea, según:
 *  - precio mayorista si `quantity >= article.wholesaleMinQty` y hay precio mayorista (> 0);
 *  - si no, la lista de precios del cliente (`priceList` 1/2/3).
 */
export function resolvePrice(article: Article, customer: Customer, quantity: string): string {
  if (Number(article.wholesalePrice) > 0 && gteDecimal(quantity, article.wholesaleMinQty)) {
    return article.wholesalePrice;
  }
  switch (customer.priceList) {
    case 2:
      return article.listPrice2;
    case 3:
      return article.listPrice3;
    case 1:
    default:
      return article.listPrice1;
  }
}

/** Aplica un descuento porcentual a un precio. `applyDiscount('100', '10') === '90.0000'`. */
export function applyDiscount(price: string, discountPct: string, decimals = 4): string {
  const p = Number(price);
  const d = Number(discountPct);
  if (!Number.isFinite(p) || !Number.isFinite(d)) {
    throw new RangeError(`Valores inválidos en applyDiscount: ${price}, ${discountPct}`);
  }
  return (p * (1 - d / 100)).toFixed(decimals);
}

/**
 * Desglosa IVA según el modo de precios de la empresa:
 *  - 'gross' (default): el importe ya incluye IVA ("IVA contenido").
 *  - 'net': el importe es neto y se le suma el IVA.
 * Devuelve siempre `{ net, vat, gross }`.
 */
export function calculateVAT(
  amount: string,
  vatRate: string,
  mode: PriceMode = 'gross',
): { net: string; vat: string; gross: string } {
  return vatBreakdown(amount, vatRate, mode);
}

export interface SaleTotalsLineInput {
  quantity: string;
  unitPrice: string;
  /** descuento absoluto sobre la línea (no porcentaje) */
  discount?: string;
  /** alícuota; default '21.00' */
  vatRate?: string;
}

export interface SaleTotalsLine extends Required<SaleTotalsLineInput> {
  lineNumber: number;
  /** importe de la línea = quantity*unitPrice - discount (con IVA en 'gross', neto en 'net') */
  lineTotal: string;
  net: string;
  vat: string;
}

export interface SaleTotals {
  lines: SaleTotalsLine[];
  /** suma de los lineTotal (con IVA en 'gross', neto en 'net') */
  subtotal: string;
  /** descuento global aplicado */
  discount: string;
  /** IVA total */
  vatAmount: string;
  /** total final efectivo a cobrar */
  total: string;
  /** modo con el que se calculó */
  priceMode: PriceMode;
}

/**
 * Calcula los totales de una venta a partir de sus líneas (función pura, para
 * preview en la UI). Replica el criterio que aplica `SaleRepository.createWithLines`.
 *
 *  - 'gross': subtotal ya incluye IVA → total = subtotal − descuento global.
 *  - 'net':   subtotal es neto → total = subtotal + IVA − descuento global.
 */
export function calculateSaleTotals(
  lines: ReadonlyArray<SaleTotalsLineInput>,
  globalDiscount = '0.0000',
  mode: PriceMode = 'gross',
): SaleTotals {
  const computed: SaleTotalsLine[] = lines.map((l, idx) => {
    const discount = l.discount ?? '0.0000';
    const vatRate = l.vatRate ?? '21.00';
    const lineTotal = subDecimal(mulDecimal(l.quantity, l.unitPrice, 4), discount, 4);
    const { net, vat } = vatBreakdown(lineTotal, vatRate, mode);
    return {
      lineNumber: idx + 1,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount,
      vatRate,
      lineTotal,
      net,
      vat,
    };
  });
  const subtotal = sumDecimals(computed.map((c) => c.lineTotal));
  const vatAmount = sumDecimals(computed.map((c) => c.vat));
  const total =
    mode === 'gross'
      ? subDecimal(subtotal, globalDiscount, 4)
      : subDecimal(addDecimal(subtotal, vatAmount, 4), globalDiscount, 4);
  return { lines: computed, subtotal, discount: globalDiscount, vatAmount, total, priceMode: mode };
}
