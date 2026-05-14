import { ReportsService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CashReportDTO,
  FamilyInventoryRowDTO,
  InventoryReportDTO,
  LowStockReportRowDTO,
  PurchasesReportDTO,
  SalesByVendorReportDTO,
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
    'reports:getLowStock': withSession(
      deps,
      (
        payload: { supplierId?: string; familyId?: string; criteria?: 'min' | 'ideal' },
        ctx,
      ): Promise<LowStockReportRowDTO[]> => new ReportsService(ctx).getLowStockArticles(payload ?? {}, ctx),
    ),
    'reports:getInventory': withSession(
      deps,
      (
        payload: { supplierId?: string; familyId?: string; includeZeroStock?: boolean },
        ctx,
      ): Promise<InventoryReportDTO> => new ReportsService(ctx).getInventoryReport(payload ?? {}, ctx),
    ),
    'reports:getSalesByVendor': withSession(
      deps,
      (payload: { from: number; to: number; userId?: string }, ctx): Promise<SalesByVendorReportDTO> =>
        new ReportsService(ctx).getSalesByVendor(payload, ctx),
    ),
  };
}
