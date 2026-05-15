/**
 * Repositorio Caja General: saldo histórico global (caja fuerte / acumulado).
 *
 * Single-row pattern: hay UNA sola fila en `cash_general` con id='singleton'
 * (creada por la migración 0007). Los movimientos van a `cash_general_movements`.
 */
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { addDecimal, subDecimal } from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashGeneral,
  cashGeneralMovements,
  type CashGeneralMovement,
} from '../schema/local';

const SINGLETON_ID = 'singleton';

export type CashGeneralMovementType = 'income' | 'expense' | 'transfer_from_daily';
export type CashGeneralCategory = 'deposit' | 'withdrawal' | 'service' | 'salary' | 'other';

export interface AddCashGeneralMovementInput {
  type: CashGeneralMovementType;
  amount: string;
  description: string;
  category?: CashGeneralCategory | null;
  createdBy: string;
  referenceId?: string | null;
}

export interface ListMovementsFilter {
  from?: number;
  to?: number;
  type?: CashGeneralMovementType;
  category?: CashGeneralCategory;
  limit?: number;
}

export class CashGeneralRepository {
  constructor(private readonly db: LocalDatabase) {}

  /** Devuelve el saldo actual (string decimal). */
  async getBalance(): Promise<string> {
    try {
      const row = this.db
        .select()
        .from(cashGeneral)
        .where(eq(cashGeneral.id, SINGLETON_ID))
        .get();
      return row?.currentBalance ?? '0';
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findMovements(filter: ListMovementsFilter = {}): Promise<CashGeneralMovement[]> {
    try {
      const conds: SQL[] = [];
      if (filter.from != null) conds.push(gte(cashGeneralMovements.createdAt, filter.from));
      if (filter.to != null) conds.push(lte(cashGeneralMovements.createdAt, filter.to));
      if (filter.type) conds.push(eq(cashGeneralMovements.type, filter.type));
      if (filter.category) conds.push(eq(cashGeneralMovements.category, filter.category));

      let q = this.db.select().from(cashGeneralMovements).$dynamic();
      if (conds.length > 0) q = q.where(conds.length === 1 ? conds[0]! : and(...conds)!);
      q = q.orderBy(desc(cashGeneralMovements.createdAt));
      if (filter.limit != null && filter.limit > 0) q = q.limit(filter.limit);
      return q.all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Crea un movimiento de caja general en transacción:
   *  - lee el balance actual,
   *  - calcula nuevo balance (sumar si income/transfer_from_daily, restar si expense),
   *  - inserta el movimiento con balanceAfter,
   *  - actualiza la fila singleton.
   */
  async addMovement(input: AddCashGeneralMovementInput): Promise<CashGeneralMovement> {
    try {
      return this.db.transaction((tx) => {
        const cur = tx
          .select()
          .from(cashGeneral)
          .where(eq(cashGeneral.id, SINGLETON_ID))
          .get();

        const now = Date.now();
        const previousBalance = cur?.currentBalance ?? '0';

        const isCredit = input.type === 'income' || input.type === 'transfer_from_daily';
        const balanceAfter = isCredit
          ? addDecimal(previousBalance, input.amount, 2)
          : subDecimal(previousBalance, input.amount, 2);

        const newRow = {
          id: uuidv7(),
          type: input.type,
          amount: input.amount,
          description: input.description,
          category: input.category ?? null,
          createdBy: input.createdBy,
          referenceId: input.referenceId ?? null,
          balanceAfter,
          createdAt: now,
        };

        const inserted = tx
          .insert(cashGeneralMovements)
          .values(newRow)
          .returning()
          .all();

        // Upsert singleton (debería existir por la migración, pero defensivo).
        if (cur) {
          tx.update(cashGeneral)
            .set({ currentBalance: balanceAfter, lastUpdate: now })
            .where(eq(cashGeneral.id, SINGLETON_ID))
            .run();
        } else {
          tx.insert(cashGeneral)
            .values({
              id: SINGLETON_ID,
              currentBalance: balanceAfter,
              lastUpdate: now,
              createdAt: now,
            })
            .run();
        }

        const out = inserted[0];
        if (!out) throw new Error('No se devolvió el movimiento insertado');
        return out;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Conteo de movimientos (para diagnóstico/tests). */
  async count(): Promise<number> {
    try {
      const r = this.db
        .select({ c: sql<number>`count(*)` })
        .from(cashGeneralMovements)
        .get();
      return Number(r?.c ?? 0);
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
