/**
 * Repositorio del ESPEJO DEL CATÁLOGO WEB.
 *
 * Dos responsabilidades: el estado del sincronizador (singleton) y la lista de
 * artículos a publicar.
 *
 * Lo que se publica es ESTADO, no eventos: "este artículo tiene 7 disponibles",
 * nunca "salieron 3". Por eso reenviar un artículo de más no rompe nada y la PC
 * puede estar apagada una semana sin que haya que reconstruir un historial.
 */
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { articles, catalogoSync, type CatalogoSync } from '../schema/local';

const SYNC_ID = 'singleton';

/** Un artículo tal como viaja al catálogo. */
export interface ArticuloParaCatalogo {
  /** Código de barras: es la clave que une los dos mundos. */
  codigo: string;
  nombre: string;
  precio: number;
  /** Lo que se puede vender por web AHORA (stock real menos lo reservado). */
  stock: number;
  activo: boolean;
  unidad: string;
}

export class CatalogoRepository {
  constructor(private readonly db: LocalDatabase) {}

  /* ----------------------------- Estado ------------------------------ */

  getState(): CatalogoSync {
    try {
      const row = this.db.select().from(catalogoSync).where(eq(catalogoSync.id, SYNC_ID)).get();
      if (row) return row;
      const now = Date.now();
      const fresh = {
        id: SYNC_ID,
        enabled: false,
        cursor: 0,
        lastRunAt: null,
        lastOkAt: null,
        lastError: null,
        pushedTotal: 0,
        createdAt: now,
        updatedAt: now,
      } satisfies CatalogoSync;
      this.db.insert(catalogoSync).values(fresh).run();
      return fresh;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  saveState(patch: Partial<Omit<CatalogoSync, 'id' | 'createdAt'>>): CatalogoSync {
    try {
      const current = this.getState();
      const next = { ...current, ...patch, updatedAt: Date.now() };
      this.db.update(catalogoSync).set(next).where(eq(catalogoSync.id, SYNC_ID)).run();
      return next;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /* --------------------------- Artículos ----------------------------- */

  /**
   * Artículos cambiados después de `cursor`, listos para publicar.
   *
   * Van los INACTIVOS también: darlos de baja en el sistema tiene que sacarlos
   * de la web, y para eso el catálogo necesita enterarse.
   *
   * `precioLista` elige qué lista se publica (1, 2 o 3).
   */
  listarParaPublicar(input: {
    desde: number;
    limite: number;
    precioLista: 1 | 2 | 3;
  }): { articulos: ArticuloParaCatalogo[]; cursorFinal: number } {
    try {
      const col =
        input.precioLista === 3
          ? articles.listPrice3
          : input.precioLista === 2
            ? articles.listPrice2
            : articles.listPrice1;

      const rows = this.db
        .select({
          codigo: articles.barcode,
          nombre: articles.description,
          precio: col,
          stock: articles.stock,
          activo: articles.active,
          unidad: articles.unit,
          updatedAt: articles.updatedAt,
        })
        .from(articles)
        .where(and(gt(articles.updatedAt, input.desde), isNotNull(articles.barcode)))
        .orderBy(articles.updatedAt)
        .limit(input.limite)
        .all();

      const articulos = rows.map((r) => ({
        codigo: r.codigo,
        nombre: r.nombre,
        precio: Math.round(Number(r.precio ?? '0') * 100) / 100,
        stock: Math.round(Number(r.stock ?? '0') * 1000) / 1000,
        activo: Boolean(r.activo),
        unidad: r.unidad ?? 'UN',
      }));

      // El cursor avanza hasta el último publicado, no hasta "ahora": si algo
      // cambió mientras se armaba la tanda, entra en la vuelta siguiente.
      const cursorFinal = rows.length > 0 ? (rows[rows.length - 1]!.updatedAt ?? input.desde) : input.desde;
      return { articulos, cursorFinal };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Cuántos artículos quedan pendientes de publicar. Para mostrar avance. */
  pendientes(desde: number): number {
    try {
      const row = this.db
        .select({ n: sql<number>`COUNT(*)` })
        .from(articles)
        .where(and(gt(articles.updatedAt, desde), isNotNull(articles.barcode)))
        .get();
      return Number(row?.n ?? 0);
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
