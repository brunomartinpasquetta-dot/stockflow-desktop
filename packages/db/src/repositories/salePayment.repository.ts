import { and, eq, gte, lte } from 'drizzle-orm';
import { cmpDecimal, subDecimal, sumDecimals } from '@stockflow/shared';

import { ConstraintError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  paymentMethods,
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

  /**
   * Pagos de VARIAS ventas en una sola consulta. El Historial de Ventas filtra
   * por forma de pago y con una consulta por venta serían cientos por pantalla.
   */
  async findBySaleDateRange(from: number, to: number, porCaja = false): Promise<SalePayment[]> {
    try {
      return this.db
        .select({
          id: salePayments.id,
          saleId: salePayments.saleId,
          paymentMethodId: salePayments.paymentMethodId,
          amount: salePayments.amount,
          reference: salePayments.reference,
          createdAt: salePayments.createdAt,
        })
        .from(salePayments)
        .innerJoin(sales, eq(sales.id, salePayments.saleId))
        // Con el MISMO criterio que la lista de ventas del Historial (día de
        // caja u hora real): si no, los pagos no casan con sus ventas.
        .where(porCaja ? and(gte(sales.jornada, from), lte(sales.jornada, to)) : and(gte(sales.date, from), lte(sales.date, to)))
        .all() as SalePayment[];
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
   * VENTAS de una caja repartidas por cómo se cobraron (pedido de Bruno,
   * 7-oct-2026: la caja diaria tiene que mostrar las ventas en efectivo, las
   * cobradas con un medio electrónico y las que quedaron en cuenta corriente).
   *
   * No es lo mismo que los INGRESOS de la caja: acá entran sólo las ventas
   * completadas de este turno —ni cobranzas de fiado, ni ingresos a mano, ni
   * ventas anuladas—, y la venta fiada SÍ cuenta aunque no mueva plata.
   */
  async getSalesSplitByRegister(
    cashRegisterId: string,
  ): Promise<{ efectivo: string; electronico: string; cuentaCorriente: string }> {
    try {
      const rows = this.db
        .select({
          amount: salePayments.amount,
          isPhysicalCash: paymentMethods.isPhysicalCash,
        })
        .from(salePayments)
        .innerJoin(sales, eq(salePayments.saleId, sales.id))
        .leftJoin(paymentMethods, eq(salePayments.paymentMethodId, paymentMethods.id))
        .where(and(eq(sales.cashRegisterId, cashRegisterId), eq(sales.status, 'completed')))
        .all();
      // Un medio borrado deja de tener ficha: se cuenta como electrónico para no
      // inflar el efectivo, que es lo que se arquea contra el cajón.
      const efectivo = sumDecimals(rows.filter((r) => r.isPhysicalCash === true).map((r) => r.amount));
      const electronico = sumDecimals(rows.filter((r) => r.isPhysicalCash !== true).map((r) => r.amount));
      // Lo fiado es el resto de la venta: lo que no se cobró con ningún medio.
      const vendido = this.db
        .select({ total: sales.total })
        .from(sales)
        .where(and(eq(sales.cashRegisterId, cashRegisterId), eq(sales.status, 'completed')))
        .all();
      const cobrado = sumDecimals([efectivo, electronico]);
      const fiado = subDecimal(sumDecimals(vendido.map((v) => v.total)), cobrado, 4);
      return { efectivo, electronico, cuentaCorriente: cmpDecimal(fiado, '0') > 0 ? fiado : '0.0000' };
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
