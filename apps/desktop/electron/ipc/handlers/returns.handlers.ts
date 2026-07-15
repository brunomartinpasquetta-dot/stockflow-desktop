/**
 * Handlers IPC de DEVOLUCIONES (ventas y compras).
 */
import { ReturnsService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  PurchaseReturnDraftDTO,
  PurchaseReturnResultDTO,
  SaleReturnDraftDTO,
  SaleReturnResultDTO,
} from '../types';

export function buildReturnsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'returns:createForSale': withSession(
      deps,
      (payload: SaleReturnDraftDTO, ctx): Promise<SaleReturnResultDTO> =>
        new ReturnsService(ctx).createSaleReturn(payload),
    ),
    'returns:listBySale': withSession(
      deps,
      (payload: { saleId: string }, ctx): Promise<SaleReturnResultDTO[]> =>
        new ReturnsService(ctx).listBySale(payload.saleId),
    ),
    'returns:createForPurchase': withSession(
      deps,
      (payload: PurchaseReturnDraftDTO, ctx): Promise<PurchaseReturnResultDTO> =>
        new ReturnsService(ctx).createPurchaseReturn(payload),
    ),
    'returns:listByPurchase': withSession(
      deps,
      (payload: { purchaseId: string }, ctx): Promise<PurchaseReturnResultDTO[]> =>
        new ReturnsService(ctx).listByPurchase(payload.purchaseId),
    ),
  };
}
