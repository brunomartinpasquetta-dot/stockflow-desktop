/**
 * Handlers IPC para actualización masiva de precios (P-PRECIOS).
 *
 * Todos los canales requieren sesión activa. El servicio chequea el permiso
 * `manage_prices` (admin + manager).
 */
import {
  PriceUpdateService,
  type PriceUpdateFilter,
  type PriceUpdateRule,
} from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  PriceUpdateApplyResultDTO,
  PriceUpdateBatchDTO,
  PriceUpdateBatchDetailDTO,
  PriceUpdateEntryWithBatchDTO,
  PriceUpdateFilterDTO,
  PriceUpdatePreviewResultDTO,
  PriceUpdateRuleDTO,
} from '../types';

function service(ctx: Parameters<Parameters<typeof withSession>[1]>[1]): PriceUpdateService {
  return new PriceUpdateService(ctx);
}

export function buildPriceUpdateHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'priceUpdate:preview': withSession(
      deps,
      (
        payload: { filter: PriceUpdateFilterDTO; rule: PriceUpdateRuleDTO },
        ctx,
      ): Promise<PriceUpdatePreviewResultDTO> =>
        service(ctx).previewUpdate({
          filter: payload.filter as PriceUpdateFilter,
          rule: payload.rule as PriceUpdateRule,
        }),
    ),
    'priceUpdate:apply': withSession(
      deps,
      (
        payload: {
          filter: PriceUpdateFilterDTO;
          rule: PriceUpdateRuleDTO;
          description: string;
        },
        ctx,
      ): Promise<PriceUpdateApplyResultDTO> =>
        service(ctx).applyUpdate({
          filter: payload.filter as PriceUpdateFilter,
          rule: payload.rule as PriceUpdateRule,
          description: payload.description,
        }),
    ),
    'priceUpdate:listBatches': withSession(
      deps,
      (payload: { from?: number; to?: number }, ctx): Promise<PriceUpdateBatchDTO[]> =>
        service(ctx).listBatches(payload ?? {}),
    ),
    'priceUpdate:getBatchDetail': withSession(
      deps,
      async (
        payload: { batchId: string },
        ctx,
      ): Promise<PriceUpdateBatchDetailDTO> => {
        const detail = await service(ctx).getBatchDetail(payload.batchId);
        return {
          batch: detail.batch,
          entries: detail.entries.map((e) => ({
            id: e.id,
            batchId: e.batchId,
            articleId: e.articleId,
            field: e.field as PriceUpdateBatchDetailDTO['entries'][number]['field'],
            oldValue: e.oldValue,
            newValue: e.newValue,
            createdAt: e.createdAt,
          })),
        };
      },
    ),
    'priceUpdate:rollback': withSession(
      deps,
      (payload: { batchId: string }, ctx): Promise<{ entriesReverted: number }> =>
        service(ctx).rollbackBatch(payload.batchId),
    ),
    'priceUpdate:getArticleHistory': withSession(
      deps,
      (
        payload: { articleId: string; limit?: number },
        ctx,
      ): Promise<PriceUpdateEntryWithBatchDTO[]> =>
        service(ctx).getArticleHistory(payload.articleId, payload.limit ?? 10) as Promise<
          PriceUpdateEntryWithBatchDTO[]
        >,
    ),
  };
}
