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
      (payload: { from: number; to: number }, ctx): Promise<SaleDTO[]> => {
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
        return ctx.repos.sales.findByDateRange(payload.from, payload.to);
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
