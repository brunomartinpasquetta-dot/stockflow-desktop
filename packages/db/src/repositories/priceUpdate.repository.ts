/**
 * Repositorio de actualizaciones masivas de precios.
 *
 * Persiste lotes (`price_update_batches`) y sus entradas individuales
 * (`price_update_entries`) para permitir auditoría e historial por artículo,
 * y un rollback atómico que vuelve los precios al `oldValue` original.
 */
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  articles as articlesTable,
  priceUpdateBatches,
  priceUpdateEntries,
  users,
  type NewPriceUpdateEntry,
  type PriceUpdateBatch,
  type PriceUpdateEntry,
} from '../schema/local';

export interface PriceUpdateBatchWithUser extends PriceUpdateBatch {
  userName: string;
}

export interface PriceUpdateEntryWithBatch extends PriceUpdateEntry {
  batchDescription: string;
  appliedAt: number;
  rolledBackAt: number | null;
  userName: string;
}

export class PriceUpdateRepository {
  constructor(private readonly db: LocalDatabase) {}

  async createBatch(data: {
    id: string;
    userId: string;
    description: string;
    filterJson: string;
    ruleJson: string;
    articlesAffected: number;
    appliedAt: number;
  }): Promise<PriceUpdateBatch> {
    try {
      const rows = this.db
        .insert(priceUpdateBatches)
        .values({
          id: data.id,
          userId: data.userId,
          description: data.description,
          filterJson: data.filterJson,
          ruleJson: data.ruleJson,
          articlesAffected: data.articlesAffected,
          appliedAt: data.appliedAt,
          createdAt: data.appliedAt,
        })
        .returning()
        .all();
      const row = rows[0];
      if (!row) throw new Error('No se pudo crear el batch de actualización de precios');
      return row;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async addEntries(entries: NewPriceUpdateEntry[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      // SQLite tiene un límite de parámetros por statement (~999). Lo partimos.
      const CHUNK = 200;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const slice = entries.slice(i, i + CHUNK);
        this.db.insert(priceUpdateEntries).values(slice).run();
      }
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async findBatches(opts?: {
    from?: number;
    to?: number;
  }): Promise<PriceUpdateBatchWithUser[]> {
    try {
      const conds = [];
      if (opts?.from != null) conds.push(gte(priceUpdateBatches.appliedAt, opts.from));
      if (opts?.to != null) conds.push(lte(priceUpdateBatches.appliedAt, opts.to));
      const where = conds.length === 0
        ? undefined
        : conds.length === 1
          ? conds[0]
          : and(...conds);
      const q = this.db
        .select({
          id: priceUpdateBatches.id,
          userId: priceUpdateBatches.userId,
          description: priceUpdateBatches.description,
          filterJson: priceUpdateBatches.filterJson,
          ruleJson: priceUpdateBatches.ruleJson,
          articlesAffected: priceUpdateBatches.articlesAffected,
          appliedAt: priceUpdateBatches.appliedAt,
          rolledBackAt: priceUpdateBatches.rolledBackAt,
          createdAt: priceUpdateBatches.createdAt,
          userName: users.fullName,
        })
        .from(priceUpdateBatches)
        .leftJoin(users, eq(priceUpdateBatches.userId, users.id));
      const rows = (where ? q.where(where) : q).orderBy(desc(priceUpdateBatches.appliedAt)).all();
      return rows.map((r) => ({
        ...r,
        userName: r.userName ?? '',
      })) as PriceUpdateBatchWithUser[];
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findById(id: string): Promise<PriceUpdateBatch | null> {
    try {
      const row = this.db
        .select()
        .from(priceUpdateBatches)
        .where(eq(priceUpdateBatches.id, id))
        .get();
      return row ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findEntriesByBatch(batchId: string): Promise<PriceUpdateEntry[]> {
    try {
      return this.db
        .select()
        .from(priceUpdateEntries)
        .where(eq(priceUpdateEntries.batchId, batchId))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findEntriesByBatchIds(batchIds: string[]): Promise<PriceUpdateEntry[]> {
    if (batchIds.length === 0) return [];
    try {
      return this.db
        .select()
        .from(priceUpdateEntries)
        .where(inArray(priceUpdateEntries.batchId, batchIds))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findHistoryByArticle(
    articleId: string,
    limit = 10,
  ): Promise<PriceUpdateEntryWithBatch[]> {
    try {
      const rows = this.db
        .select({
          id: priceUpdateEntries.id,
          batchId: priceUpdateEntries.batchId,
          articleId: priceUpdateEntries.articleId,
          field: priceUpdateEntries.field,
          oldValue: priceUpdateEntries.oldValue,
          newValue: priceUpdateEntries.newValue,
          createdAt: priceUpdateEntries.createdAt,
          batchDescription: priceUpdateBatches.description,
          appliedAt: priceUpdateBatches.appliedAt,
          rolledBackAt: priceUpdateBatches.rolledBackAt,
          userName: users.fullName,
        })
        .from(priceUpdateEntries)
        .innerJoin(priceUpdateBatches, eq(priceUpdateEntries.batchId, priceUpdateBatches.id))
        .leftJoin(users, eq(priceUpdateBatches.userId, users.id))
        .where(eq(priceUpdateEntries.articleId, articleId))
        .orderBy(desc(priceUpdateBatches.appliedAt))
        .limit(limit)
        .all();
      return rows.map((r) => ({
        ...r,
        userName: r.userName ?? '',
      })) as PriceUpdateEntryWithBatch[];
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Aplica una actualización masiva en una transacción única:
   *  - crea el batch + entries;
   *  - actualiza el `articles.<field>` correspondiente en cada artículo.
   * Devuelve el id del batch creado.
   */
  async applyBatch(input: {
    userId: string;
    description: string;
    filterJson: string;
    ruleJson: string;
    articleUpdates: Map<string, Partial<Record<'costPrice' | 'listPrice1' | 'listPrice2' | 'listPrice3' | 'wholesalePrice', string>>>;
    entries: Array<{
      articleId: string;
      field: string;
      oldValue: string;
      newValue: string;
    }>;
  }): Promise<{ batchId: string }> {
    try {
      const batchId = uuidv7();
      const now = Date.now();
      const entriesToInsert: NewPriceUpdateEntry[] = input.entries.map((e) => ({
        id: uuidv7(),
        batchId,
        articleId: e.articleId,
        field: e.field,
        oldValue: e.oldValue,
        newValue: e.newValue,
        createdAt: now,
      }));
      this.db.transaction((tx) => {
        tx.insert(priceUpdateBatches)
          .values({
            id: batchId,
            userId: input.userId,
            description: input.description,
            filterJson: input.filterJson,
            ruleJson: input.ruleJson,
            articlesAffected: input.articleUpdates.size,
            appliedAt: now,
            createdAt: now,
          })
          .run();
        const CHUNK = 200;
        for (let i = 0; i < entriesToInsert.length; i += CHUNK) {
          const slice = entriesToInsert.slice(i, i + CHUNK);
          tx.insert(priceUpdateEntries).values(slice).run();
        }
        for (const [articleId, fields] of input.articleUpdates) {
          tx.update(articlesTable).set(fields).where(eq(articlesTable.id, articleId)).run();
        }
      });
      return { batchId };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Revierte un batch en transacción única:
   *  - restaura los precios a `oldValue`;
   *  - marca `rolledBackAt`.
   * Devuelve la cantidad de entries revertidas.
   */
  async rollbackBatchAtomic(
    batchId: string,
    restoreByArticle: Map<string, Partial<Record<string, string>>>,
  ): Promise<void> {
    try {
      this.db.transaction((tx) => {
        for (const [articleId, fields] of restoreByArticle) {
          tx.update(articlesTable).set(fields).where(eq(articlesTable.id, articleId)).run();
        }
        tx.update(priceUpdateBatches)
          .set({ rolledBackAt: Date.now() })
          .where(eq(priceUpdateBatches.id, batchId))
          .run();
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async markRolledBack(batchId: string, at: number): Promise<void> {
    try {
      this.db
        .update(priceUpdateBatches)
        .set({ rolledBackAt: at })
        .where(eq(priceUpdateBatches.id, batchId))
        .run();
    } catch (err) {
      rethrowDbError(err);
    }
  }
}
