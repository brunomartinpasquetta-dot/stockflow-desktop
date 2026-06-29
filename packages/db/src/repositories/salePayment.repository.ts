import { and, eq, gte, lte } from 'drizzle-orm';
import { sumDecimals } from '@stockflow/shared';

import { ConstraintError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  sales,
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

  /**
   * Comisiones de los pagos de una caja (sólo ventas COMPLETADAS).
   * JOIN sale_payments → sales WHERE sales.cash_register_id = X AND status='completed'.
   * Devuelve el total y el desglose por medio de pago. La comisión la ABSORBE el
   * comercio (costo financiero); no se le suma al cliente.
   */
  async getCommissionByRegister(
    cashRegisterId: string,
  ): Promise<{ total: string; byMethod: Map<string, string> }> {
    try {
      const rows = this.db
        .select({
          paymentMethodId: salePayments.paymentMethodId,
          commissionAmount: salePayments.commissionAmount,
        })
        .from(salePayments)
        .innerJoin(sales, eq(salePayments.saleId, sales.id))
        .where(
          and(
            eq(sales.cashRegisterId, cashRegisterId),
            eq(sales.status, 'completed'),
          ),
        )
        .all();

      const byMethod = new Map<string, string>();
      for (const r of rows) {
        const prev = byMethod.get(r.paymentMethodId) ?? '0.0000';
        byMethod.set(r.paymentMethodId, sumDecimals([prev, r.commissionAmount]));
      }
      const total = sumDecimals(rows.map((r) => r.commissionAmount));
      return { total, byMethod };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Suma de comisiones de las ventas COMPLETADAS en un rango de fechas (costo
   * financiero del período). Absorbida por el comercio.
   */
  async getCommissionByDateRange(from: number, to: number): Promise<string> {
    try {
      const rows = this.db
        .select({ commissionAmount: salePayments.commissionAmount })
        .from(salePayments)
        .innerJoin(sales, eq(salePayments.saleId, sales.id))
        .where(
          and(
            gte(sales.date, from),
            lte(sales.date, to),
            eq(sales.status, 'completed'),
          ),
        )
        .all();
      return sumDecimals(rows.map((r) => r.commissionAmount));
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
