import { eq } from 'drizzle-orm';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { purchaseLines, type NewPurchaseLine, type PurchaseLine } from '../schema/local';
import { BaseRepository } from './base.repository';

export class PurchaseLineRepository extends BaseRepository<PurchaseLine, NewPurchaseLine> {
  constructor(db: LocalDatabase) {
    super(db, purchaseLines, 'Línea de compra');
  }

  async findByPurchase(purchaseId: string): Promise<PurchaseLine[]> {
    try {
      return this.db
        .select()
        .from(purchaseLines)
        .where(eq(purchaseLines.purchaseId, purchaseId))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
