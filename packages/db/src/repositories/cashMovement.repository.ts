import { and, eq, gte, lte } from 'drizzle-orm';
import { CreateCashMovementSchema } from '@stockflow/shared';

import { ConstraintError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashMovements,
  type CashMovement,
  type NewCashMovement,
} from '../schema/local';
import { BaseRepository } from './base.repository';
import { exigirCajaAbiertaEnTx } from './cajaAbierta';

export class CashMovementRepository extends BaseRepository<CashMovement, NewCashMovement> {
  protected override readonly createSchema = CreateCashMovementSchema;

  constructor(db: LocalDatabase) {
    super(db, cashMovements, 'Movimiento de caja');
  }

  /**
   * Alta de un movimiento MANUAL comprobando, en la misma transacción, que la
   * caja siga abierta (un ingreso/egreso a mano tampoco puede entrar a una
   * caja que otra terminal acaba de cerrar).
   */
  async createInOpenRegister(input: NewCashMovement): Promise<CashMovement> {
    try {
      const data = this.parseOrThrow<NewCashMovement>(CreateCashMovementSchema, input);
      return this.db.transaction((tx) => {
        exigirCajaAbiertaEnTx(tx, data.cashRegisterId, 'el movimiento');
        const row = tx.insert(cashMovements).values(data).returning().all()[0];
        if (!row) throw new ConstraintError('CASH_MOVEMENT_INSERT', 'No se pudo registrar el movimiento');
        return row;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
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
