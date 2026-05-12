import { eq } from 'drizzle-orm';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { saleLines, type NewSaleLine, type SaleLine } from '../schema/local';
import { BaseRepository } from './base.repository';

export class SaleLineRepository extends BaseRepository<SaleLine, NewSaleLine> {
  constructor(db: LocalDatabase) {
    super(db, saleLines, 'Línea de venta');
  }

  async findBySale(saleId: string): Promise<SaleLine[]> {
    try {
      return this.db.select().from(saleLines).where(eq(saleLines.saleId, saleId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
