import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import {
  CreateArticleSchema,
  UpdateArticleSchema,
  gteDecimal,
  subDecimal,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { articles, families, suppliers, type Article, type NewArticle } from '../schema/local';
import { BaseRepository } from './base.repository';

export class ArticleRepository extends BaseRepository<Article, NewArticle> {
  protected override readonly createSchema = CreateArticleSchema;
  protected override readonly updateSchema = UpdateArticleSchema;

  /**
   * Borra el artículo, o lo DA DE BAJA si ya tiene historial (ventas,
   * devoluciones, compras, presupuestos, promociones o cambios de precio).
   *
   * Antes el borrado fallaba con "FOREIGN KEY constraint failed" y el comercio
   * no tenía forma de sacarlo de la lista. Borrarlo igual rompería el
   * historial; dado de baja deja de aparecer para vender y en la lista (salvo
   * con "Incluir dados de baja"), y se puede reactivar.
   */
  async borrarODarDeBaja(id: string): Promise<'borrado' | 'dado_de_baja'> {
    try {
      await this.delete(id);
      return 'borrado';
    } catch (err) {
      if (err instanceof ConstraintError && err.constraint.includes('FOREIGNKEY')) {
        await this.update(id, { active: false });
        return 'dado_de_baja';
      }
      throw err;
    }
  }

  constructor(db: LocalDatabase) {
    super(db, articles, 'Artículo');
  }

  /**
   * "Huella" del padrón: cuántos artículos hay y la última modificación. Si
   * no cambió, lo que se armó a partir del padrón (el índice del asociador de
   * facturas por teléfono) sigue valiendo. Toda escritura por el repositorio
   * pisa `updated_at`, y el máximo sale del índice de esa columna.
   */
  async huella(): Promise<{ cantidad: number; ultimaModificacion: number }> {
    try {
      const fila = this.db
        .select({ n: sql<number>`count(*)`, u: sql<number>`coalesce(max(${articles.updatedAt}), 0)` })
        .from(articles)
        .get();
      return { cantidad: Number(fila?.n ?? 0), ultimaModificacion: Number(fila?.u ?? 0) };
    } catch (err) {
      return rethrowDbError(err);
    }
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

  /** Busca por texto en descripción, marca, familia o proveedor (LIKE, case-insensitive). */
  async searchByText(query: string): Promise<Article[]> {
    try {
      const term = `%${query.trim()}%`;
      return this.db
        .select()
        .from(articles)
        .where(
          or(
            like(articles.description, term),
            like(articles.brand, term),
            inArray(articles.familyId, this.db.select({ id: families.id }).from(families).where(like(families.name, term))),
            inArray(articles.supplierId, this.db.select({ id: suppliers.id }).from(suppliers).where(like(suppliers.name, term))),
          ),
        )
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Búsqueda multi-campo (descripción, marca o código de barras) con límite,
   * usada por la búsqueda global (P-BUSQUEDA).
   */
  async findByText(query: string, limit = 8): Promise<Article[]> {
    try {
      const term = `%${query.trim()}%`;
      return this.db
        .select()
        .from(articles)
        .where(
          and(
            eq(articles.active, true),
            or(
              like(articles.barcode, term),
              like(articles.description, term),
              like(articles.brand, term),
              inArray(articles.familyId, this.db.select({ id: families.id }).from(families).where(like(families.name, term))),
              inArray(articles.supplierId, this.db.select({ id: suppliers.id }).from(suppliers).where(like(suppliers.name, term))),
            ),
          ),
        )
        .limit(limit)
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Carga la utilidad (% sobre el costo) de cada lista a partir de los precios
   * que el artículo YA tiene. Es el inverso exacto de la fórmula de las compras
   * (`precio = costo × (1 + m/100)`, redondeado a peso), así una compra
   * posterior en modo "por margen" reproduce los precios de hoy en vez de
   * pisarlos con otros.
   *
   * Un comercio migrado desde otro sistema entra con precios y sin utilidad
   * (Denver Drugstore: 598 artículos, ninguno con margen): cargarla a mano son
   * 600 fichas. Sólo artículos activos con costo > 0, y cada lista sólo si
   * tiene precio > 0. Con `soloVacios` no se toca la utilidad que el comercio
   * ya cargó a mano. Nunca cambia un precio.
   */
  async recalcularMargenesDesdePrecios(opts: {
    soloVacios: boolean;
  }): Promise<{ actualizados: number; sinCosto: number; yaTenian: number }> {
    try {
      return this.db.transaction((tx) => {
        const filas = tx
          .select({
            id: articles.id,
            costPrice: articles.costPrice,
            listPrice1: articles.listPrice1,
            listPrice2: articles.listPrice2,
            listPrice3: articles.listPrice3,
            margin1: articles.margin1,
            margin2: articles.margin2,
            margin3: articles.margin3,
          })
          .from(articles)
          .where(eq(articles.active, true))
          .all();
        const cargado = (m: string | null): boolean => m != null && m.trim() !== '';
        const ahora = Date.now();
        let actualizados = 0;
        let sinCosto = 0;
        let yaTenian = 0;
        for (const a of filas) {
          const costo = Number(a.costPrice);
          if (!(costo > 0)) {
            sinCosto++;
            continue;
          }
          const set: Partial<Record<'margin1' | 'margin2' | 'margin3', string>> = {};
          let respetadas = 0;
          const listas: Array<['margin1' | 'margin2' | 'margin3', string, string | null]> = [
            ['margin1', a.listPrice1, a.margin1],
            ['margin2', a.listPrice2, a.margin2],
            ['margin3', a.listPrice3, a.margin3],
          ];
          for (const [col, precio, margenActual] of listas) {
            const p = Number(precio);
            if (!(p > 0)) continue;
            if (opts.soloVacios && cargado(margenActual)) {
              respetadas++;
              continue;
            }
            set[col] = ((p / costo - 1) * 100).toFixed(2);
          }
          if (Object.keys(set).length === 0) {
            if (respetadas > 0) yaTenian++;
            continue;
          }
          tx.update(articles).set({ ...set, updatedAt: ahora }).where(eq(articles.id, a.id)).run();
          actualizados++;
        }
        return { actualizados, sinCosto, yaTenian };
      });
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
