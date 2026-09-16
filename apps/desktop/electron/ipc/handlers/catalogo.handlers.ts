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
import { SalesService, ValidationError } from '@stockflow/core';

import { obtenerCatalogoSync } from '../../catalogo/CatalogoSync';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { CatalogoEstadisticasDTO } from '../types';

const TIMEOUT_MS = 8000;

/** Le avisa al catálogo en qué quedó el pedido. Best-effort: si falla, el
 *  pedido ya está resuelto de este lado y se corrige desde el panel. */
async function avisarCatalogo(
  deps: HandlerDeps,
  pedidoId: string,
  estado: 'confirmado' | 'cancelado',
  ventaSistema?: string,
): Promise<void> {
  try {
    const empresa = await deps.repos.company.getOrCreate();
    const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
    const token = (empresa.catalogoToken ?? '').trim();
    if (!url || !token) return;
    await fetch(`${url}/api/stockflow/pedidos/${pedidoId}/estado`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ estado, venta_sistema: ventaSistema }),
    });
  } catch {
    /* el pedido ya está resuelto en el sistema; el catálogo se corrige a mano */
  }
}

export function buildCatalogoHandlers(deps: HandlerDeps): HandlerMap {
  return {
    /* ------------------------- Espejo de artículos ------------------------- */

    'catalogo:syncEstado': withSession(deps, async () => {
      const e = deps.repos.catalogo.getState();
      return {
        activo: e.enabled,
        pendientes: deps.repos.catalogo.pendientes(e.cursor),
        publicadosTotal: e.pushedTotal,
        ultimaCorrida: e.lastRunAt,
        ultimoExito: e.lastOkAt,
        ultimoError: e.lastError,
      };
    }),

    'catalogo:syncActivar': withSession(deps, async (payload: { activo: boolean }) => {
      deps.repos.catalogo.saveState({ enabled: Boolean(payload?.activo) });
      return { ok: true as const };
    }),

    'catalogo:syncAhora': withSession(deps, async (payload: { todo?: boolean }) => {
      const sync = obtenerCatalogoSync(deps.repos);
      await sync.traerPedidos();
      return payload?.todo ? sync.republicarTodo() : sync.correr();
    }),

    /* --------------------------- Vinculación -------------------------- */

    /**
     * Propuesta de apareo: productos del catálogo sin `codigo_sistema`,
     * cruzados por nombre contra los artículos activos. Solo lectura — no
     * escribe nada hasta que se confirme con `catalogo:vincularLote`.
     */
    'catalogo:sugerirVinculacion': withSession(deps, async () => {
      const sync = obtenerCatalogoSync(deps.repos);
      return sync.sugerirVinculacion();
    }),

    'catalogo:vincularLote': withSession(
      deps,
      async (payload: { vinculos: { sku: string; codigoSistema: string }[] }) => {
        const sync = obtenerCatalogoSync(deps.repos);
        return sync.vincularLote(payload.vinculos);
      },
    ),

    /* ---------------------------- Pedidos web ---------------------------- */

    /** Liviano: solo el número, para pintar el aviso en el menú sin resolver líneas. */
    'catalogo:pedidosContarPendientes': withSession(deps, async () => {
      return { pendientes: deps.repos.catalogoPedidos.contarPendientes() };
    }),

    'catalogo:pedidosListar': withSession(deps, async (payload: { estado?: 'pendiente' | 'convertido' | 'rechazado' }) => {
      const filas = deps.repos.catalogoPedidos.listar(payload?.estado);
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
            lineas,
          };
        }),
      );
      return resueltos;
    }),

    'catalogo:pedidoRechazar': withSession(deps, async (payload: { id: string }) => {
      const pedido = deps.repos.catalogoPedidos.buscar(payload.id);
      if (!pedido) throw new ValidationError('id', 'El pedido no existe');
      deps.repos.catalogoPedidos.marcar(payload.id, 'rechazado');
      // Avisarle al catálogo para que devuelva el stock reservado.
      void avisarCatalogo(deps, pedido.pedidoId, 'cancelado');
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

        const cf = await deps.repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
        const customerId = payload.customerId ?? cf?.id;
        if (!customerId) throw new ValidationError('customerId', 'Falta el cliente');

        const lineas = await Promise.all(
          items.map(async (i) => {
            const art = i.codigo_sistema ? await deps.repos.articles.findByBarcode(i.codigo_sistema) : null;
            // Sin artículo en el sistema entra como artículo rápido: se cobra,
            // pero no mueve stock de algo que no existe en el inventario.
            return art
              ? { articleId: art.id, quantity: String(i.cant), unitPrice: i.precio.toFixed(4) }
              : { description: i.nombre, quantity: String(i.cant), unitPrice: i.precio.toFixed(4) };
          }),
        );

        const total = lineas.reduce((a, l) => a + Number(l.unitPrice) * Number(l.quantity), 0);
        const svc = new SalesService(ctx);
        const venta = await svc.createSale({
          type: payload.type ?? 'X',
          customerId,
          payments: [{ paymentMethodId: payload.paymentMethodId, amount: total.toFixed(4) }],
          notes: `Pedido web N° ${pedido.numero} — ${pedido.clienteNombre}`,
          lines: lineas as never,
        });

        deps.repos.catalogoPedidos.marcar(payload.id, 'convertido', venta.sale.id);
        void avisarCatalogo(deps, pedido.pedidoId, 'confirmado', `${venta.sale.type}-${venta.sale.number}`);
        return { ok: true as const, ventaNumero: venta.sale.number, ventaTipo: venta.sale.type };
      },
    ),

    /**
     * Pedido NO pagado: se carga en Ventas (distintas formas de pago, mixtas
     * incluso) y el cajero cobra ahí como cualquier venta. Esto solo enlaza la
     * venta que YA se creó — no crea nada. Idempotente: si el pedido ya no
     * está pendiente (doble llamada), no rompe.
     */
    'catalogo:pedidoVincularVenta': withSession(deps, async (payload: { id: string; saleId: string }) => {
      const pedido = deps.repos.catalogoPedidos.buscar(payload.id);
      if (!pedido) throw new ValidationError('id', 'El pedido no existe');
      if (pedido.estado !== 'pendiente') return { ok: true as const };
      const venta = await deps.repos.sales.findById(payload.saleId);
      deps.repos.catalogoPedidos.marcar(payload.id, 'convertido', payload.saleId);
      void avisarCatalogo(
        deps,
        pedido.pedidoId,
        'confirmado',
        venta ? `${venta.type}-${venta.number}` : undefined,
      );
      return { ok: true as const };
    }),

    'catalogo:estadisticas': withSession(
      deps,
      async (payload: { from: number; to: number }, ctx): Promise<CatalogoEstadisticasDTO> => {
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
