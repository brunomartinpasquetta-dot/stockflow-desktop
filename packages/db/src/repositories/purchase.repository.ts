import { and, eq, gte, lte, max, sql } from 'drizzle-orm';
import {
  CreatePurchaseWithLinesSchema,
  type CreatePurchaseWithLinesInput,
  type VoucherType,
  mulDecimal,
  subDecimal,
  sumDecimals,
} from '@stockflow/shared';

import { ConstraintError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  articles,
  cashMovements,
  purchaseLines,
  purchases,
  type NewPurchaseLine,
  type Purchase,
  type PurchaseLine,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface PurchaseWithLines {
  purchase: Purchase;
  lines: PurchaseLine[];
}

function vatContained(lineTotal: string, vatRate: string): string {
  const rate = Number(vatRate);
  if (!Number.isFinite(rate) || rate === 0) return '0.0000';
  const base = Number(lineTotal) / (1 + rate / 100);
  return (Number(lineTotal) - base).toFixed(4);
}

export class PurchaseRepository extends BaseRepository<
  Purchase,
  typeof purchases.$inferInsert
> {
  constructor(db: LocalDatabase) {
    super(db, purchases, 'Compra');
  }

  async getNextNumber(type: VoucherType): Promise<number> {
    try {
      const row = this.db
        .select({ value: max(purchases.number) })
        .from(purchases)
        .where(eq(purchases.type, type))
        .get();
      return (row?.value ?? 0) + 1;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Crea una compra de forma atómica: cabecera + líneas + incremento de stock.
   * Si `updatedPricesOnSave` es true, actualiza costo y lista 1 de cada artículo.
   * Si se indica `cashRegisterId` y el pago es contado, registra el egreso de caja.
   */
  async createWithLines(rawData: unknown): Promise<PurchaseWithLines> {
    try {
      const data = this.parseOrThrow<CreatePurchaseWithLinesInput>(
        CreatePurchaseWithLinesSchema,
        rawData,
      );
      const now = data.date ?? Date.now();
      const purchaseDiscount = data.discount ?? '0.0000';

      return this.db.transaction((tx) => {
        const numRow = tx
          .select({ value: max(purchases.number) })
          .from(purchases)
          .where(eq(purchases.type, data.type))
          .get();
        const number = (numRow?.value ?? 0) + 1;

        const computedLines = data.lines.map((line, idx) => {
          const lineTotal = mulDecimal(line.quantity, line.costPrice, 4);
          return {
            articleId: line.articleId,
            lineNumber: idx + 1,
            quantity: line.quantity,
            costPrice: line.costPrice,
            salePrice: line.salePrice,
            vatRate: line.vatRate ?? '21.00',
            lineTotal,
            vat: vatContained(lineTotal, line.vatRate ?? '21.00'),
          };
        });

        const subtotal = sumDecimals(computedLines.map((l) => l.lineTotal));
        const vatAmount = sumDecimals(computedLines.map((l) => l.vat));
        const total = subDecimal(subtotal, purchaseDiscount, 4);

        const insertedPurchase = tx
          .insert(purchases)
          .values({
            number,
            type: data.type,
            supplierInvoiceNumber: data.supplierInvoiceNumber ?? null,
            date: now,
            supplierId: data.supplierId,
            paymentType: data.paymentType,
            subtotal,
            discount: purchaseDiscount,
            vatAmount,
            total,
            status: 'completed',
            updatedPricesOnSave: data.updatedPricesOnSave ?? false,
            notes: data.notes ?? null,
          })
          .returning()
          .all()[0];
        if (!insertedPurchase) {
          throw new ConstraintError('PURCHASE_INSERT', 'No se pudo registrar la compra');
        }

        const insertedLines: PurchaseLine[] = [];
        for (const l of computedLines) {
          // Incrementar stock.
          tx
            .update(articles)
            .set({
              stock: sql`printf('%.3f', CAST(${articles.stock} AS REAL) + CAST(${l.quantity} AS REAL))`,
              ...(data.updatedPricesOnSave
                ? { costPrice: l.costPrice, listPrice1: l.salePrice }
                : {}),
            })
            .where(eq(articles.id, l.articleId))
            .run();

          const lineRow: NewPurchaseLine = {
            purchaseId: insertedPurchase.id,
            articleId: l.articleId,
            lineNumber: l.lineNumber,
            quantity: l.quantity,
            costPrice: l.costPrice,
            salePrice: l.salePrice,
            vatRate: l.vatRate,
            lineTotal: l.lineTotal,
          };
          const inserted = tx.insert(purchaseLines).values(lineRow).returning().all()[0];
          if (inserted) insertedLines.push(inserted);
        }

        if (data.cashRegisterId && data.userId && data.paymentType === 'cash') {
          tx.insert(cashMovements).values({
            cashRegisterId: data.cashRegisterId,
            type: 'expense',
            description: `Compra ${data.type} #${number}`,
            amount: total,
            date: now,
            userId: data.userId,
            relatedPurchaseId: insertedPurchase.id,
          }).run();
        }

        return { purchase: insertedPurchase, lines: insertedLines };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByDateRange(from: number, to: number): Promise<Purchase[]> {
    try {
      return this.db
        .select()
        .from(purchases)
        .where(and(gte(purchases.date, from), lte(purchases.date, to)))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findBySupplier(supplierId: string): Promise<Purchase[]> {
    try {
      return this.db.select().from(purchases).where(eq(purchases.supplierId, supplierId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
