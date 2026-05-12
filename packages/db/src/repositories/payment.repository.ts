import { eq } from 'drizzle-orm';
import {
  CreatePaymentSchema,
  type CreatePaymentInput,
  cmpDecimal,
  subDecimal,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  accountsReceivable,
  cashMovements,
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

  /**
   * Registra una cobranza de forma atómica: inserta el pago, descuenta el saldo
   * de la cuenta corriente (recalculando su estado) y genera un movimiento de
   * caja de ingreso. Lanza `ConstraintError` si el monto supera el saldo.
   */
  async createPayment(rawData: CreatePaymentInput): Promise<Payment> {
    try {
      const data = this.parseOrThrow<CreatePaymentInput>(CreatePaymentSchema, rawData);
      const now = data.date ?? Date.now();

      return this.db.transaction((tx) => {
        const account = tx
          .select()
          .from(accountsReceivable)
          .where(eq(accountsReceivable.id, data.accountId))
          .get();
        if (!account) throw new NotFoundError('Cuenta corriente', data.accountId);

        if (cmpDecimal(data.amount, account.balance) > 0) {
          throw new ConstraintError(
            'PAYMENT_EXCEEDS_BALANCE',
            `El pago (${data.amount}) supera el saldo de la cuenta (${account.balance})`,
          );
        }

        const newBalance = subDecimal(account.balance, data.amount, 4);
        const newStatus =
          cmpDecimal(newBalance, '0') === 0
            ? 'paid'
            : cmpDecimal(newBalance, account.total) === 0
              ? 'open'
              : 'partial';

        const inserted = tx
          .insert(payments)
          .values({
            accountId: data.accountId,
            amount: data.amount,
            date: now,
            method: data.method,
            notes: data.notes ?? null,
          })
          .returning()
          .all()[0];
        if (!inserted) throw new ConstraintError('PAYMENT_INSERT', 'No se pudo registrar el pago');

        tx
          .update(accountsReceivable)
          .set({ balance: newBalance, status: newStatus })
          .where(eq(accountsReceivable.id, data.accountId))
          .run();

        tx.insert(cashMovements).values({
          cashRegisterId: data.cashRegisterId,
          type: 'income',
          description: `Cobranza cuenta ${data.accountId}`,
          amount: data.amount,
          date: now,
          userId: data.userId,
        }).run();

        return inserted;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
