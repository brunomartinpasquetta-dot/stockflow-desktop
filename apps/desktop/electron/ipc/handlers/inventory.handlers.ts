import { InventoryService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { LowStockEntryDTO, StockAdjustmentDTO, StockCheckDTO } from '../types';

export function buildInventoryHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'inventory:checkStock': withSession(
      deps,
      (payload: { articleId: string; quantity: string }, ctx): Promise<StockCheckDTO> =>
        new InventoryService(ctx).checkStock(payload.articleId, payload.quantity),
    ),
    'inventory:adjustStock': withSession(
      deps,
      (
        payload: { articleId: string; newStock: string; reason: string },
        ctx,
      ): Promise<StockAdjustmentDTO> =>
        new InventoryService(ctx).adjustStock(payload.articleId, payload.newStock, payload.reason),
    ),
    'inventory:getLowStockReport': withSession(
      deps,
      (_payload, ctx): Promise<LowStockEntryDTO[]> => new InventoryService(ctx).getLowStockReport(),
    ),
  };
}
