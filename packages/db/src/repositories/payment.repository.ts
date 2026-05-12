import { eq, inArray } from 'drizzle-orm';
import {
  CreatePaymentSchema,
  type CreatePaymentInput,
  cmpDecimal,
  subDecimal,
  sumDecimals,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  accountsReceivable,
  cashMovements,
  paymentMethods,
  payments,
  type NewPayment,
  type Payment,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export class PaymentRepository extends BaseRepository<Payment, NewPayment> {
  constructor(db: LocalDatabase) {
    super(db, payments, 'Pago');
  }

  async findByAccount(accountId: string): Promise<Payment[]> {
    try {
      return this.db.select().from(payments).where(eq(payments.accountId, accountId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** ¿Hay alguna cobranza usando este medio? (para bloquear su borrado). */
  async existsForPaymentMethod(paymentMethodId: string): Promise<boolean> {
    try {
      const row = this.db
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.paymentMethodId, paymentMethodId))
        .limit(1)
        .get();
      return !!row;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Registra una cobranza (posiblemente mixta) de forma atómica: inserta N filas
   * de pago con el mismo timestamp, descuenta el saldo de la cuenta corriente
   * (recalculando su estado) y genera un movimiento de caja de ingreso por cada
   * pago (sólo los de efectivo físico afectan el arqueo). Lanza `ConstraintError`
   * si el total cobrado supera el saldo.
   */
  async createPayment(rawData: CreatePaymentInput): Promise<Payment[]> {
    try {
      const data = this.parseOrThrow<CreatePaymentInput>(CreatePaymentSchema, rawData);
      const now = data.date ?? Date.now();
      const totalPaid = sumDecimals(data.payments.map((p) => p.amount));

      return this.db.transaction((tx) => {
        const account = tx
          .select()
          .from(accountsReceivable)
          .where(eq(accountsReceivable.id, data.accountId))
          .get();
        if (!account) throw new NotFoundError('Cuenta corriente', data.accountId);
        if (cmpDecimal(totalPaid, '0') <= 0) {
          throw new ConstraintError('PAYMENT_ZERO', 'La cobranza debe ser mayor a cero');
        }
        if (cmpDecimal(totalPaid, account.balance) > 0) {
          throw new ConstraintError(
            'PAYMENT_EXCEEDS_BALANCE',
            `El pago (${totalPaid}) supera el saldo de la cuenta (${account.balance})`,
          );
        }

        const pmIds = [...new Set(data.payments.map((p) => p.paymentMethodId))];
        const pmRows = tx
          .select()
          .from(paymentMethods)
          .where(inArray(paymentMethods.id, pmIds))
          .all();
        const pmMap = new Map(pmRows.map((r) => [r.id, r]));

        const inserted: Payment[] = [];
        for (const p of data.payments) {
          const pm = pmMap.get(p.paymentMethodId);
          if (!pm) throw new NotFoundError('Medio de pago', p.paymentMethodId);
          const row = tx
            .insert(payments)
            .values({
              accountId: data.accountId,
              amount: p.amount,
              date: now,
              paymentMethodId: p.paymentMethodId,
              notes: data.notes ?? null,
            })
            .returning()
            .all()[0];
          if (!row) throw new ConstraintError('PAYMENT_INSERT', 'No se pudo registrar el pago');
          inserted.push(row);
          const desc = pm.isPhysicalCash
            ? 'Cobranza cuenta corriente'
            : `Cobranza cuenta corriente — ${pm.name}`;
          tx
            .insert(cashMovements)
            .values({
              cashRegisterId: data.cashRegisterId,
              type: 'income',
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
          .update(accountsReceivable)
          .set({ balance: newBalance, status: newStatus })
          .where(eq(accountsReceivable.id, data.accountId))
          .run();

        return inserted;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
