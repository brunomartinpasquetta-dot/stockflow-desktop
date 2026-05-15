import { AnalyticsService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  AnalyticsAverageTicketDTO,
  AnalyticsCustomerRankRowDTO,
  AnalyticsMarginRowDTO,
  AnalyticsPaymentMethodRankRowDTO,
  AnalyticsSalesByDayOfWeekRowDTO,
  AnalyticsSalesByHourRowDTO,
  AnalyticsSalesTrendRowDTO,
  AnalyticsStockRotationRowDTO,
  AnalyticsSupplierRankRowDTO,
  AnalyticsTopProductRowDTO,
} from '../types';

type DateRange = { from: number; to: number };

export function buildAnalyticsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'analytics:getTopSellingProducts': withSession(
      deps,
      (payload: DateRange & { limit?: number }, ctx): Promise<AnalyticsTopProductRowDTO[]> =>
        new AnalyticsService(ctx).getTopSellingProducts(payload),
    ),
    'analytics:getBottomSellingProducts': withSession(
      deps,
      (payload: DateRange & { limit?: number }, ctx): Promise<AnalyticsTopProductRowDTO[]> =>
        new AnalyticsService(ctx).getBottomSellingProducts(payload),
    ),
    'analytics:getPaymentMethodsRanking': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsPaymentMethodRankRowDTO[]> =>
        new AnalyticsService(ctx).getPaymentMethodsRanking(payload),
    ),
    'analytics:getTopCustomers': withSession(
      deps,
      (payload: DateRange & { limit?: number }, ctx): Promise<AnalyticsCustomerRankRowDTO[]> =>
        new AnalyticsService(ctx).getTopCustomers(payload),
    ),
    'analytics:getTopSuppliers': withSession(
      deps,
      (payload: DateRange & { limit?: number }, ctx): Promise<AnalyticsSupplierRankRowDTO[]> =>
        new AnalyticsService(ctx).getTopSuppliers(payload),
    ),
    'analytics:getSalesTrend': withSession(
      deps,
      (
        payload: DateRange & { granularity: 'daily' | 'weekly' | 'monthly' },
        ctx,
      ): Promise<AnalyticsSalesTrendRowDTO[]> => new AnalyticsService(ctx).getSalesTrend(payload),
    ),
    'analytics:getAverageTicket': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsAverageTicketDTO> =>
        new AnalyticsService(ctx).getAverageTicket(payload),
    ),
    'analytics:getSalesByHour': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsSalesByHourRowDTO[]> =>
        new AnalyticsService(ctx).getSalesByHour(payload),
    ),
    'analytics:getSalesByDayOfWeek': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsSalesByDayOfWeekRowDTO[]> =>
        new AnalyticsService(ctx).getSalesByDayOfWeek(payload),
    ),
    'analytics:getMarginByCategory': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsMarginRowDTO[]> =>
        new AnalyticsService(ctx).getMarginByCategory(payload),
    ),
    'analytics:getStockRotation': withSession(
      deps,
      (payload: DateRange & { limit?: number }, ctx): Promise<AnalyticsStockRotationRowDTO[]> =>
        new AnalyticsService(ctx).getStockRotation(payload),
    ),
  };
}
