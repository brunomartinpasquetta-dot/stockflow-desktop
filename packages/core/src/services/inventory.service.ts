/**
 * Servicio de inventario: consulta de stock, ajustes manuales y reportes.
 */
import type { Article } from '@stockflow/shared';
import { cmpDecimal, decimalString, gteDecimal, subDecimal } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { NotFoundError } from '../errors';

export interface StockCheck {
  articleId: string;
  available: boolean;
  current: string;
  requested: string;
}

export interface StockAdjustment {
  article: Article;
  previousStock: string;
  newStock: string;
  /** newStock − previousStock (positivo = ingreso, negativo = baja) */
  delta: string;
  reason: string;
  by: string;
}

export interface LowStockEntry {
  article: Article;
  current: string;
  min: string;
  ideal: string;
  /** cantidad sugerida a reponer = max(0, ideal − stock) */
  suggestedOrder: string;
}

export class InventoryService {
  constructor(private readonly ctx: ServiceContext) {}

  /** ¿Hay stock suficiente del artículo para `qty` unidades? */
  async checkStock(articleId: string, qty: string): Promise<StockCheck> {
    const article = await this.ctx.repos.articles.findById(articleId);
    if (!article) throw new NotFoundError('Artículo', articleId);
    return {
      articleId,
      available: gteDecimal(article.stock, qty),
      current: article.stock,
      requested: qty,
    };
  }

  /**
   * Ajusta el stock de un artículo a un valor absoluto (sólo admin). Deja un
   * registro de auditoría en `article.notes`.
   */
  async adjustStock(articleId: string, newStock: string, reason: string): Promise<StockAdjustment> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'adjust_stock');

    const article = await repos.articles.findById(articleId);
    if (!article) throw new NotFoundError('Artículo', articleId);

    const previousStock = article.stock;
    const target = decimalString(newStock, 3);
    const delta = subDecimal(target, previousStock, 3);
    const stamp = new Date().toISOString();
    const auditLine = `[${stamp}] ajuste stock ${previousStock}→${target} (${currentUser.username}): ${reason.trim()}`;
    const notes = article.notes ? `${article.notes}\n${auditLine}` : auditLine;

    const updated = await repos.articles.update(articleId, { stock: target, notes });
    return { article: updated, previousStock, newStock: target, delta, reason, by: currentUser.username };
  }

  /** Artículos con stock por debajo del mínimo, con cantidad sugerida de reposición. */
  async getLowStockReport(): Promise<LowStockEntry[]> {
    const articles = await this.ctx.repos.articles.findLowStock();
    return articles.map((article) => {
      const rawSuggested = subDecimal(article.idealStock, article.stock, 3);
      const suggestedOrder = cmpDecimal(rawSuggested, '0') > 0 ? rawSuggested : '0.000';
      return {
        article,
        current: article.stock,
        min: article.minStock,
        ideal: article.idealStock,
        suggestedOrder,
      };
    });
  }
}
