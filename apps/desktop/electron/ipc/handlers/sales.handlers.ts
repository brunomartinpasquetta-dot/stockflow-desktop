import { SalesService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CreateSaleInputDTO,
  CreateSaleResultDTO,
  SaleDTO,
  SaleLineDTO,
  VoucherType,
} from '../types';

export function buildSalesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'sales:create': withSession(
      deps,
      (payload: CreateSaleInputDTO, ctx): Promise<CreateSaleResultDTO> =>
        new SalesService(ctx).createSale(payload),
    ),
    'sales:void': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<SaleDTO> => new SalesService(ctx).voidSale(payload.id),
    ),
    'sales:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<{ sale: SaleDTO; lines: SaleLineDTO[] }> =>
        new SalesService(ctx).getSale(payload.id),
    ),
    'sales:listByDateRange': withSession(
      deps,
      (payload: { from: number; to: number }, ctx): Promise<SaleDTO[]> =>
        ctx.repos.sales.findByDateRange(payload.from, payload.to),
    ),
    'sales:getNextNumber': withSession(
      deps,
      async (payload: { type: VoucherType }, ctx): Promise<{ number: number }> => ({
        number: await ctx.repos.sales.getNextNumber(payload.type),
      }),
    ),
  };
}
