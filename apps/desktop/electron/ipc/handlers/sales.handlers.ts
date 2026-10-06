import { hasPermission, requirePermission, SalesService } from '@stockflow/core';

import { obtenerCatalogoSync } from '../../catalogo/CatalogoSync';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CreateSaleInputDTO,
  CreateSaleResultDTO,
  FacturasEmitidasPaginaDTO,
  FacturasEmitidasTotalesDTO,
  FiltroFacturasEmitidasDTO,
  FiscalVoucherDTO,
  ItemParaDevolucionDTO,
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
    'sales:void': withSession(deps, async (payload: { id: string; reason?: string | null }, ctx): Promise<SaleDTO> => {
      const sale = await new SalesService(ctx).voidSale(payload.id, payload.reason ?? null);
      // Si la venta venía de un pedido web, el pedido se cancela en el
      // catálogo (repone el stock allá). Best-effort: la venta ya está anulada.
      void obtenerCatalogoSync(deps.repos).cancelarPedidosDeVentasAnuladas();
      return sale;
    }),
    // Anulación en lote de un rango (la pantalla la usa para "las ventas de
    // hoy"). Devuelve el detalle de lo que quedó afuera en vez de fallar: ver
    // `voidSalesInRange`.
    'sales:voidRange': withSession(
      deps,
      async (
        payload: { from: number; to: number },
        ctx,
      ): Promise<{ anuladas: number; conCAE: number; omitidas: { number: number; motivo: string }[] }> => {
        const r = await new SalesService(ctx).voidSalesInRange(payload.from, payload.to);
        void obtenerCatalogoSync(deps.repos).cancelarPedidosDeVentasAnuladas();
        return r;
      },
    ),
    'sales:get': withSession(
      deps,
      (
        payload: { id: string },
        ctx,
      ): Promise<{ sale: SaleDTO; lines: SaleLineDTO[]; payments: SalePaymentDTO[] }> =>
        new SalesService(ctx).getSale(payload.id),
    ),
    /**
     * "Facturas emitidas" (Contabilidad) abre con TODAS (pedido de Bruno,
     * 4-oct-2026: a principio de mes la lista arrancaba casi vacía). Con bases
     * grandes no se puede traer todo: va por páginas de la más nueva a la más
     * vieja, con los filtros en la consulta, y los totales aparte.
     */
    'sales:facturasEmitidasPagina': withSession(
      deps,
      async (
        payload: FiltroFacturasEmitidasDTO & { antesDe?: { date: number; id: string } | null; limite?: number },
        ctx,
      ): Promise<FacturasEmitidasPaginaDTO> => {
        requirePermission(ctx.currentUser, 'view_accounting');
        const { ventas, hayMas } = await ctx.repos.sales.paginaFacturasEmitidas(payload ?? {});
        const vouchers = ctx.repos.fiscal.facturasDeVentas(ventas.map((v) => v.id));
        return { ventas: ventas as unknown as SaleDTO[], vouchers: vouchers as unknown as FiscalVoucherDTO[], hayMas };
      },
    ),
    /**
     * Selector de Devolución POR ARTÍCULO (pedido de Bruno, 6-oct-2026): lo que
     * se devuelve es un artículo, no una venta. Mismo permiso que el Historial
     * de Ventas: alcanza con poder vender, anular o ver reportes. No lleva costos.
     */
    'sales:itemsParaDevolucion': withSession(
      deps,
      async (
        payload: { desde: number; hasta: number; texto?: string; limite?: number },
        ctx,
      ): Promise<ItemParaDevolucionDTO[]> => {
        const rol = ctx.currentUser.role;
        const puede =
          hasPermission(rol, 'create_sale') || hasPermission(rol, 'void_sale') || hasPermission(rol, 'view_reports');
        if (!puede) requirePermission(ctx.currentUser, 'view_reports');
        return (await ctx.repos.sales.itemsParaDevolucion(payload)) as ItemParaDevolucionDTO[];
      },
    ),
    'sales:facturasEmitidasTotales': withSession(
      deps,
      async (payload: FiltroFacturasEmitidasDTO, ctx): Promise<FacturasEmitidasTotalesDTO> => {
        requirePermission(ctx.currentUser, 'view_accounting');
        const f = payload ?? {};
        const t = await ctx.repos.sales.totalesFacturasEmitidas(f);
        // Las notas suman con su signo (la de crédito resta), igual que la pantalla.
        // El filtro de tipo X no tiene notas (son siempre A/B/C).
        const notas =
          f.type === 'X'
            ? []
            : ctx.repos.fiscal.notasEmitidas({
                from: f.from,
                to: f.to,
                customerId: f.customerId,
                letter: f.type ?? null,
              });
        let total = t.total;
        let vat = t.vat;
        for (const n of notas) {
          const signo = n.kind === 'credit_note' ? -1 : 1;
          total += signo * Number(n.total);
          vat += signo * Number(n.vatAmount);
        }
        return {
          cantidad: t.cantidad + notas.length,
          anuladas: t.anuladas,
          net: (total - vat).toFixed(4),
          vat: vat.toFixed(4),
          total: total.toFixed(4),
          clientes: t.clientes,
          notas: notas as unknown as FiscalVoucherDTO[],
        };
      },
    ),
    'sales:listByDateRange': withSession(
      deps,
      async (payload: { from: number; to: number; porCaja?: boolean }, ctx): Promise<SaleDTO[]> => {
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
        // "Contar por día de caja" (opción de la pantalla, apagada por defecto):
        // lo vendido después de medianoche con la caja anterior abierta va a
        // ese día. Ventas y pagos con el MISMO criterio, o no casan.
        const porCaja = payload.porCaja === true;
        const ventas = porCaja
          ? await ctx.repos.sales.findByJornadaRange(payload.from, payload.to)
          : await ctx.repos.sales.findByDateRange(payload.from, payload.to);
        const pagos = await ctx.repos.salePayments.findBySaleDateRange(payload.from, payload.to, porCaja);
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
