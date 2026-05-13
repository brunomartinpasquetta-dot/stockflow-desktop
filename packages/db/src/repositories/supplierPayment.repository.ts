import { eq, inArray } from 'drizzle-orm';
import {
  CreateSupplierPaymentSchema,
  type CreateSupplierPaymentInput,
  cmpDecimal,
  subDecimal,
  sumDecimals,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashMovements,
  paymentMethods,
  supplierAccountsPayable,
  supplierPayments,
  type NewSupplierPayment,
  type SupplierPayment,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export class SupplierPaymentRepository extends BaseRepository<
  SupplierPayment,
  NewSupplierPayment
> {
  constructor(db: LocalDatabase) {
    super(db, supplierPayments, 'Pago a proveedor');
  }

  async findByAccount(accountId: string): Promise<SupplierPayment[]> {
    try {
      return this.db.select().from(supplierPayments).where(eq(supplierPayments.accountId, accountId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async existsForPaymentMethod(paymentMethodId: string): Promise<boolean> {
    try {
      const row = this.db
        .select({ id: supplierPayments.id })
        .from(supplierPayments)
        .where(eq(supplierPayments.paymentMethodId, paymentMethodId))
        .limit(1)
        .get();
      return !!row;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Registra un pago (posiblemente mixto) a una cuenta de proveedor: inserta N
   * filas de pago, descuenta el saldo de la cuenta (recalculando su estado) y
   * genera un egreso de caja por cada pago (sólo los de efectivo físico afectan
   * el arqueo). Lanza `ConstraintError` si el total pagado supera el saldo.
   */
  async createPayment(rawData: CreateSupplierPaymentInput): Promise<SupplierPayment[]> {
    try {
      const data = this.parseOrThrow<CreateSupplierPaymentInput>(CreateSupplierPaymentSchema, rawData);
      const now = data.date ?? Date.now();
      const totalPaid = sumDecimals(data.payments.map((p) => p.amount));

      return this.db.transaction((tx) => {
        const account = tx
          .select()
          .from(supplierAccountsPayable)
          .where(eq(supplierAccountsPayable.id, data.accountId))
          .get();
        if (!account) throw new NotFoundError('Cuenta de proveedor', data.accountId);
        if (cmpDecimal(totalPaid, '0') <= 0) {
          throw new ConstraintError('SUPPLIER_PAYMENT_ZERO', 'El pago debe ser mayor a cero');
        }
        if (cmpDecimal(totalPaid, account.balance) > 0) {
          throw new ConstraintError(
            'SUPPLIER_PAYMENT_EXCEEDS_BALANCE',
            `El pago (${totalPaid}) supera el saldo de la cuenta (${account.balance})`,
          );
        }

        const pmIds = [...new Set(data.payments.map((p) => p.paymentMethodId))];
        const pmRows = tx.select().from(paymentMethods).where(inArray(paymentMethods.id, pmIds)).all();
        const pmMap = new Map(pmRows.map((r) => [r.id, r]));

        const inserted: SupplierPayment[] = [];
        for (const p of data.payments) {
          const pm = pmMap.get(p.paymentMethodId);
          if (!pm) throw new NotFoundError('Medio de pago', p.paymentMethodId);
          const row = tx
            .insert(supplierPayments)
            .values({
              accountId: data.accountId,
              paymentMethodId: p.paymentMethodId,
              amount: p.amount,
              date: now,
              reference: p.reference ?? null,
            })
            .returning()
            .all()[0];
          if (!row) throw new ConstraintError('SUPPLIER_PAYMENT_INSERT', 'No se pudo registrar el pago');
          inserted.push(row);
          const desc = pm.isPhysicalCash
            ? 'Pago a proveedor'
            : `Pago a proveedor — ${pm.name}`;
          tx
            .insert(cashMovements)
            .values({
              cashRegisterId: data.cashRegisterId,
              type: 'expense',
              description: desc,
              amount: p.amount,
              date: now,
              userId: data.userId,
              paymentMethodId: pm.id,
            })
            .run();
        }

        const newBalance = subDecimal(account.balance, totalPaid, 4);
        const newStatus =
          cmpDecimal(newBalance, '0') === 0
            ? 'paid'
            : cmpDecimal(newBalance, account.total) === 0
              ? 'open'
              : 'partial';
        tx
          .update(supplierAccountsPayable)
          .set({ balance: newBalance, status: newStatus })
          .where(eq(supplierAccountsPayable.id, data.accountId))
          .run();

        return inserted;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
