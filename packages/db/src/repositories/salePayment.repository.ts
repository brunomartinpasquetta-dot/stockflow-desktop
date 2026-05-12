import { eq } from 'drizzle-orm';

import { ConstraintError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  salePayments,
  type NewSalePayment,
  type SalePayment,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface SalePaymentInput {
  paymentMethodId: string;
  amount: string;
  reference?: string | null;
}

export class SalePaymentRepository extends BaseRepository<
  SalePayment,
  NewSalePayment
> {
  constructor(db: LocalDatabase) {
    super(db, salePayments, 'Pago de venta');
  }

  async findBySale(saleId: string): Promise<SalePayment[]> {
    try {
      return this.db.select().from(salePayments).where(eq(salePayments.saleId, saleId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Inserta los N pagos de una venta de forma atómica. */
  async createMany(saleId: string, items: SalePaymentInput[]): Promise<SalePayment[]> {
    try {
      return this.db.transaction((tx) => {
        const out: SalePayment[] = [];
        for (const it of items) {
          const row = tx
            .insert(salePayments)
            .values({
              saleId,
              paymentMethodId: it.paymentMethodId,
              amount: it.amount,
              reference: it.reference ?? null,
            })
            .returning()
            .all()[0];
          if (!row) throw new ConstraintError('SALE_PAYMENT_INSERT', 'No se pudo registrar el pago de la venta');
          out.push(row);
        }
        return out;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async deleteBySale(saleId: string): Promise<void> {
    try {
      this.db.delete(salePayments).where(eq(salePayments.saleId, saleId)).run();
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /** ¿Hay algún pago de venta que use este medio? (para bloquear su borrado). */
  async existsForPaymentMethod(paymentMethodId: string): Promise<boolean> {
    try {
      const row = this.db
        .select({ id: salePayments.id })
        .from(salePayments)
        .where(eq(salePayments.paymentMethodId, paymentMethodId))
        .limit(1)
        .get();
      return !!row;
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
