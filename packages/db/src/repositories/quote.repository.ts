import { and, desc, eq, gte, lte, max } from 'drizzle-orm';
import {
  CreateQuoteWithLinesSchema,
  type CreateQuoteWithLinesInput,
  type PriceMode,
  addDecimal,
  mulDecimal,
  proratedVatBreakdown,
  subDecimal,
  sumDecimals,
} from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { companies, quoteLines, quotes, type Quote, type QuoteLine } from '../schema/local';
import { BaseRepository } from './base.repository';

export interface QuoteWithLines {
  quote: Quote;
  lines: QuoteLine[];
}

/**
 * Repositorio de presupuestos. A diferencia de las ventas, NO toca stock, caja
 * ni cuenta corriente: un presupuesto es una cotización. Tiene numeración propia
 * secuencial. Los totales se calculan con el MISMO criterio fiscal que las ventas
 * (prorrateo de IVA sobre el descuento global) para que la conversión sea fiel.
 */
export class QuoteRepository extends BaseRepository<Quote, typeof quotes.$inferInsert> {
  constructor(db: LocalDatabase) {
    super(db, quotes, 'Presupuesto');
  }

  /** Próximo número de presupuesto (MAX(number) + 1, serie propia). */
  async getNextNumber(): Promise<number> {
    try {
      const row = this.db.select({ value: max(quotes.number) }).from(quotes).get();
      return (row?.value ?? 0) + 1;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Crea un presupuesto (cabecera + líneas) de forma atómica. No descuenta stock. */
  async createWithLines(rawData: unknown): Promise<QuoteWithLines> {
    try {
      const data = this.parseOrThrow<CreateQuoteWithLinesInput>(CreateQuoteWithLinesSchema, rawData);
      const now = data.date ?? Date.now();
      const quoteDiscount = data.discount ?? '0.0000';

      return this.db.transaction((tx) => {
        const numRow = tx.select({ value: max(quotes.number) }).from(quotes).get();
        const number = (numRow?.value ?? 0) + 1;

        const cmpRow = tx.select({ priceMode: companies.priceMode }).from(companies).limit(1).get();
        const priceMode: PriceMode = cmpRow?.priceMode === 'net' ? 'net' : 'gross';

        const computedLines = data.lines.map((line, idx) => {
          const lineTotal = subDecimal(
            mulDecimal(line.quantity, line.unitPrice, 4),
            line.discount ?? '0.0000',
            4,
          );
          return {
            articleId: line.articleId,
            lineNumber: idx + 1,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: line.discount ?? '0.0000',
            vatRate: line.vatRate ?? '21.00',
            lineTotal,
          };
        });

        const subtotal = sumDecimals(computedLines.map((l) => l.lineTotal));
        const { vatAmount } = proratedVatBreakdown(
          computedLines.map((l) => ({ lineTotal: l.lineTotal, vatRate: l.vatRate })),
          quoteDiscount,
          subtotal,
          priceMode,
        );
        const total =
          priceMode === 'gross'
            ? subDecimal(subtotal, quoteDiscount, 4)
            : subDecimal(addDecimal(subtotal, vatAmount, 4), quoteDiscount, 4);

        const quoteRows = tx
          .insert(quotes)
          .values({
            number,
            type: data.type,
            date: now,
            customerId: data.customerId,
            sellerId: data.sellerId,
            validityDays: data.validityDays,
            subtotal,
            discount: quoteDiscount,
            vatAmount,
            total,
            status: 'pending',
            notes: data.notes ?? null,
          })
          .returning()
          .all();
        const quote = quoteRows[0];
        if (!quote) throw new Error('No se pudo crear el presupuesto');

        const lines = computedLines.map((l) => {
          const rows = tx.insert(quoteLines).values({ quoteId: quote.id, ...l }).returning().all();
          return rows[0]!;
        });

        return { quote, lines };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findWithLines(id: string): Promise<QuoteWithLines | null> {
    try {
      const quote = this.db.select().from(quotes).where(eq(quotes.id, id)).get();
      if (!quote) return null;
      const lines = this.db
        .select()
        .from(quoteLines)
        .where(eq(quoteLines.quoteId, id))
        .orderBy(quoteLines.lineNumber)
        .all();
      return { quote, lines };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByDateRange(from: number, to: number): Promise<Quote[]> {
    try {
      return this.db
        .select()
        .from(quotes)
        .where(and(gte(quotes.date, from), lte(quotes.date, to)))
        .orderBy(desc(quotes.date))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Marca el presupuesto como convertido y guarda la venta resultante (traza). */
  async markConverted(id: string, saleId: string): Promise<void> {
    try {
      this.db
        .update(quotes)
        .set({ status: 'converted', saleId, updatedAt: Date.now() })
        .where(eq(quotes.id, id))
        .run();
    } catch (err) {
      rethrowDbError(err);
    }
  }
}
