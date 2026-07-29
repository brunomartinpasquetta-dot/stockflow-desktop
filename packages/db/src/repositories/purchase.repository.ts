import { and, desc, eq, gte, inArray, like, lte, max, or, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
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
  cashGeneral,
  cashGeneralMovements,
  cashMovements,
  cashRegisters,
  companies,
  paymentMethods,
  purchaseLines,
  purchases,
  supplierAccountsPayable,
  type NewPurchaseLine,
  type Purchase,
  type PurchaseLine,
  type SupplierAccountPayable,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface PurchaseWithLines {
  purchase: Purchase;
  lines: PurchaseLine[];
  /** Cuenta por pagar abierta (sólo si es compra a cuenta), null en otro caso. */
  accountPayable: SupplierAccountPayable | null;
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

        // Egreso desde CAJA GENERAL (contado, fundingSource='general'): un solo
        // movimiento por el total que baja el saldo consolidado. No toca la caja
        // diaria (el dinero sale de la caja fuerte, no del cajón del día).
        if (data.paymentType === 'cash' && data.fundingSource === 'general' && data.userId) {
          const cgCur = tx
            .select()
            .from(cashGeneral)
            .where(eq(cashGeneral.id, 'singleton'))
            .get();
          const prevBalance = cgCur?.currentBalance ?? '0';
          const balanceAfter = subDecimal(prevBalance, total, 2);
          tx.insert(cashGeneralMovements)
            .values({
              id: uuidv7(),
              type: 'expense',
              amount: total,
              description: `Compra ${data.type} #${number}`,
              category: 'other',
              createdBy: data.userId,
              referenceId: insertedPurchase.id,
              balanceAfter,
              createdAt: now,
            })
            .run();
          if (cgCur) {
            tx.update(cashGeneral)
              .set({ currentBalance: balanceAfter, lastUpdate: now })
              .where(eq(cashGeneral.id, 'singleton'))
              .run();
          } else {
            tx.insert(cashGeneral)
              .values({ id: 'singleton', currentBalance: balanceAfter, lastUpdate: now, createdAt: now })
              .run();
          }
        } else if (data.paymentType === 'cash' && data.cashRegisterId && data.userId) {
          // Egresos de la caja diaria (comportamiento histórico).
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

        // Cuenta por pagar (BUG-S03): si es compra a crédito, la AP se abre
        // DENTRO de esta misma transacción. Antes se creaba en el servicio,
        // fuera de la transacción → si el proceso moría quedaba una compra
        // a crédito sin AP (deuda con el proveedor perdida silenciosamente).
        let insertedAp: SupplierAccountPayable | null = null;
        if (data.paymentType === 'credit') {
          insertedAp = tx
            .insert(supplierAccountsPayable)
            .values({
              supplierId: data.supplierId,
              purchaseId: insertedPurchase.id,
              total: insertedPurchase.total,
              balance: insertedPurchase.total,
              status: 'open',
            })
            .returning()
            .all()[0] ?? null;
          if (!insertedAp) {
            throw new ConstraintError(
              'AP_INSERT',
              'No se pudo abrir la cuenta por pagar de la compra',
            );
          }
        }

        return {
          purchase: insertedPurchase,
          lines: insertedLines,
          accountPayable: insertedAp,
        };
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
        // BUG-S05: se emite UN ingreso reverso por CADA egreso físico original,
        //   preservando su paymentMethodId, caja y usuario (antes se lumpeaba
        //   todo en un único movimiento con el primer paymentMethodId → rompía
        //   el desglose byPaymentMethod si había >1 medio físico).
        //   Un egreso con paymentMethodId NULL (legacy) cuenta como físico y se
        //   revierte también con NULL, consistente con el criterio del cierre.
        const movs = tx
          .select({
            cashRegisterId: cashMovements.cashRegisterId,
            userId: cashMovements.userId,
            amount: cashMovements.amount,
            pmId: cashMovements.paymentMethodId,
            isCash: paymentMethods.isPhysicalCash,
          })
          .from(cashMovements)
          .leftJoin(paymentMethods, eq(cashMovements.paymentMethodId, paymentMethods.id))
          .where(and(eq(cashMovements.relatedPurchaseId, id), eq(cashMovements.type, 'expense')))
          .all();
        if (purchase.paymentType === 'cash') {
          const physical = movs.filter(
            (m) => (m.pmId == null || m.isCash === true) && Number(m.amount) > 0,
          );
          // BUG-CAJA: el reverso no puede entrar a una caja ya CERRADA y arqueada
          //   (el arqueo histórico recalcula el esperado en vivo y dejaría de
          //   cuadrar). Resolvemos la caja DESTINO dentro de la transacción para
          //   cada egreso físico original:
          //   - su caja original 'open'  → usar esa (comportamiento actual);
          //   - su caja original 'closed' (o ya inexistente) → usar la caja
          //     ABIERTA actual (a lo sumo una);
          //   - sin caja abierta → abortar pidiendo abrir una.
          // La caja abierta se busca una sola vez (lazy) y se cachea.
          let openRegisterId: string | null | undefined;
          const resolveOpenRegisterId = (): string => {
            if (openRegisterId === undefined) {
              openRegisterId =
                tx
                  .select({ id: cashRegisters.id })
                  .from(cashRegisters)
                  .where(eq(cashRegisters.status, 'open'))
                  .limit(1)
                  .get()?.id ?? null;
            }
            if (!openRegisterId) {
              throw new ConstraintError(
                'NO_OPEN_CASH_REGISTER',
                'Abrí una caja para poder anular esta operación (la caja original ya está cerrada)',
              );
            }
            return openRegisterId;
          };

          for (const m of physical) {
            const originReg = tx
              .select({ status: cashRegisters.status })
              .from(cashRegisters)
              .where(eq(cashRegisters.id, m.cashRegisterId))
              .get();
            const fromClosedRegister = originReg?.status !== 'open';
            const targetRegisterId = fromClosedRegister
              ? resolveOpenRegisterId()
              : m.cashRegisterId;
            const desc = fromClosedRegister
              ? `Anulación compra ${purchase.type} #${purchase.number} (caja original cerrada)`
              : `Anulación compra ${purchase.type} #${purchase.number}`;
            tx
              .insert(cashMovements)
              .values({
                cashRegisterId: targetRegisterId,
                type: 'income',
                description: desc,
                amount: m.amount,
                date: Date.now(),
                userId: m.userId,
                relatedPurchaseId: purchase.id,
                paymentMethodId: m.pmId,
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
