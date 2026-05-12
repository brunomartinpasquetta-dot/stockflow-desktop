/**
 * Lógica de precios / IVA del lado del renderer (espejo de @stockflow/core/pricing,
 * que no se puede importar desde acá). El backend re-calcula todo de forma autoritativa;
 * esto es para el preview en vivo del PDV.
 */
import type { ArticleDTO, CustomerDTO } from '@/types/api'

export type PriceMode = 'gross' | 'net'

function n(v: string | number | null | undefined): number {
  const x = typeof v === 'string' ? Number(v) : (v ?? 0)
  return Number.isFinite(x) ? x : 0
}

/** Precio unitario según lista del cliente / precio mayorista (si quantity >= wholesaleMinQty). */
export function resolvePrice(article: ArticleDTO, customer: CustomerDTO | null, quantity: string | number): string {
  if (n(article.wholesalePrice) > 0 && n(quantity) >= n(article.wholesaleMinQty)) {
    return article.wholesalePrice
  }
  switch (customer?.priceList) {
    case 2:
      return article.listPrice2
    case 3:
      return article.listPrice3
    default:
      return article.listPrice1
  }
}

/**
 * Desglosa un importe en { net, vat, gross } según el modo de precios:
 *  - 'gross': el importe ya incluye IVA → vat = importe*rate/(100+rate), net = importe - vat.
 *  - 'net': el importe es neto → vat = importe*rate/100, gross = importe + vat.
 */
export function vatBreakdown(
  amount: string | number,
  vatRate: string | number,
  mode: PriceMode = 'gross',
): { net: number; vat: number; gross: number } {
  const a = n(amount)
  const r = n(vatRate)
  if (r <= 0) return { net: a, vat: 0, gross: a }
  if (mode === 'net') {
    const vat = (a * r) / 100
    return { net: a, vat, gross: a + vat }
  }
  const vat = (a * r) / (100 + r)
  return { net: a - vat, vat, gross: a }
}

/** IVA contenido en un importe que ya lo incluye (atajo de `vatBreakdown(..., 'gross').vat`). */
export function vatContained(grossAmount: string | number, vatRate: string | number): number {
  return vatBreakdown(grossAmount, vatRate, 'gross').vat
}

export interface SaleLineInput {
  quantity: string | number
  unitPrice: string | number
  discount?: string | number
  vatRate?: string | number
}

export interface SaleTotals {
  /** suma de los lineTotal (con IVA en 'gross', neto en 'net') */
  subtotal: string
  vatAmount: string
  /** total final efectivo a cobrar */
  total: string
  priceMode: PriceMode
}

/** Totales de la venta (preview). Replica el criterio de SaleRepository.createWithLines. */
export function calculateSaleTotals(
  lines: ReadonlyArray<SaleLineInput>,
  globalDiscount: string | number = 0,
  mode: PriceMode = 'gross',
): SaleTotals {
  let subtotal = 0
  let vatAmount = 0
  for (const l of lines) {
    const lt = n(l.quantity) * n(l.unitPrice) - n(l.discount)
    subtotal += lt
    vatAmount += vatBreakdown(lt, l.vatRate ?? '21.00', mode).vat
  }
  const total = mode === 'gross' ? subtotal - n(globalDiscount) : subtotal + vatAmount - n(globalDiscount)
  return { subtotal: subtotal.toFixed(4), vatAmount: vatAmount.toFixed(4), total: total.toFixed(4), priceMode: mode }
}

export function lineTotal(l: SaleLineInput): string {
  return (n(l.quantity) * n(l.unitPrice) - n(l.discount)).toFixed(4)
}
