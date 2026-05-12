import { eq } from 'drizzle-orm';
import { CreateCardSchema, UpdateCardSchema } from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { cards, type Card, type NewCard } from '../schema/local';
import { BaseRepository } from './base.repository';

export class CardRepository extends BaseRepository<Card, NewCard> {
  protected override readonly createSchema = CreateCardSchema;
  protected override readonly updateSchema = UpdateCardSchema;

  constructor(db: LocalDatabase) {
    super(db, cards, 'Tarjeta');
  }

  async findActive(): Promise<Card[]> {
    try {
      return this.db.select().from(cards).where(eq(cards.active, true)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
