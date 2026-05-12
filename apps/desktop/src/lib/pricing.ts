/**
 * Lógica de precios / IVA del lado del renderer (espejo de @stockflow/core/pricing,
 * que no se puede importar desde acá). El backend re-calcula todo de forma autoritativa;
 * esto es para el preview en vivo del PDV.
 */
import type { ArticleDTO, CustomerDTO } from '@/types/api'

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

/** IVA contenido en un importe que ya lo incluye: vat = gross - gross/(1+rate/100). */
export function vatContained(grossAmount: string | number, vatRate: string | number): number {
  const gross = n(grossAmount)
  const rate = n(vatRate)
  if (rate <= 0) return 0
  return gross - gross / (1 + rate / 100)
}

export interface SaleLineInput {
  quantity: string | number
  unitPrice: string | number
  discount?: string | number
  vatRate?: string | number
}

export interface SaleTotals {
  subtotal: string
  vatAmount: string
  total: string
}

/** Totales de la venta (preview). Replica el criterio de SaleRepository.createWithLines. */
export function calculateSaleTotals(lines: ReadonlyArray<SaleLineInput>, globalDiscount: string | number = 0): SaleTotals {
  let subtotal = 0
  let vatAmount = 0
  for (const l of lines) {
    const lineTotal = n(l.quantity) * n(l.unitPrice) - n(l.discount)
    subtotal += lineTotal
    vatAmount += vatContained(lineTotal, l.vatRate ?? '21.00')
  }
  const total = subtotal - n(globalDiscount)
  return { subtotal: subtotal.toFixed(4), vatAmount: vatAmount.toFixed(4), total: total.toFixed(4) }
}

export function lineTotal(l: SaleLineInput): string {
  return (n(l.quantity) * n(l.unitPrice) - n(l.discount)).toFixed(4)
}
