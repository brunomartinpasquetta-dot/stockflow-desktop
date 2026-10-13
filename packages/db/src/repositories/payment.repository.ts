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
  cashRegisters,
  customers,
  paymentMethods,
  payments,
  type AccountReceivable,
  type NewPayment,
  type Payment,
} from '../schema/local';
import { BaseRepository } from './base.repository';
import { exigirCajaAbiertaEnTx } from './cajaAbierta';

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

        // AUDITORÍA sep-2026 (A4): la caja tiene que seguir abierta DENTRO de
        // la transacción; si otra terminal la cerró, la cobranza no puede
        // entrar a un arqueo ya hecho.
        const caja = tx
          .select({ status: cashRegisters.status })
          .from(cashRegisters)
          .where(eq(cashRegisters.id, data.cashRegisterId))
          .get();
        if (caja?.status !== 'open') {
          throw new ConstraintError(
            'CASH_CLOSED',
            'La caja se cerró mientras se registraba la cobranza. Abra una caja e intente de nuevo.',
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
   * ANULA una cobranza (Bruno, 13-oct-2026: «me equivoqué de cliente, ¿puedo
   * revertir ese cobro?»). No borra nada: el pago queda marcado anulado (quién,
   * cuándo, por qué), la deuda vuelve al comprobante y el dinero SALE de la
   * caja con un movimiento nuevo (egreso, mismo medio). Se anulan juntos todos
   * los pagos registrados en el mismo acto para el mismo cliente (un cobro
   * mixto o a nivel cuenta son varias filas con la misma fecha).
   *
   * Caja: si la del cobro sigue abierta, el egreso va ahí; si ya cerró (está
   * arqueada), va a la caja abierta de hoy. Sin caja abierta no se anula.
   */
  async anularCobro(data: {
    paymentId: string;
    userId: string;
    motivo: string;
    cashRegisterId?: string | null;
  }): Promise<{ anulados: number; total: string; customerId: string; cajaUsada: string }> {
    try {
      const motivo = data.motivo.trim();
      if (!motivo) throw new ConstraintError('VOID_REASON_REQUIRED', 'Indique el motivo de la anulación.');
      return this.db.transaction((tx) => {
        const pago = tx.select().from(payments).where(eq(payments.id, data.paymentId)).get();
        if (!pago) throw new NotFoundError('Cobranza', data.paymentId);
        if (pago.voidedAt != null) {
          throw new ConstraintError('PAYMENT_ALREADY_VOIDED', 'Esa cobranza ya está anulada.');
        }
        const cuenta = tx.select().from(accountsReceivable).where(eq(accountsReceivable.id, pago.accountId)).get();
        if (!cuenta) throw new NotFoundError('Cuenta corriente', pago.accountId);

        // Hermanos: mismo cliente, mismo instante, vigentes.
        const cuentasDelCliente = tx
          .select({ id: accountsReceivable.id })
          .from(accountsReceivable)
          .where(eq(accountsReceivable.customerId, cuenta.customerId))
          .all()
          .map((c) => c.id);
        const hermanos = tx
          .select()
          .from(payments)
          .where(and(inArray(payments.accountId, cuentasDelCliente), eq(payments.date, pago.date)))
          .all()
          .filter((p) => p.voidedAt == null);
        const now = Date.now();

        // Caja donde sale el dinero: la del cobro si sigue abierta; si no, la abierta de hoy.
        const abiertas = tx.select().from(cashRegisters).where(eq(cashRegisters.status, 'open')).all();
        const movsOriginales = tx
          .select()
          .from(cashMovements)
          .where(and(eq(cashMovements.type, 'income'), eq(cashMovements.date, pago.date)))
          .all()
          .filter((m) => m.description.startsWith('Cobranza cuenta corriente'));
        const cajaOriginal = movsOriginales[0]?.cashRegisterId ?? null;
        const caja =
          (data.cashRegisterId && abiertas.find((c) => c.id === data.cashRegisterId)?.id) ||
          (cajaOriginal && abiertas.find((c) => c.id === cajaOriginal)?.id) ||
          abiertas.sort((a, b) => b.number - a.number)[0]?.id;
        if (!caja) {
          throw new ConstraintError(
            'NO_OPEN_REGISTER',
            'No hay una caja abierta: abra la caja de hoy para registrar la salida del dinero de la cobranza anulada.',
          );
        }

        const pmRows = tx
          .select()
          .from(paymentMethods)
          .where(inArray(paymentMethods.id, [...new Set(hermanos.map((h) => h.paymentMethodId))]))
          .all();
        const pmMap = new Map(pmRows.map((r) => [r.id, r]));

        let total = '0.0000';
        for (const h of hermanos) {
          total = sumDecimals([total, h.amount]);
          tx.update(payments)
            .set({ voidedAt: now, voidedBy: data.userId, voidReason: motivo })
            .where(eq(payments.id, h.id))
            .run();
          // La deuda vuelve al comprobante.
          const ac = tx.select().from(accountsReceivable).where(eq(accountsReceivable.id, h.accountId)).get();
          if (!ac) throw new NotFoundError('Cuenta corriente', h.accountId);
          const nuevoSaldo = sumDecimals([ac.balance, h.amount]);
          const estado =
            cmpDecimal(nuevoSaldo, '0') === 0 ? 'paid' : cmpDecimal(nuevoSaldo, ac.total) >= 0 ? 'open' : 'partial';
          tx.update(accountsReceivable)
            .set({ balance: cmpDecimal(nuevoSaldo, ac.total) > 0 ? ac.total : nuevoSaldo, status: estado })
            .where(eq(accountsReceivable.id, h.accountId))
            .run();
          // El dinero sale de la caja, con el mismo medio con que entró.
          const pm = pmMap.get(h.paymentMethodId);
          tx.insert(cashMovements)
            .values({
              cashRegisterId: caja,
              type: 'expense',
              description: `Anulación de cobranza${pm && !pm.isPhysicalCash ? ` — ${pm.name}` : ''}: ${motivo}`,
              amount: h.amount,
              date: now,
              userId: data.userId,
              paymentMethodId: h.paymentMethodId,
            })
            .run();
        }
        return { anulados: hermanos.length, total, customerId: cuenta.customerId, cajaUsada: caja };
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
        // AUDITORÍA sep-2026: la caja tiene que seguir abierta DENTRO de la
        // transacción, igual que en la cobranza por comprobante. Si otra
        // terminal la cerró en el medio, este ingreso entraba a un arqueo ya
        // hecho y el cierre dejaba de cuadrar.
        exigirCajaAbiertaEnTx(tx, data.cashRegisterId, 'la cobranza');

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
