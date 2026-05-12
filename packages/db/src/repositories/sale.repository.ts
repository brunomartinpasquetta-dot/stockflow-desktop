import { and, eq, gte, lte, max, sql } from 'drizzle-orm';
import {
  CreateSaleWithLinesSchema,
  type CreateSaleWithLinesInput,
  type VoucherType,
  gteDecimal,
  mulDecimal,
  subDecimal,
  sumDecimals,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  articles,
  cashMovements,
  saleLines,
  sales,
  type NewSaleLine,
  type Sale,
  type SaleLine,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface SaleWithLines {
  sale: Sale;
  lines: SaleLine[];
}

/** IVA contenido en un importe que ya incluye impuestos (criterio MVP). */
function vatContained(lineTotal: string, vatRate: string): string {
  const rate = Number(vatRate);
  if (!Number.isFinite(rate) || rate === 0) return '0.0000';
  const base = Number(lineTotal) / (1 + rate / 100);
  return (Number(lineTotal) - base).toFixed(4);
}

export class SaleRepository extends BaseRepository<Sale, typeof sales.$inferInsert> {
  constructor(db: LocalDatabase) {
    super(db, sales, 'Venta');
  }

  /** Próximo número de comprobante para un tipo dado (MAX(number) + 1). */
  async getNextNumber(type: VoucherType): Promise<number> {
    try {
      const row = this.db
        .select({ value: max(sales.number) })
        .from(sales)
        .where(eq(sales.type, type))
        .get();
      return (row?.value ?? 0) + 1;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Crea una venta de forma atómica: cabecera + líneas + descuento de stock +
   * movimiento de caja (ingreso). Lanza `ConstraintError` si algún artículo no
   * tiene stock suficiente (toda la transacción se revierte).
   */
  async createWithLines(rawData: unknown): Promise<SaleWithLines> {
    try {
      const data = this.parseOrThrow<CreateSaleWithLinesInput>(
        CreateSaleWithLinesSchema,
        rawData,
      );
      const now = data.date ?? Date.now();
      const saleDiscount = data.discount ?? '0.0000';

      return this.db.transaction((tx) => {
        // Número de comprobante (dentro de la transacción para evitar carreras).
        const numRow = tx
          .select({ value: max(sales.number) })
          .from(sales)
          .where(eq(sales.type, data.type))
          .get();
        const number = (numRow?.value ?? 0) + 1;

        // Calcular importes de líneas.
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
            vat: vatContained(lineTotal, line.vatRate ?? '21.00'),
          };
        });

        const subtotal = sumDecimals(computedLines.map((l) => l.lineTotal));
        const vatAmount = sumDecimals(computedLines.map((l) => l.vat));
        const total = subDecimal(subtotal, saleDiscount, 4);

        // Cabecera.
        const insertedSale = tx
          .insert(sales)
          .values({
            number,
            type: data.type,
            date: now,
            customerId: data.customerId,
            sellerId: data.sellerId,
            cashRegisterId: data.cashRegisterId,
            paymentType: data.paymentType,
            cardId: data.cardId ?? null,
            cardAmount: data.cardAmount ?? '0.0000',
            subtotal,
            discount: saleDiscount,
            vatAmount,
            total,
            status: 'completed',
            notes: data.notes ?? null,
          })
          .returning()
          .all()[0];
        if (!insertedSale) {
          throw new ConstraintError('SALE_INSERT', 'No se pudo registrar la venta');
        }

        // Líneas + descuento de stock.
        const insertedLines: SaleLine[] = [];
        for (const l of computedLines) {
          const current = tx
            .select({ stock: articles.stock })
            .from(articles)
            .where(eq(articles.id, l.articleId))
            .get();
          if (!current) throw new NotFoundError('Artículo', l.articleId);
          if (!gteDecimal(current.stock, l.quantity)) {
            throw new ConstraintError(
              'STOCK_INSUFFICIENT',
              `Stock insuficiente para el artículo ${l.articleId}: hay ${current.stock}, se requieren ${l.quantity}`,
            );
          }
          tx
            .update(articles)
            .set({ stock: subDecimal(current.stock, l.quantity, 3) })
            .where(eq(articles.id, l.articleId))
            .run();

          const lineRow: NewSaleLine = {
            saleId: insertedSale.id,
            articleId: l.articleId,
            lineNumber: l.lineNumber,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discount: l.discount,
            vatRate: l.vatRate,
            lineTotal: l.lineTotal,
          };
          const inserted = tx.insert(saleLines).values(lineRow).returning().all()[0];
          if (inserted) insertedLines.push(inserted);
        }

        // Movimiento de caja (ingreso). En ventas a cuenta corriente no entra dinero.
        if (data.paymentType !== 'account') {
          tx.insert(cashMovements).values({
            cashRegisterId: data.cashRegisterId,
            type: 'income',
            description: `Venta ${data.type} #${number}`,
            amount: total,
            date: now,
            userId: data.sellerId,
            relatedSaleId: insertedSale.id,
          }).run();
        }

        return { sale: insertedSale, lines: insertedLines };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Anula una venta: marca `status = 'voided'`, restaura el stock de cada línea
   * y registra un movimiento de caja de egreso (reverso). Atómico.
   */
  async voidSale(id: string): Promise<Sale> {
    try {
      return this.db.transaction((tx) => {
        const sale = tx.select().from(sales).where(eq(sales.id, id)).get();
        if (!sale) throw new NotFoundError(this.entityName, id);
        if (sale.status === 'voided') {
          throw new ConstraintError('SALE_ALREADY_VOIDED', `La venta ${id} ya está anulada`);
        }

        const lines = tx.select().from(saleLines).where(eq(saleLines.saleId, id)).all();
        for (const line of lines) {
          tx
            .update(articles)
            .set({
              stock: sql`printf('%.3f', CAST(${articles.stock} AS REAL) + CAST(${line.quantity} AS REAL))`,
            })
            .where(eq(articles.id, line.articleId))
            .run();
        }

        const updated = tx
          .update(sales)
          .set({ status: 'voided' })
          .where(eq(sales.id, id))
          .returning()
          .all()[0];
        if (!updated) throw new NotFoundError(this.entityName, id);

        if (sale.paymentType !== 'account') {
          tx.insert(cashMovements).values({
            cashRegisterId: sale.cashRegisterId,
            type: 'expense',
            description: `Anulación venta ${sale.type} #${sale.number}`,
            amount: sale.total,
            date: Date.now(),
            userId: sale.sellerId,
            relatedSaleId: sale.id,
          }).run();
        }

        return updated;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByDateRange(from: number, to: number): Promise<Sale[]> {
    try {
      return this.db
        .select()
        .from(sales)
        .where(and(gte(sales.date, from), lte(sales.date, to)))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByCustomer(customerId: string): Promise<Sale[]> {
    try {
      return this.db.select().from(sales).where(eq(sales.customerId, customerId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findBySeller(sellerId: string): Promise<Sale[]> {
    try {
      return this.db.select().from(sales).where(eq(sales.sellerId, sellerId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
