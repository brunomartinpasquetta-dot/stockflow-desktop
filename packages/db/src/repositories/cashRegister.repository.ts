import { and, eq, gte, lte, max } from 'drizzle-orm';
import {
  CloseCashRegisterSchema,
  OpenCashRegisterSchema,
  type CloseCashRegisterInput,
  type OpenCashRegisterInput,
  sumDecimals,
  subDecimal,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashMovements,
  cashRegisters,
  type CashRegister,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export class CashRegisterRepository extends BaseRepository<
  CashRegister,
  typeof cashRegisters.$inferInsert
> {
  constructor(db: LocalDatabase) {
    super(db, cashRegisters, 'Caja');
  }

  /** Caja actualmente abierta (la última con status='open'), o `null`. */
  async getCurrentOpen(): Promise<CashRegister | null> {
    try {
      const row = this.db
        .select()
        .from(cashRegisters)
        .where(eq(cashRegisters.status, 'open'))
        .all();
      // Si por algún motivo hay más de una, devolvemos la de mayor número.
      return row.sort((a, b) => b.number - a.number)[0] ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Abre una caja nueva. Falla si ya hay una abierta. */
  async openRegister(rawData: unknown): Promise<CashRegister> {
    try {
      const data = this.parseOrThrow<OpenCashRegisterInput>(OpenCashRegisterSchema, rawData);
      return this.db.transaction((tx) => {
        const open = tx
          .select({ id: cashRegisters.id })
          .from(cashRegisters)
          .where(eq(cashRegisters.status, 'open'))
          .get();
        if (open) {
          throw new ConstraintError('CASH_ALREADY_OPEN', 'Ya hay una caja abierta');
        }
        const numRow = tx.select({ value: max(cashRegisters.number) }).from(cashRegisters).get();
        const number = (numRow?.value ?? 0) + 1;
        const now = Date.now();
        const inserted = tx
          .insert(cashRegisters)
          .values({
            number,
            openDate: now,
            openingAmount: data.openingAmount ?? '0.0000',
            status: 'open',
            userId: data.userId,
          })
          .returning()
          .all()[0];
        if (!inserted) throw new ConstraintError('CASH_INSERT', 'No se pudo abrir la caja');
        return inserted;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Cierra una caja: registra `closingAmount`, `closeDate`, calcula la diferencia
   * contra (apertura + ingresos − egresos) y la guarda en `notes`.
   */
  async closeRegister(id: string, rawData: CloseCashRegisterInput): Promise<CashRegister> {
    try {
      const data = this.parseOrThrow<CloseCashRegisterInput>(CloseCashRegisterSchema, rawData);
      return this.db.transaction((tx) => {
        const register = tx.select().from(cashRegisters).where(eq(cashRegisters.id, id)).get();
        if (!register) throw new NotFoundError(this.entityName, id);
        if (register.status === 'closed') {
          throw new ConstraintError('CASH_ALREADY_CLOSED', `La caja ${id} ya está cerrada`);
        }

        const movements = tx
          .select({ type: cashMovements.type, amount: cashMovements.amount })
          .from(cashMovements)
          .where(eq(cashMovements.cashRegisterId, id))
          .all();
        const incomes = sumDecimals(movements.filter((m) => m.type === 'income').map((m) => m.amount));
        const expenses = sumDecimals(movements.filter((m) => m.type === 'expense').map((m) => m.amount));
        const expected = subDecimal(
          sumDecimals([register.openingAmount, incomes]),
          expenses,
          4,
        );
        const difference = subDecimal(data.closingAmount, expected, 4);
        const arqueo = `Esperado: ${expected} | Declarado: ${data.closingAmount} | Diferencia: ${difference}`;
        const userNotes = data.notes?.trim();
        const notes = userNotes ? `${userNotes}\n${arqueo}` : arqueo;

        const updated = tx
          .update(cashRegisters)
          .set({
            status: 'closed',
            closeDate: Date.now(),
            closingAmount: data.closingAmount,
            notes,
          })
          .where(eq(cashRegisters.id, id))
          .returning()
          .all()[0];
        if (!updated) throw new NotFoundError(this.entityName, id);
        return updated;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByDateRange(from: number, to: number): Promise<CashRegister[]> {
    try {
      return this.db
        .select()
        .from(cashRegisters)
        .where(and(gte(cashRegisters.openDate, from), lte(cashRegisters.openDate, to)))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
