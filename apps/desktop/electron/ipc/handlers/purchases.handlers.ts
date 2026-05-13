import { PurchasesService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CreatePurchaseInputDTO,
  CreatePurchaseResultDTO,
  PurchaseDTO,
  PurchaseLineDTO,
  VoucherType,
} from '../types';

export function buildPurchasesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'purchases:create': withSession(
      deps,
      (payload: CreatePurchaseInputDTO, ctx): Promise<CreatePurchaseResultDTO> =>
        new PurchasesService(ctx).createPurchase(payload),
    ),
    'purchases:void': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<PurchaseDTO> => new PurchasesService(ctx).voidPurchase(payload.id),
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
    'purchases:getNextNumber': withSession(
      deps,
      async (payload: { type: VoucherType }, ctx): Promise<{ number: number }> => ({
        number: await new PurchasesService(ctx).getNextNumber(payload.type),
      }),
    ),
  };
}
