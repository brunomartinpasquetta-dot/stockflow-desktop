/**
 * CATÁLOGO WEB — estadísticas del catálogo online del comercio.
 *
 * El catálogo es un producto APARTE (en desarrollo): acá solo se consulta.
 * La integración se configura en Mi Empresa (dirección + clave); sin esos
 * datos, `integrado: false` y Estadísticas no muestra la pestaña.
 *
 * CONTRATO que el catálogo debe implementar (definido acá primero, 4-sep-2026):
 *   GET {catalogoUrl}/api/estadisticas?from=<epoch ms>&to=<epoch ms>
 *   Authorization: Bearer {catalogoToken}
 *   → 200 {
 *       visitas: number,                                  // páginas vistas del período
 *       visitantes?: number,                              // visitantes únicos (opcional)
 *       productosMasVistos:    [{ descripcion: string, vistas: number }],
 *       productosMasComprados: [{ descripcion: string, cantidad: number }],
 *       terminosMasBuscados:   [{ termino: string, veces: number }],
 *       busquedasSinResultado: [{ termino: string, veces: number }],
 *     }
 */
import { PermissionDeniedError, SalesService, ValidationError, hasPermission, requirePermission } from '@stockflow/core';
import { addDecimal, mulDecimal, proratedVatBreakdown, sumDecimals, type PriceMode } from '@stockflow/shared';

import { obtenerCatalogoSync } from '../../catalogo/CatalogoSync';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { CatalogoEstadisticasDTO } from '../types';

const TIMEOUT_MS = 8000;

/**
 * Le avisa al catálogo en qué quedó el pedido y, si acusa, borra la deuda de
 * aviso (ver `CatalogoSync.avisarResolucion`). Si no acusa, el barrido lo
 * reintenta.
 */
async function avisarCatalogo(
  deps: HandlerDeps,
  pedido: { id: string; pedidoId: string; saleId: string | null },
  estado: 'confirmado' | 'cancelado',
): Promise<void> {
  await obtenerCatalogoSync(deps.repos).avisarResolucion(pedido, estado);
}

/**
 * Total de la venta calculado EXACTAMENTE como lo calcula el repositorio
 * (`createWithLines`): línea a línea a 4 decimales y, en modo 'net', más el
 * IVA prorrateado. Antes se sumaba precio × cantidad a secas: en modo 'net'
 * el servidor sumaba el IVA y rechazaba el pago por no coincidir, y con
 * cantidades fraccionadas el redondeo tampoco cerraba (auditoría sep-2026, B2).
 */
function totalComoElServidor(
  lineas: { quantity: string; unitPrice: string; vatRate: string }[],
  priceMode: PriceMode,
): string {
  const conTotal = lineas.map((l) => ({ lineTotal: mulDecimal(l.quantity, l.unitPrice, 4), vatRate: l.vatRate }));
  const lineSum = sumDecimals(conTotal.map((l) => l.lineTotal));
  if (priceMode === 'gross') return lineSum;
  const { vatAmount } = proratedVatBreakdown(conTotal, '0', lineSum, 'net');
  return addDecimal(lineSum, vatAmount, 4);
}

/**
 * Quién puede tocar el catálogo. Encender/apagar el espejo, publicar y
 * vincular productos es configuración de la empresa (admin); convertir o
 * enlazar un pedido es vender (cajero); rechazar un pedido devuelve stock en
 * la tienda, así que pide lo mismo que anular una venta. Mirar es de todos.
 */
function exigirRechazo(user: { role: 'admin' | 'manager' | 'seller' }): void {
  if (!hasPermission(user.role, 'void_sale') && !hasPermission(user.role, 'manage_company')) {
    throw new PermissionDeniedError('void_sale', user.role);
  }
}

export function buildCatalogoHandlers(deps: HandlerDeps): HandlerMap {
  return {
    /* ------------------------- Espejo de artículos ------------------------- */

    'catalogo:syncEstado': withSession(deps, async (_payload, ctx) => {
      requirePermission(ctx.currentUser, 'view_articles');
      const e = deps.repos.catalogo.getState();
      return {
        activo: e.enabled,
        pendientes: deps.repos.catalogo.pendientes(e.cursor),
        publicadosTotal: e.pushedTotal,
        ultimaCorrida: e.lastRunAt,
        ultimoExito: e.lastOkAt,
        ultimoError: e.lastError,
        crearFaltantes: e.crearFaltantes,
      };
    }),

    'catalogo:syncActivar': withSession(deps, async (payload: { activo: boolean }, ctx) => {
      requirePermission(ctx.currentUser, 'manage_company');
      deps.repos.catalogo.saveState({ enabled: Boolean(payload?.activo) });
      return { ok: true as const };
    }),

    'catalogo:syncConfigurar': withSession(deps, async (payload: { crearFaltantes: boolean }, ctx) => {
      requirePermission(ctx.currentUser, 'manage_company');
      deps.repos.catalogo.saveState({ crearFaltantes: Boolean(payload?.crearFaltantes) });
      return { ok: true as const };
    }),

    'catalogo:syncAhora': withSession(deps, async (payload: { todo?: boolean }, ctx) => {
      requirePermission(ctx.currentUser, 'manage_company');
      const sync = obtenerCatalogoSync(deps.repos);
      const p = await sync.traerPedidos();
      // Sin la bajada de pedidos no se publica: se le devolvería a la tienda
      // el stock que sus pedidos todavía no bajados acaban de reservar.
      if (!p.ok) {
        return { ok: false, publicados: 0, pendientes: 0, motivo: `no se pudieron bajar los pedidos (${p.motivo ?? 'sin motivo'})` };
      }
      await sync.reintentarAvisosPendientes();
      return payload?.todo ? sync.republicarTodo() : sync.correr();
    }),

    /* --------------------------- Vinculación -------------------------- */

    /**
     * Propuesta de apareo: productos del catálogo sin `codigo_sistema`,
     * cruzados por nombre contra los artículos activos. Solo lectura — no
     * escribe nada hasta que se confirme con `catalogo:vincularLote`.
     */
    'catalogo:sugerirVinculacion': withSession(deps, async (_payload, ctx) => {
      requirePermission(ctx.currentUser, 'manage_company');
      const sync = obtenerCatalogoSync(deps.repos);
      return sync.sugerirVinculacion();
    }),

    'catalogo:vincularLote': withSession(
      deps,
      async (payload: { vinculos: { sku: string; codigoSistema: string }[] }, ctx) => {
        requirePermission(ctx.currentUser, 'manage_company');
        const sync = obtenerCatalogoSync(deps.repos);
        return sync.vincularLote(payload.vinculos);
      },
    ),

    /* ---------------------------- Pedidos web ---------------------------- */

    /** Liviano: solo el número, para pintar el aviso en el menú sin resolver líneas. */
    'catalogo:pedidosContarPendientes': withSession(deps, async (_payload, ctx) => {
      requirePermission(ctx.currentUser, 'view_articles');
      return { pendientes: deps.repos.catalogoPedidos.contarPendientes() };
    }),

    'catalogo:pedidosListar': withSession(deps, async (payload: { estado?: 'pendiente' | 'convertido' | 'rechazado' }, ctx) => {
      requirePermission(ctx.currentUser, 'view_articles');
      // Si alguna venta de pedido se anuló y el aviso al catálogo quedó
      // pendiente (estaba caído), se reintenta acá. Sin esperar: la pantalla
      // no depende del catálogo, y "venta anulada" lo lee de la venta.
      const sync = obtenerCatalogoSync(deps.repos);
      void sync.cancelarPedidosDeVentasAnuladas().then(() => sync.reintentarAvisosPendientes());
      const filas = deps.repos.catalogoPedidos.listar(payload?.estado);
      const ventas = deps.repos.catalogoPedidos.estadoDeVentas(
        filas.map((p) => p.saleId).filter((id): id is string => id != null),
      );
      // Cada línea se resuelve contra el catálogo de artículos: la que no tiene
      // código, o cuyo código no existe en el sistema, se marca para que la
      // pantalla la muestre como suelta y no se pueda confundir con un artículo.
      const resueltos = await Promise.all(
        filas.map(async (p) => {
          const items = JSON.parse(p.items) as {
            sku: string; codigo_sistema: string; nombre: string; cant: number; precio: number; subtotal: number; servicio: boolean;
          }[];
          const lineas = await Promise.all(
            items.map(async (i) => {
              const art = i.codigo_sistema
                ? await deps.repos.articles.findByBarcode(i.codigo_sistema)
                : null;
              return {
                nombre: i.nombre,
                cantidad: i.cant,
                precio: i.precio,
                subtotal: i.subtotal,
                articleId: art?.id ?? null,
                codigoSistema: i.codigo_sistema || null,
                nombreSistema: art?.description ?? null,
                stockActual: art ? Number(art.stock) : null,
                sinPrecio: !i.precio || i.precio <= 0,
              };
            }),
          );
          return {
            id: p.id,
            numero: p.numero,
            fecha: p.fecha,
            clienteNombre: p.clienteNombre,
            clienteTelefono: p.clienteTelefono,
            clienteEmail: p.clienteEmail,
            entrega: p.entrega,
            direccion: p.direccion,
            notas: p.notas,
            total: p.total,
            pagado: p.pagado,
            estado: p.estado,
            saleId: p.saleId,
            ventaAnulada: p.saleId != null && ventas.get(p.saleId) === 'voided',
            lineas,
          };
        }),
      );
      return resueltos;
    }),

    'catalogo:pedidoRechazar': withSession(deps, async (payload: { id: string }, ctx) => {
      exigirRechazo(ctx.currentUser);
      const pedido = deps.repos.catalogoPedidos.buscar(payload.id);
      if (!pedido) throw new ValidationError('id', 'El pedido no existe');
      if (pedido.estado !== 'pendiente') {
        throw new ValidationError('id', 'Ese pedido ya fue procesado');
      }
      // Compare-and-set: si otra terminal lo resolvió en el medio, no se pisa.
      if (!deps.repos.catalogoPedidos.marcar(payload.id, 'rechazado')) {
        throw new ValidationError('id', 'Ese pedido ya fue procesado');
      }
      // Avisarle al catálogo para que devuelva el stock reservado.
      void avisarCatalogo(deps, { id: pedido.id, pedidoId: pedido.pedidoId, saleId: null }, 'cancelado');
      return { ok: true as const };
    }),

    /**
     * Convierte el pedido en una VENTA real: descuenta stock, entra a la caja
     * con la forma de pago elegida y queda en el historial como cualquier otra.
     */
    'catalogo:pedidoConvertir': withSession(
      deps,
      async (
        payload: { id: string; paymentMethodId: string; customerId?: string; type?: 'X' | 'A' | 'B' | 'C' },
        ctx,
      ) => {
        requirePermission(ctx.currentUser, 'create_sale');
        const pedido = deps.repos.catalogoPedidos.buscar(payload.id);
        if (!pedido) throw new ValidationError('id', 'El pedido no existe');
        if (pedido.estado !== 'pendiente') {
          throw new ValidationError('id', 'Ese pedido ya fue procesado');
        }
        const items = JSON.parse(pedido.items) as {
          codigo_sistema: string; nombre: string; cant: number; precio: number;
        }[];
        if (items.length === 0) throw new ValidationError('items', 'El pedido no tiene líneas');
        // Una línea sin precio no puede convertirse en venta: entraría en $0 y
        // descuadraría la caja. El comerciante la cotiza en el catálogo primero.
        const sinPrecio = items.filter((i) => !i.precio || i.precio <= 0);
        if (sinPrecio.length > 0) {
          throw new ValidationError(
            'items',
            `Hay ${sinPrecio.length} artículo(s) sin precio ("${sinPrecio[0]!.nombre}"). Cargue el precio en el catálogo antes de convertir el pedido.`,
          );
        }

        const malFormado = items.find((i) => !Number.isFinite(Number(i.cant)) || Number(i.cant) <= 0 || !Number.isFinite(Number(i.precio)));
        if (malFormado) {
          throw new ValidationError('items', `La línea "${malFormado.nombre}" tiene cantidad o precio inválidos.`);
        }

        const cf = await deps.repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
        const customerId = payload.customerId ?? cf?.id;
        if (!customerId) throw new ValidationError('customerId', 'Falta el cliente');

        const empresa = await deps.repos.company.getOrCreate();
        const priceMode: PriceMode = empresa.priceMode === 'net' ? 'net' : 'gross';

        const lineas = await Promise.all(
          items.map(async (i) => {
            const art = i.codigo_sistema ? await deps.repos.articles.findByBarcode(i.codigo_sistema) : null;
            const vatRate = art?.vatRate ?? '21.00';
            // El catálogo publica precios FINALES (lo que el cliente pagó). En
            // modo 'net' la venta lleva precios netos: se quita el IVA de la
            // ficha y el servidor lo vuelve a sumar.
            const unitPrice =
              priceMode === 'net'
                ? (Number(i.precio) / (1 + Number(vatRate) / 100)).toFixed(4)
                : Number(i.precio).toFixed(4);
            const quantity = Number(i.cant).toFixed(3);
            // Sin artículo en el sistema entra como artículo rápido: se cobra,
            // pero no mueve stock de algo que no existe en el inventario.
            return art
              ? { articleId: art.id, quantity, unitPrice, vatRate }
              : { description: i.nombre, quantity, unitPrice, vatRate };
          }),
        );

        const total = totalComoElServidor(lineas, priceMode);
        // Lo que el cliente pagó (o va a pagar) es el total del pedido. Si las
        // líneas no lo explican, algo cambió en el catálogo después del
        // checkout: no se registra una venta por otro importe sin que alguien
        // lo mire.
        const totalPedido = Number(pedido.total);
        if (Number.isFinite(totalPedido) && totalPedido > 0 && Math.abs(totalPedido - Number(total)) > 0.01) {
          throw new ValidationError(
            'total',
            `El total del pedido ($${totalPedido.toFixed(2)}) no coincide con la suma de sus líneas ($${Number(total).toFixed(2)}). Revíselo en el catálogo o cárguelo en Ventas.`,
          );
        }
        const svc = new SalesService(ctx);
        const venta = await svc.createSale({
          type: payload.type ?? 'X',
          customerId,
          payments: [{ paymentMethodId: payload.paymentMethodId, amount: total }],
          notes: `Pedido web N° ${pedido.numero} — ${pedido.clienteNombre}`,
          lines: lineas as never,
        });

        // Compare-and-set: si otra terminal convirtió el mismo pedido mientras
        // se registraba esta venta, la venta queda (es real, se cobró) pero el
        // pedido no se pisa y se avisa para que la anulen.
        if (!deps.repos.catalogoPedidos.marcar(payload.id, 'convertido', venta.sale.id)) {
          throw new ValidationError(
            'id',
            `El pedido ya había sido procesado por otra terminal. Se registró igual la venta ${venta.sale.type} #${venta.sale.number}: anúlela si está duplicada.`,
          );
        }
        void avisarCatalogo(deps, { id: pedido.id, pedidoId: pedido.pedidoId, saleId: venta.sale.id }, 'confirmado');
        return { ok: true as const, ventaNumero: venta.sale.number, ventaTipo: venta.sale.type };
      },
    ),

    /**
     * Pedido NO pagado: se carga en Ventas (distintas formas de pago, mixtas
     * incluso) y el cajero cobra ahí como cualquier venta. Esto solo enlaza la
     * venta que YA se creó — no crea nada. Idempotente: si el pedido ya no
     * está pendiente (doble llamada), no rompe.
     */
    'catalogo:pedidoVincularVenta': withSession(deps, async (payload: { id: string; saleId: string }, ctx) => {
      requirePermission(ctx.currentUser, 'create_sale');
      const pedido = deps.repos.catalogoPedidos.buscar(payload.id);
      if (!pedido) throw new ValidationError('id', 'El pedido no existe');
      if (pedido.estado !== 'pendiente') return { ok: true as const };
      // La venta tiene que existir y estar viva: enlazar un id inventado o una
      // venta ya anulada dejaría el pedido "cobrado" sin plata detrás.
      const venta = await deps.repos.sales.findById(payload.saleId);
      if (!venta) throw new ValidationError('saleId', 'La venta no existe');
      if (venta.status === 'voided') throw new ValidationError('saleId', 'Esa venta está anulada');
      if (!deps.repos.catalogoPedidos.marcar(payload.id, 'convertido', payload.saleId)) {
        return { ok: true as const };
      }
      void avisarCatalogo(deps, { id: pedido.id, pedidoId: pedido.pedidoId, saleId: venta.id }, 'confirmado');
      return { ok: true as const };
    }),

    'catalogo:estadisticas': withSession(
      deps,
      async (payload: { from: number; to: number }, ctx): Promise<CatalogoEstadisticasDTO> => {
        requirePermission(ctx.currentUser, 'view_reports');
        const company = await ctx.repos.company.getOrCreate();
        const url = (company.catalogoUrl ?? '').trim();
        if (!url) return { integrado: false };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const headers: Record<string, string> = {};
          if (company.catalogoToken) headers.authorization = `Bearer ${company.catalogoToken}`;
          const res = await fetch(
            `${url.replace(/\/$/, '')}/api/estadisticas?from=${payload.from}&to=${payload.to}`,
            { headers, signal: controller.signal },
          );
          if (!res.ok) {
            return { integrado: true, disponible: false, motivo: `El catálogo respondió ${res.status}` };
          }
          const d = (await res.json()) as Record<string, unknown>;
          const lista = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
          return {
            integrado: true,
            disponible: true,
            visitas: typeof d.visitas === 'number' ? d.visitas : 0,
            visitantes: typeof d.visitantes === 'number' ? d.visitantes : null,
            productosMasVistos: lista(d.productosMasVistos),
            productosMasComprados: lista(d.productosMasComprados),
            terminosMasBuscados: lista(d.terminosMasBuscados),
            busquedasSinResultado: lista(d.busquedasSinResultado),
          };
        } catch {
          return { integrado: true, disponible: false, motivo: 'No se pudo conectar con el catálogo' };
        } finally {
          clearTimeout(timer);
        }
      },
    ),
  };
}
