import { AccountingService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  FinancialSummaryDTO,
  VatBookSaleRowDTO,
  VatBookPurchaseRowDTO,
} from '../types';

export function buildAccountingHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'accounting:getSummary': withSession(
      deps,
      (payload: { from: number; to: number }, ctx): Promise<FinancialSummaryDTO> =>
        new AccountingService(ctx).getFinancialSummary(payload),
    ),
    'accounting:getVatBookSales': withSession(
      deps,
      (
        payload: { from: number; to: number; type?: 'A' | 'B' | 'C' | 'X' | 'all' },
        ctx,
      ): Promise<VatBookSaleRowDTO[]> => new AccountingService(ctx).getVatBookSales(payload),
    ),
    'accounting:getVatBookPurchases': withSession(
      deps,
      (payload: { from: number; to: number }, ctx): Promise<VatBookPurchaseRowDTO[]> =>
        new AccountingService(ctx).getVatBookPurchases(payload),
    ),
  };
}
