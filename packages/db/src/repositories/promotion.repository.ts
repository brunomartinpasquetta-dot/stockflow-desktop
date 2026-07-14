/**
 * Repositorio de PROMOCIONES (combos).
 *
 * Diseño "artículo espejo": cada promo es una fila real en `articles` (marca
 * 'PROMO', código PROMO-N) para que el PDV, el ticket, el IVA y los reportes
 * funcionen sin casos especiales. Este repo mantiene en una transacción el
 * espejo + la fila de `promotions` + sus `promotion_items`, y calcula el
 * COSTO REAL (Σ cantidad × costo del componente) que se persiste como
 * `costPrice` del espejo (así el CMV de contabilidad sale bien solo).
 *
 * El stock del espejo NO se usa: al vender, `SaleRepository` descuenta el
 * stock de los componentes (ver sale.repository.ts).
 */
import { asc, eq, inArray } from 'drizzle-orm';
import { addDecimal, mulDecimal } from '@stockflow/shared';

import {
  articles,
  promotionItems,
  promotions,
  type Promotion,
  type NewPromotion,
} from '../schema/local';
import type { LocalDatabase } from '../local/client';
import { ConstraintError, NotFoundError } from '../errors';
import { BaseRepository } from './base.repository';

/** Tipo del handle transaccional de better-sqlite3/drizzle. */
type LocalTx = Parameters<Parameters<LocalDatabase['transaction']>[0]>[0];

export interface PromotionItemDetail {
  articleId: string;
  barcode: string;
  description: string;
  quantity: string;
  costPrice: string;
  stock: string;
}

export interface PromotionDetail {
  id: string;
  articleId: string;
  name: string;
  code: string;
  price: string;
  cost: string;
  active: boolean;
  notes: string | null;
  items: PromotionItemDetail[];
  createdAt: number;
  updatedAt: number;
}

export interface PromotionWriteInput {
  name: string;
  price: string;
  notes?: string | null;
  items: Array<{ articleId: string; quantity: string }>;
  active?: boolean;
}

export class PromotionRepository extends BaseRepository<Promotion, NewPromotion> {
  constructor(db: LocalDatabase) {
    super(db, promotions, 'Promoción');
  }

  /** Todas las promos con su espejo e items (costo real recalculado en vivo). */
  async listWithDetails(): Promise<PromotionDetail[]> {
    const promoRows = this.db
      .select({
        id: promotions.id,
        articleId: promotions.articleId,
        createdAt: promotions.createdAt,
        updatedAt: promotions.updatedAt,
        name: articles.description,
        code: articles.barcode,
        price: articles.listPrice1,
        active: articles.active,
        notes: articles.notes,
      })
      .from(promotions)
      .innerJoin(articles, eq(articles.id, promotions.articleId))
      .orderBy(asc(articles.description))
      .all();

    if (promoRows.length === 0) return [];
    const itemRows = this.db
      .select({
        promotionId: promotionItems.promotionId,
        articleId: promotionItems.articleId,
        quantity: promotionItems.quantity,
        barcode: articles.barcode,
        description: articles.description,
        costPrice: articles.costPrice,
        stock: articles.stock,
      })
      .from(promotionItems)
      .innerJoin(articles, eq(articles.id, promotionItems.articleId))
      .where(inArray(promotionItems.promotionId, promoRows.map((p) => p.id)))
      .all();

    return promoRows.map((p) => {
      const items = itemRows
        .filter((i) => i.promotionId === p.id)
        .map((i) => ({
          articleId: i.articleId,
          barcode: i.barcode,
          description: i.description,
          quantity: i.quantity,
          costPrice: i.costPrice,
          stock: i.stock,
        }));
      const cost = items.reduce(
        (acc, i) => addDecimal(acc, mulDecimal(i.quantity, i.costPrice, 4), 4),
        '0.0000',
      );
      return {
        id: p.id,
        articleId: p.articleId,
        name: p.name,
        code: p.code,
        price: p.price,
        cost,
        active: p.active,
        notes: p.notes,
        items,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }

  async getDetail(id: string): Promise<PromotionDetail | null> {
    const all = await this.listWithDetails();
    return all.find((p) => p.id === id) ?? null;
  }

  /**
   * Alta: crea el artículo espejo + la promo + los items en una transacción.
   * Valida que los componentes existan y que NO sean promos a su vez.
   */
  async createWithItems(input: PromotionWriteInput): Promise<PromotionDetail> {
    const promoId = this.db.transaction((tx) => {
      const { componentById, cost } = this.loadComponents(tx, input.items);

      // Código único PROMO-N (N = cantidad histórica + 1, con reintento).
      const countRow = tx.select({ id: promotions.id }).from(promotions).all();
      let n = countRow.length + 1;
      let code = `PROMO-${String(n).padStart(2, '0')}`;
      while (tx.select({ id: articles.id }).from(articles).where(eq(articles.barcode, code)).get()) {
        n += 1;
        code = `PROMO-${String(n).padStart(2, '0')}`;
      }

      const mirror = tx
        .insert(articles)
        .values({
          barcode: code,
          description: input.name,
          brand: 'PROMO',
          costPrice: cost,
          listPrice1: input.price,
          listPrice2: input.price,
          listPrice3: input.price,
          wholesalePrice: '0.0000',
          vatRate: '21.00',
          stock: '0.000',
          notes: input.notes ?? null,
          active: input.active ?? true,
        })
        .returning()
        .all()[0];
      if (!mirror) throw new ConstraintError('PROMO_MIRROR', 'No se pudo crear el artículo de la promo');

      const promo = tx.insert(promotions).values({ articleId: mirror.id }).returning().all()[0];
      if (!promo) throw new ConstraintError('PROMO_INSERT', 'No se pudo crear la promoción');

      for (const item of input.items) {
        const comp = componentById.get(item.articleId);
        if (!comp) throw new NotFoundError('Artículo componente', item.articleId);
        tx.insert(promotionItems)
          .values({ promotionId: promo.id, articleId: item.articleId, quantity: item.quantity })
          .run();
      }
      return promo.id;
    });

    const detail = await this.getDetail(promoId);
    if (!detail) throw new NotFoundError('Promoción', promoId);
    return detail;
  }

  /** Modificación: actualiza espejo (nombre/precio/activa/notas) y reemplaza items si vienen. */
  async updateWithItems(id: string, input: Partial<PromotionWriteInput>): Promise<PromotionDetail> {
    this.db.transaction((tx) => {
      const promo = tx.select().from(promotions).where(eq(promotions.id, id)).get();
      if (!promo) throw new NotFoundError('Promoción', id);

      if (input.items && input.items.length > 0) {
        this.loadComponents(tx, input.items); // valida existencia y anti-anidado
        tx.delete(promotionItems).where(eq(promotionItems.promotionId, id)).run();
        for (const item of input.items) {
          tx.insert(promotionItems)
            .values({ promotionId: id, articleId: item.articleId, quantity: item.quantity })
            .run();
        }
      }

      // Recalcular SIEMPRE el costo real con los items vigentes (los costos de
      // los componentes pueden haber cambiado desde el último guardado).
      const currentItems = tx
        .select({ articleId: promotionItems.articleId, quantity: promotionItems.quantity })
        .from(promotionItems)
        .where(eq(promotionItems.promotionId, id))
        .all();
      const { cost } = this.loadComponents(tx, currentItems);

      const mirrorPatch: Record<string, unknown> = { costPrice: cost, updatedAt: Date.now() };
      if (input.name !== undefined) mirrorPatch.description = input.name;
      if (input.notes !== undefined) mirrorPatch.notes = input.notes;
      if (input.active !== undefined) mirrorPatch.active = input.active;
      if (input.price !== undefined) {
        mirrorPatch.listPrice1 = input.price;
        mirrorPatch.listPrice2 = input.price;
        mirrorPatch.listPrice3 = input.price;
      }
      tx.update(articles).set(mirrorPatch).where(eq(articles.id, promo.articleId)).run();
      tx.update(promotions).set({ updatedAt: Date.now() }).where(eq(promotions.id, id)).run();
    });

    const detail = await this.getDetail(id);
    if (!detail) throw new NotFoundError('Promoción', id);
    return detail;
  }

  /**
   * Baja: borra promo + items + artículo espejo. Si el espejo ya participó de
   * ventas/presupuestos (FK), se rechaza con un mensaje claro: hay que
   * DESACTIVARLA en su lugar (queda el historial intacto).
   */
  async deleteWithMirror(id: string): Promise<{ deleted: true }> {
    this.db.transaction((tx) => {
      const promo = tx.select().from(promotions).where(eq(promotions.id, id)).get();
      if (!promo) throw new NotFoundError('Promoción', id);
      tx.delete(promotionItems).where(eq(promotionItems.promotionId, id)).run();
      tx.delete(promotions).where(eq(promotions.id, id)).run();
      try {
        tx.delete(articles).where(eq(articles.id, promo.articleId)).run();
      } catch {
        throw new ConstraintError(
          'PROMO_IN_USE',
          'La promoción ya tiene ventas registradas: no se puede eliminar. Desactivala para que deje de venderse (el historial se conserva).',
        );
      }
    });
    return { deleted: true };
  }

  /** Carga y valida componentes; devuelve el costo real total. */
  private loadComponents(
    tx: LocalTx,
    items: Array<{ articleId: string; quantity: string }>,
  ): { componentById: Map<string, { costPrice: string }>; cost: string } {
    const ids = items.map((i) => i.articleId);
    if (ids.length === 0) return { componentById: new Map(), cost: '0.0000' };

    const rows = tx
      .select({ id: articles.id, costPrice: articles.costPrice, description: articles.description })
      .from(articles)
      .where(inArray(articles.id, ids))
      .all();
    const componentById = new Map(rows.map((r) => [r.id, { costPrice: r.costPrice }]));
    for (const item of items) {
      if (!componentById.has(item.articleId)) {
        throw new NotFoundError('Artículo componente', item.articleId);
      }
    }

    // Anti-anidado: un componente no puede ser a su vez una promo.
    const nested = tx
      .select({ articleId: promotions.articleId })
      .from(promotions)
      .where(inArray(promotions.articleId, ids))
      .all();
    if (nested.length > 0) {
      throw new ConstraintError(
        'PROMO_NESTED',
        'Una promoción no puede incluir otra promoción como componente.',
      );
    }

    let cost = '0.0000';
    for (const item of items) {
      const comp = componentById.get(item.articleId);
      if (comp) cost = addDecimal(cost, mulDecimal(item.quantity, comp.costPrice, 4), 4);
    }
    return { componentById, cost };
  }
}
