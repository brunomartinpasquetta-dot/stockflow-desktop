/**
 * Servicio de presupuestos (cotizaciones). NO toca stock ni caja al crear: es
 * una oferta. Al convertirse en venta reusa toda la transacción atómica de
 * `SalesService.createSale` (stock, caja, cuenta corriente), pudiendo usar los
 * precios CONGELADOS del presupuesto o RE-RESOLVER los precios actuales.
 */
import type { Quote, QuoteLine, Sale } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError } from '../errors';
import { type PriceMode, type SaleTotals, calculateSaleTotals, resolvePrice } from '../pricing';
import { SalesService, type SalePaymentDraft } from './sales.service';

export interface CreateQuoteLineDraft {
  articleId: string;
  quantity: string;
  unitPrice: string;
  discount?: string;
  vatRate?: string;
}

export interface CreateQuoteInput {
  type?: 'A' | 'B' | 'C' | 'X';
  customerId: string;
  validityDays?: number;
  discount?: string;
  notes?: string | null;
  lines: CreateQuoteLineDraft[];
}

export interface ConvertQuoteToSaleInput {
  quoteId: string;
  isAccountSale?: boolean;
  /** true = re-resolver precios actuales; false = usar los congelados. */
  refreshPrices?: boolean;
  payments?: SalePaymentDraft[];
}

export interface QuoteWithLinesResult {
  quote: Quote;
  lines: QuoteLine[];
}

export interface QuoteConvertPreview extends SaleTotals {
  discount: string;
}

export class QuotesService {
  constructor(private readonly ctx: ServiceContext) {}

  async createQuote(input: CreateQuoteInput): Promise<QuoteWithLinesResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_quotes');
    if (input.lines.length === 0) {
      throw new BusinessRuleError('empty_quote', 'El presupuesto debe tener al menos una línea');
    }
    return repos.quotes.createWithLines({
      type: input.type ?? 'B',
      customerId: input.customerId,
      sellerId: currentUser.id,
      validityDays: input.validityDays ?? 30,
      discount: input.discount ?? '0.0000',
      notes: input.notes ?? null,
      lines: input.lines,
    });
  }

  async listQuotes(from: number, to: number): Promise<Quote[]> {
    requirePermission(this.ctx.currentUser, 'view_quotes');
    return this.ctx.repos.quotes.findByDateRange(from, to);
  }

  async getQuote(id: string): Promise<QuoteWithLinesResult> {
    requirePermission(this.ctx.currentUser, 'view_quotes');
    const found = await this.ctx.repos.quotes.findWithLines(id);
    if (!found) throw new NotFoundError('Presupuesto', id);
    return found;
  }

  async deleteQuote(id: string): Promise<void> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_quotes');
    const found = await repos.quotes.findById(id);
    if (!found) throw new NotFoundError('Presupuesto', id);
    if (found.status === 'converted') {
      throw new BusinessRuleError(
        'quote_converted',
        'No se puede eliminar un presupuesto ya convertido en venta',
      );
    }
    await repos.quotes.delete(id);
  }

  /** Resuelve las líneas del presupuesto (congeladas o actuales) + el modo de precios. */
  private async resolveConvertLines(
    quoteId: string,
    refreshPrices: boolean,
  ): Promise<{
    lines: Array<{ articleId: string; quantity: string; unitPrice: string; discount: string; vatRate: string }>;
    discount: string;
    mode: PriceMode;
  }> {
    const { repos } = this.ctx;
    const found = await repos.quotes.findWithLines(quoteId);
    if (!found) throw new NotFoundError('Presupuesto', quoteId);
    const customer = await repos.customers.findById(found.quote.customerId);
    const company = await repos.company.getOrCreate();
    const mode: PriceMode = company.priceMode === 'net' ? 'net' : 'gross';
    const lines = [];
    for (const l of found.lines) {
      let unitPrice = l.unitPrice;
      if (refreshPrices && customer) {
        const article = await repos.articles.findById(l.articleId);
        if (article) unitPrice = resolvePrice(article, customer, l.quantity);
      }
      lines.push({ articleId: l.articleId, quantity: l.quantity, unitPrice, discount: l.discount, vatRate: l.vatRate });
    }
    return { lines, discount: found.quote.discount, mode };
  }

  /** Total a cobrar al convertir (para la UI de pago), con o sin refresco de precios. */
  async previewConvert(quoteId: string, refreshPrices: boolean): Promise<QuoteConvertPreview> {
    requirePermission(this.ctx.currentUser, 'view_quotes');
    const { lines, discount, mode } = await this.resolveConvertLines(quoteId, refreshPrices);
    const totals = calculateSaleTotals(lines, discount, mode);
    return { ...totals, discount };
  }

  async convertToSale(input: ConvertQuoteToSaleInput): Promise<{ sale: Sale; quoteId: string }> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_quotes');
    const found = await repos.quotes.findById(input.quoteId);
    if (!found) throw new NotFoundError('Presupuesto', input.quoteId);
    if (found.status === 'converted') {
      throw new BusinessRuleError('quote_already_converted', 'El presupuesto ya fue convertido en venta');
    }
    const { lines, discount } = await this.resolveConvertLines(input.quoteId, input.refreshPrices === true);
    // SalesService valida permiso create_sale, caja abierta, pagos == total, stock, etc.
    const result = await new SalesService(this.ctx).createSale({
      type: found.type,
      customerId: found.customerId,
      isAccountSale: input.isAccountSale === true,
      payments: input.payments ?? [],
      discount,
      notes: `Generado desde presupuesto P-${String(found.number).padStart(4, '0')}`,
      lines: lines.map((l) => ({
        articleId: l.articleId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
        vatRate: l.vatRate,
      })),
    });
    await repos.quotes.markConverted(input.quoteId, result.sale.id);
    return { sale: result.sale, quoteId: input.quoteId };
  }
}
