import { and, eq, gte, inArray, lte, max, sql } from 'drizzle-orm';
import {
  CreateSaleWithLinesSchema,
  type CreateSaleWithLinesInput,
  type PriceMode,
  type VoucherType,
  addDecimal,
  cmpDecimal,
  gteDecimal,
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
  saleLines,
  salePayments,
  sales,
  type NewSaleLine,
  type Sale,
  type SaleLine,
  type SalePayment,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface SaleWithLines {
  sale: Sale;
  lines: SaleLine[];
  /** Pagos de la venta (vacío si es a cuenta corriente). */
  payments: SalePayment[];
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
   * pagos (sale_payments) + movimientos de caja (uno por pago; sólo los de
   * efectivo físico afectan el arqueo). Si `isAccountSale`, no lleva pagos y la
   * AR la abre el servicio. Lanza `ConstraintError` si falta stock o si la suma
   * de pagos no coincide con el total.
   */
  async createWithLines(rawData: unknown): Promise<SaleWithLines> {
    try {
      const data = this.parseOrThrow<CreateSaleWithLinesInput>(
        CreateSaleWithLinesSchema,
        rawData,
      );
      const now = data.date ?? Date.now();
      const saleDiscount = data.discount ?? '0.0000';
      const paymentsIn = data.payments ?? [];

      return this.db.transaction((tx) => {
        // Número de comprobante (dentro de la transacción para evitar carreras).
        const numRow = tx
          .select({ value: max(sales.number) })
          .from(sales)
          .where(eq(sales.type, data.type))
          .get();
        const number = (numRow?.value ?? 0) + 1;

        // Modo de precios vigente de la empresa: define cómo se calcula el IVA y el total.
        const cmpRow = tx.select({ priceMode: companies.priceMode }).from(companies).limit(1).get();
        const priceMode: PriceMode = cmpRow?.priceMode === 'net' ? 'net' : 'gross';

        // Calcular importes de líneas. En 'gross' los unitPrice ya incluyen IVA; en 'net' son netos.
        const computedLines = data.lines.map((line, idx) => {
          const lineTotal = subDecimal(
            mulDecimal(line.quantity, line.unitPrice, 4),
            line.discount ?? '0.0000',
            4,
          );
          const { vat } = vatBreakdown(lineTotal, line.vatRate ?? '21.00', priceMode);
          return {
            articleId: line.articleId,
            lineNumber: idx + 1,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: line.discount ?? '0.0000',
            vatRate: line.vatRate ?? '21.00',
            lineTotal,
            vat,
          };
        });

        const lineSum = sumDecimals(computedLines.map((l) => l.lineTotal));
        const vatAmount = sumDecimals(computedLines.map((l) => l.vat));
        // 'gross': subtotal ya incluye IVA → total = subtotal − descuento global.
        // 'net':   subtotal es neto → total = subtotal + IVA − descuento global.
        const subtotal = lineSum;
        const total =
          priceMode === 'gross'
            ? subDecimal(lineSum, saleDiscount, 4)
            : subDecimal(addDecimal(lineSum, vatAmount, 4), saleDiscount, 4);

        // Validación de pagos.
        if (data.isAccountSale) {
          if (paymentsIn.length > 0) {
            throw new ConstraintError(
              'ACCOUNT_SALE_WITH_PAYMENTS',
              'Una venta a cuenta corriente no lleva pagos',
            );
          }
        } else {
          const paid = sumDecimals(paymentsIn.map((p) => p.amount));
          if (cmpDecimal(paid, total) !== 0) {
            throw new ConstraintError(
              'SALE_PAYMENTS_MISMATCH',
              `La suma de los pagos (${paid}) no coincide con el total de la venta (${total})`,
            );
          }
        }

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
            isAccountSale: data.isAccountSale,
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

        // Pagos + movimientos de caja.
        const insertedPayments: SalePayment[] = [];
        if (!data.isAccountSale && paymentsIn.length > 0) {
          const pmIds = [...new Set(paymentsIn.map((p) => p.paymentMethodId))];
          const pmRows = tx
            .select()
            .from(paymentMethods)
            .where(inArray(paymentMethods.id, pmIds))
            .all();
          const pmMap = new Map(pmRows.map((r) => [r.id, r]));
          for (const p of paymentsIn) {
            const pm = pmMap.get(p.paymentMethodId);
            if (!pm) throw new NotFoundError('Medio de pago', p.paymentMethodId);
            const sp = tx
              .insert(salePayments)
              .values({
                saleId: insertedSale.id,
                paymentMethodId: p.paymentMethodId,
                amount: p.amount,
                reference: p.reference ?? null,
              })
              .returning()
              .all()[0];
            if (!sp) {
              throw new ConstraintError('SALE_PAYMENT_INSERT', 'No se pudo registrar el pago de la venta');
            }
            insertedPayments.push(sp);
            const desc = pm.isPhysicalCash
              ? `Venta ${data.type} #${number}`
              : `Venta ${data.type} #${number} — ${pm.name}`;
            tx
              .insert(cashMovements)
              .values({
                cashRegisterId: data.cashRegisterId,
                type: 'income',
                description: desc,
                amount: p.amount,
                date: now,
                userId: data.sellerId,
                relatedSaleId: insertedSale.id,
                paymentMethodId: pm.id,
              })
              .run();
          }
        }

        return { sale: insertedSale, lines: insertedLines, payments: insertedPayments };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Anula una venta: marca `status = 'voided'`, restaura el stock de cada línea,
   * genera un movimiento de caja de egreso por la parte que entró en efectivo
   * físico y elimina sus `sale_payments`. Atómico.
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

        // Reverso de caja: sólo la parte en efectivo físico.
        const sps = tx
          .select({
            amount: salePayments.amount,
            pmId: salePayments.paymentMethodId,
            isCash: paymentMethods.isPhysicalCash,
          })
          .from(salePayments)
          .leftJoin(paymentMethods, eq(salePayments.paymentMethodId, paymentMethods.id))
          .where(eq(salePayments.saleId, id))
          .all();
        const cashBack = sumDecimals(sps.filter((s) => s.isCash === true).map((s) => s.amount));
        const cashPmId = sps.find((s) => s.isCash === true)?.pmId ?? null;
        if (!sale.isAccountSale && cashPmId && Number(cashBack) > 0) {
          tx
            .insert(cashMovements)
            .values({
              cashRegisterId: sale.cashRegisterId,
              type: 'expense',
              description: `Anulación venta ${sale.type} #${sale.number}`,
              amount: cashBack,
              date: Date.now(),
              userId: sale.sellerId,
              relatedSaleId: sale.id,
              paymentMethodId: cashPmId,
            })
            .run();
        }

        // Eliminar los pagos de la venta.
        tx.delete(salePayments).where(eq(salePayments.saleId, id)).run();

        const updated = tx
          .update(sales)
          .set({ status: 'voided' })
          .where(eq(sales.id, id))
          .returning()
          .all()[0];
        if (!updated) throw new NotFoundError(this.entityName, id);
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

  /** Mapa id → status de las ventas pedidas (para enriquecer reportes). */
  async findStatusesByIds(ids: string[]): Promise<Map<string, Sale['status']>> {
    if (ids.length === 0) return new Map();
    try {
      const rows = this.db
        .select({ id: sales.id, status: sales.status })
        .from(sales)
        .where(inArray(sales.id, ids))
        .all();
      return new Map(rows.map((r) => [r.id, r.status]));
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
