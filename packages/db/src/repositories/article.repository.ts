import { and, eq, like, lt, or, sql } from 'drizzle-orm';
import {
  CreateArticleSchema,
  UpdateArticleSchema,
  gteDecimal,
  subDecimal,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { articles, type Article, type NewArticle } from '../schema/local';
import { BaseRepository } from './base.repository';

export class ArticleRepository extends BaseRepository<Article, NewArticle> {
  protected override readonly createSchema = CreateArticleSchema;
  protected override readonly updateSchema = UpdateArticleSchema;

  constructor(db: LocalDatabase) {
    super(db, articles, 'Artículo');
  }

  async findByBarcode(barcode: string): Promise<Article | null> {
    try {
      const row = this.db.select().from(articles).where(eq(articles.barcode, barcode)).get();
      return row ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByFamily(familyId: string): Promise<Article[]> {
    try {
      return this.db.select().from(articles).where(eq(articles.familyId, familyId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findBySupplier(supplierId: string): Promise<Article[]> {
    try {
      return this.db.select().from(articles).where(eq(articles.supplierId, supplierId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Artículos cuyo stock cae por debajo del mínimo configurado. */
  async findLowStock(): Promise<Article[]> {
    try {
      // Comparación numérica sobre columnas TEXT: castear a REAL en SQL.
      return this.db
        .select()
        .from(articles)
        .where(
          and(
            eq(articles.active, true),
            sql`CAST(${articles.stock} AS REAL) < CAST(${articles.minStock} AS REAL)`,
          ),
        )
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Busca por texto en descripción o marca (LIKE, case-insensitive). */
  async searchByText(query: string): Promise<Article[]> {
    try {
      const term = `%${query.trim()}%`;
      return this.db
        .select()
        .from(articles)
        .where(or(like(articles.description, term), like(articles.brand, term)))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async incrementStock(id: string, qty: string): Promise<void> {
    try {
      const res = this.db
        .update(articles)
        .set({
          stock: sql`printf('%.3f', CAST(${articles.stock} AS REAL) + CAST(${qty} AS REAL))`,
        })
        .where(eq(articles.id, id))
        .run();
      if (res.changes === 0) throw new NotFoundError(this.entityName, id);
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /** Descuenta stock validando que alcance; lanza ConstraintError si quedaría negativo. */
  async decrementStock(id: string, qty: string): Promise<void> {
    try {
      const current = this.db
        .select({ stock: articles.stock })
        .from(articles)
        .where(eq(articles.id, id))
        .get();
      if (!current) throw new NotFoundError(this.entityName, id);
      if (!gteDecimal(current.stock, qty)) {
        throw new ConstraintError(
          'STOCK_INSUFFICIENT',
          `Stock insuficiente para el artículo ${id}: hay ${current.stock}, se requieren ${qty}`,
        );
      }
      this.db
        .update(articles)
        .set({ stock: subDecimal(current.stock, qty, 3) })
        .where(eq(articles.id, id))
        .run();
    } catch (err) {
      rethrowDbError(err);
    }
  }
}
