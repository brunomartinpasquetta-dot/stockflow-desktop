import { ReportsService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CashReportDTO,
  FamilyInventoryRowDTO,
  PurchasesReportDTO,
  SalesReportDTO,
  SellerReportRowDTO,
  TopArticleRowDTO,
} from '../types';

export function buildReportsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'reports:salesByDateRange': withSession(
      deps,
      (
        payload: { from: number; to: number; sellerId?: string; customerId?: string },
        ctx,
      ): Promise<SalesReportDTO> =>
        new ReportsService(ctx).salesByDateRange(payload.from, payload.to, {
          sellerId: payload.sellerId,
          customerId: payload.customerId,
        }),
    ),
    'reports:purchasesByDateRange': withSession(
      deps,
      (payload: { from: number; to: number; supplierId?: string }, ctx): Promise<PurchasesReportDTO> =>
        new ReportsService(ctx).purchasesByDateRange(payload.from, payload.to, {
          supplierId: payload.supplierId,
        }),
    ),
    'reports:salesBySeller': withSession(
      deps,
      (payload: { from: number; to: number }, ctx): Promise<SellerReportRowDTO[]> =>
        new ReportsService(ctx).salesBySeller(payload.from, payload.to),
    ),
    'reports:inventoryByFamily': withSession(
      deps,
      (_payload, ctx): Promise<FamilyInventoryRowDTO[]> => new ReportsService(ctx).inventoryByFamily(),
    ),
    'reports:topArticles': withSession(
      deps,
      (payload: { from: number; to: number; limit?: number }, ctx): Promise<TopArticleRowDTO[]> =>
        new ReportsService(ctx).topArticles(payload.from, payload.to, payload.limit),
    ),
    'reports:cashRegisterReport': withSession(
      deps,
      (payload: { registerId: string }, ctx): Promise<CashReportDTO> =>
        new ReportsService(ctx).cashRegisterReport(payload.registerId),
    ),
  };
}
