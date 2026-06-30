import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  CreateAccountPaymentSchema,
  CreatePaymentSchema,
  type CreateAccountPaymentInput,
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
  customers,
  paymentMethods,
  payments,
  type AccountReceivable,
  type NewPayment,
  type Payment,
} from '../schema/local';
import { BaseRepository } from './base.repository';

/** Resultado de una cobranza a nivel cuenta (distribuida entre comprobantes FIFO). */
export interface AccountPaymentResult {
  /** Filas de pago insertadas (una por (comprobante × medio) usado). */
  payments: Payment[];
  /** Comprobantes afectados, con su balance/status ya actualizados. */
  accounts: AccountReceivable[];
  /** Total efectivamente aplicado (= suma de payments). */
  totalApplied: string;
}

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

  /**
   * Registra una cobranza a NIVEL CUENTA: un monto (posiblemente mixto) que se
   * aplica al saldo total del cliente distribuyéndose automáticamente entre sus
   * comprobantes abiertos en orden FIFO (del más viejo al más nuevo). Todo en una
   * sola transacción. Por cada (comprobante × medio) usado inserta una fila de
   * pago y un movimiento de caja de ingreso; recalcula balance/status de cada
   * comprobante igual que `createPayment`. Lanza `ConstraintError` si el total
   * cobrado supera la suma de saldos abiertos.
   */
  async createAccountPayment(rawData: CreateAccountPaymentInput): Promise<AccountPaymentResult> {
    try {
      const data = this.parseOrThrow<CreateAccountPaymentInput>(
        CreateAccountPaymentSchema,
        rawData,
      );
      const now = data.date ?? Date.now();
      const total = sumDecimals(data.payments.map((p) => p.amount));

      return this.db.transaction((tx) => {
        if (cmpDecimal(total, '0') <= 0) {
          throw new ConstraintError('PAYMENT_ZERO', 'La cobranza debe ser mayor a cero');
        }

        const customer = tx
          .select({ firstName: customers.firstName, lastName: customers.lastName })
          .from(customers)
          .where(eq(customers.id, data.customerId))
          .get();
        if (!customer) throw new NotFoundError('Cliente', data.customerId);
        const customerName = customer.firstName
          ? `${customer.lastName}, ${customer.firstName}`
          : customer.lastName;

        // Comprobantes abiertos del cliente, FIFO (más viejo primero).
        const openARs = tx
          .select()
          .from(accountsReceivable)
          .where(
            and(
              eq(accountsReceivable.customerId, data.customerId),
              ne(accountsReceivable.status, 'paid'),
            ),
          )
          .orderBy(asc(accountsReceivable.createdAt))
          .all();

        const totalOpen = sumDecimals(openARs.map((ar) => ar.balance));
        if (cmpDecimal(total, totalOpen) > 0) {
          throw new ConstraintError(
            'PAYMENT_EXCEEDS_BALANCE',
            `La cobranza (${total}) supera el saldo total del cliente (${totalOpen})`,
          );
        }

        const pmIds = [...new Set(data.payments.map((p) => p.paymentMethodId))];
        const pmRows = tx
          .select()
          .from(paymentMethods)
          .where(inArray(paymentMethods.id, pmIds))
          .all();
        const pmMap = new Map(pmRows.map((r) => [r.id, r]));
        for (const p of data.payments) {
          if (!pmMap.has(p.paymentMethodId)) {
            throw new NotFoundError('Medio de pago', p.paymentMethodId);
          }
        }

        // Pool mutable de medios, en el orden recibido.
        const remaining = data.payments.map((p) => ({
          methodId: p.paymentMethodId,
          amount: p.amount,
        }));

        const inserted: Payment[] = [];
        const updatedAccounts: AccountReceivable[] = [];
        let totalRestante = total;

        for (const ar of openARs) {
          if (cmpDecimal(totalRestante, '0') <= 0) break;
          // Porción que absorbe este comprobante = min(saldo, totalRestante).
          const arPortion =
            cmpDecimal(ar.balance, totalRestante) <= 0 ? ar.balance : totalRestante;
          if (cmpDecimal(arPortion, '0') <= 0) continue;

          let toFill = arPortion;
          for (const m of remaining) {
            if (cmpDecimal(m.amount, '0') <= 0) continue;
            if (cmpDecimal(toFill, '0') <= 0) break;
            const take = cmpDecimal(m.amount, toFill) <= 0 ? m.amount : toFill;
            const pm = pmMap.get(m.methodId)!;

            const row = tx
              .insert(payments)
              .values({
                accountId: ar.id,
                amount: take,
                date: now,
                paymentMethodId: m.methodId,
                notes: data.notes ?? null,
              })
              .returning()
              .all()[0];
            if (!row) throw new ConstraintError('PAYMENT_INSERT', 'No se pudo registrar el pago');
            inserted.push(row);

            const desc = pm.isPhysicalCash
              ? `Cobranza cuenta corriente — ${customerName}`
              : `Cobranza cuenta corriente — ${customerName} — ${pm.name}`;
            tx
              .insert(cashMovements)
              .values({
                cashRegisterId: data.cashRegisterId,
                type: 'income',
                description: desc,
                amount: take,
                date: now,
                userId: data.userId,
                paymentMethodId: pm.id,
              })
              .run();

            m.amount = subDecimal(m.amount, take, 4);
            toFill = subDecimal(toFill, take, 4);
          }

          const newBalance = subDecimal(ar.balance, arPortion, 4);
          const newStatus =
            cmpDecimal(newBalance, '0') === 0
              ? 'paid'
              : cmpDecimal(newBalance, ar.total) === 0
                ? 'open'
                : 'partial';
          const updated = tx
            .update(accountsReceivable)
            .set({ balance: newBalance, status: newStatus })
            .where(eq(accountsReceivable.id, ar.id))
            .returning()
            .all()[0];
          if (updated) updatedAccounts.push(updated);

          totalRestante = subDecimal(totalRestante, arPortion, 4);
        }

        return { payments: inserted, accounts: updatedAccounts, totalApplied: total };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
