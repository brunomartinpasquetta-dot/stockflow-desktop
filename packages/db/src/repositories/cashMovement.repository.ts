import { and, eq, gte, lte } from 'drizzle-orm';
import { CreateCashMovementSchema } from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashMovements,
  type CashMovement,
  type NewCashMovement,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export class CashMovementRepository extends BaseRepository<CashMovement, NewCashMovement> {
  protected override readonly createSchema = CreateCashMovementSchema;

  constructor(db: LocalDatabase) {
    super(db, cashMovements, 'Movimiento de caja');
  }

  async findByRegister(cashRegisterId: string): Promise<CashMovement[]> {
    try {
      return this.db
        .select()
        .from(cashMovements)
        .where(eq(cashMovements.cashRegisterId, cashRegisterId))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByDateRange(from: number, to: number): Promise<CashMovement[]> {
    try {
      return this.db
        .select()
        .from(cashMovements)
        .where(and(gte(cashMovements.date, from), lte(cashMovements.date, to)))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
