import { PurchasesService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CreatePurchaseInputDTO,
  CreatePurchaseResultDTO,
  PurchaseDTO,
  PurchaseLineDTO,
} from '../types';

export function buildPurchasesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'purchases:create': withSession(
      deps,
      (payload: CreatePurchaseInputDTO, ctx): Promise<CreatePurchaseResultDTO> =>
        new PurchasesService(ctx).createPurchase(payload),
    ),
    'purchases:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<{ purchase: PurchaseDTO; lines: PurchaseLineDTO[] }> =>
        new PurchasesService(ctx).getPurchase(payload.id),
    ),
    'purchases:listByDateRange': withSession(
      deps,
      (payload: { from: number; to: number }, ctx): Promise<PurchaseDTO[]> =>
        ctx.repos.purchases.findByDateRange(payload.from, payload.to),
    ),
  };
}
