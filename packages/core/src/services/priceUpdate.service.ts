/**
 * Servicio de actualización masiva de precios (P-PRECIOS).
 *
 * Flujo:
 *   1) `previewUpdate(filter, rule)` — pura, no escribe en DB. Filtra los artículos
 *      candidatos y calcula `oldValue → newValue` por cada (artículo × campo).
 *   2) `applyUpdate({filter, rule, description})` — abre transacción, escribe los
 *      nuevos precios en `articles` y persiste el lote (`price_update_batches`) +
 *      las entradas (`price_update_entries`) para auditoría y rollback.
 *   3) `rollbackBatch(batchId)` — vuelve cada artículo afectado a su `oldValue`
 *      y marca el lote como `rolledBackAt`. No se puede revertir dos veces.
 *
 * Sólo accesible a roles con `manage_prices` (admin + manager).
 */
import type { Article, PriceUpdateEntry } from '@stockflow/db';
import type {
  PriceUpdateBatchWithUser,
  PriceUpdateEntryWithBatch,
} from '@stockflow/db';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError } from '../errors';

export type PriceField =
  | 'costPrice'
  | 'listPrice1'
  | 'listPrice2'
  | 'listPrice3'
  | 'wholesalePrice';

export const PRICE_FIELDS: readonly PriceField[] = [
  'costPrice',
  'listPrice1',
  'listPrice2',
  'listPrice3',
  'wholesalePrice',
];

export interface PriceUpdateFilter {
  scope: 'all' | 'family' | 'supplier' | 'manual';
  familyId?: string;
  supplierId?: string;
  articleIds?: string[];
  minPrice?: string;
  maxPrice?: string;
  hasStock?: boolean;
  onlyActive?: boolean;
}

export type PriceUpdateRuleType =
  | 'percentage'
  | 'fixed_amount'
  | 'set_value'
  | 'recalculate_from_cost';

export type PriceUpdateRounding =
  | 'none'
  | 'up_to_10'
  | 'up_to_50'
  | 'up_to_100'
  | 'nearest_99';

export interface PriceUpdateRule {
  type: PriceUpdateRuleType;
  value: string;
  direction?: 'increase' | 'decrease';
  fields: PriceField[];
  keepUtility?: boolean;
  rounding?: PriceUpdateRounding;
}

export interface PreviewEntry {
  articleId: string;
  code: string;
  description: string;
  field: PriceField;
  oldValue: string;
  newValue: string;
}

export interface PreviewResult {
  entries: PreviewEntry[];
  articlesAffected: number;
  averageDeltaPct: number;
}

export interface ApplyUpdateInput {
  filter: PriceUpdateFilter;
  rule: PriceUpdateRule;
  description: string;
}

export interface ApplyUpdateResult {
  batchId: string;
  articlesAffected: number;
  entries: number;
}

export interface RollbackResult {
  entriesReverted: number;
}

export interface BatchDetail {
  batch: PriceUpdateBatchWithUser;
  entries: PriceUpdateEntry[];
}

const MAX_PREVIEW_ENTRIES = 5000;

/* ------------------------------------------------------------------ */
/* Helpers puros (testables sin DB)                                    */
/* ------------------------------------------------------------------ */

export function applyRounding(v: number, mode?: PriceUpdateRounding): number {
  switch (mode) {
    case 'up_to_10':
      return Math.ceil(v / 10) * 10;
    case 'up_to_50':
      return Math.ceil(v / 50) * 50;
    case 'up_to_100':
      return Math.ceil(v / 100) * 100;
    case 'nearest_99':
      if (v <= 99) return 99;
      return Math.ceil(v / 100) * 100 - 1;
    case 'none':
    case undefined:
    default:
      return v;
  }
}

export function computeNewValue(
  oldValueStr: string,
  rule: PriceUpdateRule,
  originalCostStr: string,
  newCostStr: string | null,
): string {
  const old = Number(oldValueStr);
  let next: number;
  switch (rule.type) {
    case 'percentage': {
      const pct = Number(rule.value);
      next = rule.direction === 'decrease' ? old * (1 - pct / 100) : old * (1 + pct / 100);
      break;
    }
    case 'fixed_amount': {
      const v = Number(rule.value);
      next = rule.direction === 'decrease' ? old - v : old + v;
      break;
    }
    case 'set_value':
      next = Number(rule.value);
      break;
    case 'recalculate_from_cost': {
      const origCost = Number(originalCostStr);
      const newCost = Number(newCostStr ?? originalCostStr);
      if (origCost <= 0) {
        next = old;
        break;
      }
      const utility = (old - origCost) / origCost;
      next = newCost * (1 + utility);
      break;
    }
    default:
      next = old;
  }
  next = Math.max(0, next);
  return applyRounding(next, rule.rounding).toFixed(4);
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class PriceUpdateService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Lista artículos que matchean el filtro. */
  private async filterArticles(filter: PriceUpdateFilter): Promise<Article[]> {
    const { repos } = this.ctx;
    const all = await repos.articles.findAll();
    const onlyActive = filter.onlyActive !== false; // default: true
    const idsSet = new Set(filter.articleIds ?? []);
    return all.filter((a) => {
      if (onlyActive && !a.active) return false;
      if (filter.scope === 'family') {
        if (!filter.familyId || a.familyId !== filter.familyId) return false;
      } else if (filter.scope === 'supplier') {
        if (!filter.supplierId || a.supplierId !== filter.supplierId) return false;
      } else if (filter.scope === 'manual') {
        if (idsSet.size === 0 || !idsSet.has(a.id)) return false;
      }
      if (filter.hasStock && Number(a.stock) <= 0) return false;
      if (filter.minPrice && Number(a.listPrice1) < Number(filter.minPrice)) return false;
      if (filter.maxPrice && Number(a.listPrice1) > Number(filter.maxPrice)) return false;
      return true;
    });
  }

  /**
   * Calcula los nuevos valores por artículo+campo según la regla.
   * Si `keepUtility=true` y costPrice está entre los fields, los demás campos
   * de lista/mayor se recalculan manteniendo la utilidad original respecto al
   * costo original.
   */
  private computeArticleEntries(
    article: Article,
    rule: PriceUpdateRule,
  ): Array<{ field: PriceField; oldValue: string; newValue: string }> {
    const out: Array<{ field: PriceField; oldValue: string; newValue: string }> = [];

    const fieldsSet = new Set(rule.fields);
    const includesCost = fieldsSet.has('costPrice');
    const hasOtherLists = rule.fields.some((f) => f !== 'costPrice');
    const useKeepUtility = !!rule.keepUtility && includesCost && hasOtherLists;

    // Costo nuevo (si se cambia) — usado para recalcular utilidades.
    const oldCost = article.costPrice;
    let newCost: string | null = null;
    if (includesCost) {
      newCost = computeNewValue(oldCost, rule, oldCost, null);
    }

    for (const field of rule.fields) {
      const oldValue = article[field];
      let newValue: string;
      if (field === 'costPrice') {
        newValue = newCost ?? oldValue;
      } else if (useKeepUtility) {
        // Mantener utilidad: recalcular usando cost old → cost new.
        newValue = computeNewValue(
          oldValue,
          { ...rule, type: 'recalculate_from_cost', rounding: rule.rounding },
          oldCost,
          newCost,
        );
      } else {
        newValue = computeNewValue(oldValue, rule, oldCost, newCost);
      }
      if (oldValue !== newValue) {
        out.push({ field, oldValue, newValue });
      }
    }
    return out;
  }

  async previewUpdate(
    input: { filter: PriceUpdateFilter; rule: PriceUpdateRule },
    _ctxParam?: ServiceContext,
  ): Promise<PreviewResult> {
    requirePermission(this.ctx.currentUser, 'manage_prices');
    if (input.rule.fields.length === 0) {
      return { entries: [], articlesAffected: 0, averageDeltaPct: 0 };
    }
    const articles = await this.filterArticles(input.filter);
    const entries: PreviewEntry[] = [];
    const affected = new Set<string>();
    const deltaPcts: number[] = [];

    for (const article of articles) {
      const articleEntries = this.computeArticleEntries(article, input.rule);
      if (articleEntries.length === 0) continue;
      affected.add(article.id);
      for (const e of articleEntries) {
        if (entries.length >= MAX_PREVIEW_ENTRIES) {
          throw new BusinessRuleError(
            'PREVIEW_TOO_LARGE',
            `La previsualización excede ${MAX_PREVIEW_ENTRIES} cambios. Acotá los filtros.`,
          );
        }
        entries.push({
          articleId: article.id,
          code: article.barcode,
          description: article.description,
          field: e.field,
          oldValue: e.oldValue,
          newValue: e.newValue,
        });
        const oldNum = Number(e.oldValue);
        if (oldNum > 0) {
          deltaPcts.push(((Number(e.newValue) - oldNum) / oldNum) * 100);
        }
      }
    }
    const averageDeltaPct =
      deltaPcts.length === 0
        ? 0
        : deltaPcts.reduce((a, b) => a + b, 0) / deltaPcts.length;
    return {
      entries,
      articlesAffected: affected.size,
      averageDeltaPct,
    };
  }

  async applyUpdate(input: ApplyUpdateInput): Promise<ApplyUpdateResult> {
    requirePermission(this.ctx.currentUser, 'manage_prices');
    if (!input.description.trim()) {
      throw new BusinessRuleError(
        'DESCRIPTION_REQUIRED',
        'La descripción del lote es obligatoria',
      );
    }
    if (input.rule.fields.length === 0) {
      throw new BusinessRuleError(
        'NO_FIELDS',
        'Seleccioná al menos un campo a actualizar',
      );
    }
    const articles = await this.filterArticles(input.filter);
    const flatEntries: Array<{ articleId: string; field: string; oldValue: string; newValue: string }> = [];
    const articleUpdates = new Map<string, Partial<Record<PriceField, string>>>();

    for (const article of articles) {
      const articleEntries = this.computeArticleEntries(article, input.rule);
      if (articleEntries.length === 0) continue;
      const updateFields: Partial<Record<PriceField, string>> = {};
      for (const e of articleEntries) {
        updateFields[e.field] = e.newValue;
        flatEntries.push({
          articleId: article.id,
          field: e.field,
          oldValue: e.oldValue,
          newValue: e.newValue,
        });
      }
      articleUpdates.set(article.id, updateFields);
    }

    if (articleUpdates.size === 0) {
      throw new BusinessRuleError(
        'NO_CHANGES',
        'Ningún artículo coincide con el filtro o ningún precio cambiaría',
      );
    }

    const { batchId } = await this.ctx.repos.priceUpdates.applyBatch({
      userId: this.ctx.currentUser.id,
      description: input.description.trim(),
      filterJson: JSON.stringify(input.filter),
      ruleJson: JSON.stringify(input.rule),
      articleUpdates,
      entries: flatEntries,
    });

    return {
      batchId,
      articlesAffected: articleUpdates.size,
      entries: flatEntries.length,
    };
  }

  async rollbackBatch(batchId: string): Promise<RollbackResult> {
    requirePermission(this.ctx.currentUser, 'manage_prices');
    const { repos } = this.ctx;
    const batch = await repos.priceUpdates.findById(batchId);
    if (!batch) throw new NotFoundError('Lote de actualización de precios', batchId);
    if (batch.rolledBackAt != null) {
      throw new BusinessRuleError(
        'ALREADY_ROLLED_BACK',
        'Este lote ya fue revertido anteriormente',
      );
    }
    const entries = await repos.priceUpdates.findEntriesByBatch(batchId);
    if (entries.length === 0) {
      await repos.priceUpdates.markRolledBack(batchId, Date.now());
      return { entriesReverted: 0 };
    }
    // Agrupar por artículo.
    const restoreByArticle = new Map<string, Partial<Record<string, string>>>();
    for (const e of entries) {
      const cur = restoreByArticle.get(e.articleId) ?? {};
      cur[e.field] = e.oldValue;
      restoreByArticle.set(e.articleId, cur);
    }
    await repos.priceUpdates.rollbackBatchAtomic(batchId, restoreByArticle);
    return { entriesReverted: entries.length };
  }

  async listBatches(input: {
    from?: number;
    to?: number;
  }): Promise<PriceUpdateBatchWithUser[]> {
    requirePermission(this.ctx.currentUser, 'manage_prices');
    return this.ctx.repos.priceUpdates.findBatches(input);
  }

  async getBatchDetail(batchId: string): Promise<BatchDetail> {
    requirePermission(this.ctx.currentUser, 'manage_prices');
    const batches = await this.ctx.repos.priceUpdates.findBatches();
    const batch = batches.find((b) => b.id === batchId);
    if (!batch) throw new NotFoundError('Lote de actualización de precios', batchId);
    const entries = await this.ctx.repos.priceUpdates.findEntriesByBatch(batchId);
    return { batch, entries };
  }

  async getArticleHistory(
    articleId: string,
    limit = 10,
  ): Promise<PriceUpdateEntryWithBatch[]> {
    requirePermission(this.ctx.currentUser, 'manage_prices');
    return this.ctx.repos.priceUpdates.findHistoryByArticle(articleId, limit);
  }
}

