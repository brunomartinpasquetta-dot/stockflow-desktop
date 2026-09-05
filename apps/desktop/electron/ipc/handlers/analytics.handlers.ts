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
  AnalyticsVentaPorFormaPagoRowDTO,
  AnalyticsVentaPorFormaPagoEnTiempoRowDTO,
  AnalyticsResumenDelDiaDTO,
  AnalyticsAvanceDelMesDTO,
  AnalyticsResultadoNetoDTO,
  AnalyticsAntiguedadDeudaDTO,
  AnalyticsConversionPresupuestosDTO,
  AnalyticsStockSinMovimientoDTO,
  AnalyticsReposicionPrioritariaRowDTO,
  AnalyticsVentasDeArticuloDTO,
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
    'analytics:ventasPorFormaPago': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsVentaPorFormaPagoRowDTO[]> =>
        new AnalyticsService(ctx).getVentasPorFormaPago(payload),
    ),
    'analytics:ventasPorFormaPagoEnTiempo': withSession(
      deps,
      (
        payload: DateRange & { granularity: 'daily' | 'weekly' | 'monthly' },
        ctx,
      ): Promise<AnalyticsVentaPorFormaPagoEnTiempoRowDTO[]> =>
        new AnalyticsService(ctx).getVentasPorFormaPagoEnTiempo(payload),
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
    'analytics:resumenDelDia': withSession(
      deps,
      (payload: { hoy: DateRange; ayer: DateRange; mismoDiaSemanaAnterior: DateRange }, ctx): Promise<AnalyticsResumenDelDiaDTO> =>
        new AnalyticsService(ctx).getResumenDelDia(payload),
    ),
    'analytics:avanceDelMes': withSession(
      deps,
      (
        payload: { mesActual: DateRange; mesAnteriorParcial: DateRange; mesAnteriorCompleto: DateRange; diasTranscurridos: number; diasDelMes: number },
        ctx,
      ): Promise<AnalyticsAvanceDelMesDTO> => new AnalyticsService(ctx).getAvanceDelMes(payload),
    ),
    'analytics:resultadoNeto': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsResultadoNetoDTO> => new AnalyticsService(ctx).getResultadoNeto(payload),
    ),
    'analytics:antiguedadDeuda': withSession(
      deps,
      (_payload, ctx): Promise<AnalyticsAntiguedadDeudaDTO> => new AnalyticsService(ctx).getAntiguedadDeuda(),
    ),
    'analytics:conversionPresupuestos': withSession(
      deps,
      (payload: DateRange, ctx): Promise<AnalyticsConversionPresupuestosDTO> =>
        new AnalyticsService(ctx).getConversionPresupuestos(payload),
    ),
    'analytics:stockSinMovimiento': withSession(
      deps,
      (payload: { dias?: number; limit?: number }, ctx): Promise<AnalyticsStockSinMovimientoDTO> =>
        new AnalyticsService(ctx).getStockSinMovimiento(payload),
    ),
    'analytics:reposicionPrioritaria': withSession(
      deps,
      (payload: DateRange & { limit?: number }, ctx): Promise<AnalyticsReposicionPrioritariaRowDTO[]> =>
        new AnalyticsService(ctx).getReposicionPrioritaria(payload),
    ),
    'analytics:ventasDeArticulo': withSession(
      deps,
      (payload: DateRange & { articleId: string }, ctx): Promise<AnalyticsVentasDeArticuloDTO> =>
        new AnalyticsService(ctx).getVentasDeArticulo(payload),
    ),
  };
}
