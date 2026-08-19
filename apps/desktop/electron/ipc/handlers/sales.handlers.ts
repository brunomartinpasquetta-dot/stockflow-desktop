import { hasPermission, requirePermission, SalesService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CreateSaleInputDTO,
  CreateSaleResultDTO,
  SaleDTO,
  SaleLineDTO,
  SalePaymentDTO,
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
    // Anulación en lote de un rango (la pantalla la usa para "las ventas de
    // hoy"). Devuelve el detalle de lo que quedó afuera en vez de fallar: ver
    // `voidSalesInRange`.
    'sales:voidRange': withSession(
      deps,
      (
        payload: { from: number; to: number },
        ctx,
      ): Promise<{ anuladas: number; conCAE: number; omitidas: { number: number; motivo: string }[] }> =>
        new SalesService(ctx).voidSalesInRange(payload.from, payload.to),
    ),
    'sales:get': withSession(
      deps,
      (
        payload: { id: string },
        ctx,
      ): Promise<{ sale: SaleDTO; lines: SaleLineDTO[]; payments: SalePaymentDTO[] }> =>
        new SalesService(ctx).getSale(payload.id),
    ),
    'sales:listByDateRange': withSession(
      deps,
      async (payload: { from: number; to: number }, ctx): Promise<SaleDTO[]> => {
        // El Historial de Ventas lo necesita quien VENDE (para revisar o corregir
        // lo que acaba de facturar), no solo quien ve reportes. Antes exigía
        // `view_reports` y un vendedor con reportes restringidos se quedaba sin
        // historial aunque el módulo no estuviera bloqueado. Alcanza con poder
        // vender, anular, o tener acceso a reportes.
        const rol = ctx.currentUser.role;
        const puede =
          hasPermission(rol, 'create_sale') ||
          hasPermission(rol, 'void_sale') ||
          hasPermission(rol, 'view_reports');
        // Si no puede por ninguna vía, que el error mencione el permiso natural.
        if (!puede) requirePermission(ctx.currentUser, 'view_reports');
        // Cada venta viaja con SUS FORMAS DE PAGO, para poder filtrar el
        // historial por "transferencia" o "débito". Son dos consultas para toda
        // la pantalla: una por venta serían cientos.
        const ventas = await ctx.repos.sales.findByDateRange(payload.from, payload.to);
        const pagos = await ctx.repos.salePayments.findBySaleDateRange(payload.from, payload.to);
        const nombres = await ctx.repos.paymentMethods.byId();
        const porVenta = new Map<string, { paymentMethodId: string; name: string; amount: string }[]>();
        for (const p of pagos) {
          const lista = porVenta.get(p.saleId) ?? [];
          lista.push({
            paymentMethodId: p.paymentMethodId,
            name: nombres.get(p.paymentMethodId)?.name ?? 'Medio eliminado',
            amount: p.amount,
          });
          porVenta.set(p.saleId, lista);
        }
        return ventas.map((v) => ({ ...v, payments: porVenta.get(v.id) ?? [] }));
      },
    ),
    'sales:getNextNumber': withSession(
      deps,
      async (payload: { type: VoucherType }, ctx): Promise<{ number: number }> => ({
        number: await ctx.repos.sales.getNextNumber(payload.type),
      }),
    ),
  };
}
