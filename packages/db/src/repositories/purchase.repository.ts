import { and, desc, eq, gte, inArray, like, lte, max, or, sql } from 'drizzle-orm';
import {
  CreatePurchaseWithLinesSchema,
  type CreatePurchaseWithLinesInput,
  type PriceMode,
  type VoucherType,
  addDecimal,
  cmpDecimal,
  mulDecimal,
  subDecimal,
  sumDecimals,
  vatBreakdown,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  articles,
  cashMovements,
  companies,
  paymentMethods,
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
   * Crea una compra de forma atómica: cabecera + líneas + incremento de stock +
   * (si es contado) un egreso de caja por cada pago. Si `updatedPricesOnSave`,
   * actualiza costo y lista 1 de cada artículo. Respeta el modo de precios:
   * en 'gross' el costo unitario ya incluye IVA; en 'net' es neto y se agrega.
   */
  async createWithLines(rawData: unknown): Promise<PurchaseWithLines> {
    try {
      const data = this.parseOrThrow<CreatePurchaseWithLinesInput>(
        CreatePurchaseWithLinesSchema,
        rawData,
      );
      const now = data.date ?? Date.now();
      const purchaseDiscount = data.discount ?? '0.0000';
      const paymentsIn = data.payments ?? [];

      return this.db.transaction((tx) => {
        const numRow = tx
          .select({ value: max(purchases.number) })
          .from(purchases)
          .where(eq(purchases.type, data.type))
          .get();
        const number = (numRow?.value ?? 0) + 1;

        const cmpRow = tx.select({ priceMode: companies.priceMode }).from(companies).limit(1).get();
        const priceMode: PriceMode = cmpRow?.priceMode === 'net' ? 'net' : 'gross';

        const computedLines = data.lines.map((line, idx) => {
          const lineTotal = mulDecimal(line.quantity, line.costPrice, 4);
          const { vat } = vatBreakdown(lineTotal, line.vatRate ?? '21.00', priceMode);
          return {
            articleId: line.articleId,
            lineNumber: idx + 1,
            quantity: line.quantity,
            costPrice: line.costPrice,
            salePrice: line.salePrice,
            vatRate: line.vatRate ?? '21.00',
            lineTotal,
            vat,
          };
        });

        const lineSum = sumDecimals(computedLines.map((l) => l.lineTotal));
        const vatAmount = sumDecimals(computedLines.map((l) => l.vat));
        const subtotal = lineSum;
        const total =
          priceMode === 'gross'
            ? subDecimal(lineSum, purchaseDiscount, 4)
            : subDecimal(addDecimal(lineSum, vatAmount, 4), purchaseDiscount, 4);

        // Validación de pagos para compras contado.
        if (data.paymentType === 'cash' && paymentsIn.length > 0) {
          const paid = sumDecimals(paymentsIn.map((p) => p.amount));
          if (cmpDecimal(paid, total) !== 0) {
            throw new ConstraintError(
              'PURCHASE_PAYMENTS_MISMATCH',
              `La suma de los pagos (${paid}) no coincide con el total de la compra (${total})`,
            );
          }
        }

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
          tx
            .update(articles)
            .set({
              stock: sql`printf('%.3f', CAST(${articles.stock} AS REAL) + CAST(${l.quantity} AS REAL))`,
              ...(data.updatedPricesOnSave ? { costPrice: l.costPrice, listPrice1: l.salePrice } : {}),
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

        // Egresos de caja (sólo si es contado).
        if (data.paymentType === 'cash' && data.cashRegisterId && data.userId) {
          if (paymentsIn.length > 0) {
            const pmIds = [...new Set(paymentsIn.map((p) => p.paymentMethodId))];
            const pmRows = tx.select().from(paymentMethods).where(inArray(paymentMethods.id, pmIds)).all();
            const pmMap = new Map(pmRows.map((r) => [r.id, r]));
            for (const p of paymentsIn) {
              const pm = pmMap.get(p.paymentMethodId);
              if (!pm) throw new NotFoundError('Medio de pago', p.paymentMethodId);
              const desc = pm.isPhysicalCash
                ? `Compra ${data.type} #${number}`
                : `Compra ${data.type} #${number} — ${pm.name}`;
              tx
                .insert(cashMovements)
                .values({
                  cashRegisterId: data.cashRegisterId,
                  type: 'expense',
                  description: desc,
                  amount: p.amount,
                  date: now,
                  userId: data.userId,
                  relatedPurchaseId: insertedPurchase.id,
                  paymentMethodId: pm.id,
                })
                .run();
            }
          } else {
            // Legacy: sin desglose de medios → un solo egreso por el total (efectivo).
            tx
              .insert(cashMovements)
              .values({
                cashRegisterId: data.cashRegisterId,
                type: 'expense',
                description: `Compra ${data.type} #${number}`,
                amount: total,
                date: now,
                userId: data.userId,
                relatedPurchaseId: insertedPurchase.id,
              })
              .run();
          }
        }

        return { purchase: insertedPurchase, lines: insertedLines };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Anula una compra: marca `status = 'voided'`, descuenta el stock que había
   * sumado y genera un ingreso de caja por la parte que se había pagado en
   * efectivo físico. (No revierte los cambios de precios de `updatedPricesOnSave`.)
   */
  async voidPurchase(id: string): Promise<Purchase> {
    try {
      return this.db.transaction((tx) => {
        const purchase = tx.select().from(purchases).where(eq(purchases.id, id)).get();
        if (!purchase) throw new NotFoundError(this.entityName, id);
        if (purchase.status === 'voided') {
          throw new ConstraintError('PURCHASE_ALREADY_VOIDED', `La compra ${id} ya está anulada`);
        }

        const lines = tx.select().from(purchaseLines).where(eq(purchaseLines.purchaseId, id)).all();
        for (const line of lines) {
          tx
            .update(articles)
            .set({
              stock: sql`printf('%.3f', CAST(${articles.stock} AS REAL) - CAST(${line.quantity} AS REAL))`,
            })
            .where(eq(articles.id, line.articleId))
            .run();
        }

        // Reverso de caja: sólo la parte que salió en efectivo físico.
        const movs = tx
          .select({
            amount: cashMovements.amount,
            pmId: cashMovements.paymentMethodId,
            isCash: paymentMethods.isPhysicalCash,
          })
          .from(cashMovements)
          .leftJoin(paymentMethods, eq(cashMovements.paymentMethodId, paymentMethods.id))
          .where(and(eq(cashMovements.relatedPurchaseId, id), eq(cashMovements.type, 'expense')))
          .all();
        const physical = movs.filter((m) => m.pmId == null || m.isCash === true);
        const cashBack = sumDecimals(physical.map((m) => m.amount));
        const cashPmId = physical.find((m) => m.pmId != null)?.pmId ?? null;
        if (purchase.paymentType === 'cash' && Number(cashBack) > 0) {
          // Tomamos la caja del egreso original (relatedPurchaseId).
          const origMov = tx
            .select({ cashRegisterId: cashMovements.cashRegisterId, userId: cashMovements.userId })
            .from(cashMovements)
            .where(and(eq(cashMovements.relatedPurchaseId, id), eq(cashMovements.type, 'expense')))
            .get();
          if (origMov) {
            tx
              .insert(cashMovements)
              .values({
                cashRegisterId: origMov.cashRegisterId,
                type: 'income',
                description: `Anulación compra ${purchase.type} #${purchase.number}`,
                amount: cashBack,
                date: Date.now(),
                userId: origMov.userId,
                relatedPurchaseId: purchase.id,
                paymentMethodId: cashPmId,
              })
              .run();
          }
        }

        const updated = tx
          .update(purchases)
          .set({ status: 'voided' })
          .where(eq(purchases.id, id))
          .returning()
          .all()[0];
        if (!updated) throw new NotFoundError(this.entityName, id);
        return updated;
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

  /**
   * Busca compras por `supplier_invoice_number` o por `number` (cast a texto),
   * ordenadas por fecha desc, para la búsqueda global (P-BUSQUEDA).
   */
  async findByText(query: string, limit = 8): Promise<Purchase[]> {
    try {
      const term = `%${query.trim()}%`;
      return this.db
        .select()
        .from(purchases)
        .where(
          or(
            like(purchases.supplierInvoiceNumber, term),
            like(sql`CAST(${purchases.number} AS TEXT)`, term),
          ),
        )
        .orderBy(desc(purchases.date))
        .limit(limit)
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
