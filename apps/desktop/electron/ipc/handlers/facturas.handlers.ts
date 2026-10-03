/**
 * Canales de FACTURAS DE COMPRA POR TELÉFONO (ver docs/PLAN_FACTURAS_TELEFONO.md).
 *
 * El trabajo lo hace `electron/facturas/servicio.ts`; acá sólo se controla
 * quién puede y se arma el enlace del teléfono. Todos piden sesión y permiso
 * de Compras; activar la opción y descargar el lector piden el de
 * Configuración y además no pasan desde un puesto de la red ni desde internet
 * (ver preload-bridge.ts): se hacen sentado en la PC que lee.
 *
 * De acá nunca sale una compra: `marcarCargada` sólo anota que la compra de
 * esa factura ya se registró (lo llama Compras al confirmarla) y recuerda los
 * códigos del proveedor. `seguir` y `aCompras` son el ida y vuelta de
 * «Cargar con el teléfono»: Compras sigue la factura que manda el teléfono y,
 * si hubo que revisarla, la revisión se la devuelve sin recargar Compras.
 */
import { BusinessRuleError, requirePermission } from '@stockflow/core';

import { PREFIJO_FOTOS } from '../../facturas/servidorFotos';
import { elegirIpLocal, FacturasError, type FacturasTelefono } from '../../facturas/servicio';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  EstadoFacturasDTO,
  FacturaEscaneadaDetalleDTO,
  FacturaEscaneadaResumenDTO,
  FacturasSeguimientoDTO,
  FacturasVincularDTO,
} from '../types';

export function buildFacturasHandlers(deps: HandlerDeps): HandlerMap {
  const servicio = (): FacturasTelefono => {
    if (!deps.facturas) throw new BusinessRuleError('facturas', 'Las facturas por teléfono no están disponibles en esta PC.');
    return deps.facturas;
  };
  /** Los errores del servicio traen texto para el usuario: se muestran tal cual. */
  const conMensaje = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FacturasError) throw new BusinessRuleError('facturas', e.message);
      throw e;
    }
  };

  return {
    'facturas:estado': withSession(deps, async (_payload: unknown, ctx): Promise<EstadoFacturasDTO> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return servicio().estado();
    }),

    'facturas:configurar': withSession(
      deps,
      async (payload: { activo?: boolean; mejorLectura?: boolean }, ctx): Promise<EstadoFacturasDTO> => {
        requirePermission(ctx.currentUser, 'manage_hardware');
        const activo = typeof payload?.activo === 'boolean' ? payload.activo : undefined;
        const mejorLectura = typeof payload?.mejorLectura === 'boolean' ? payload.mejorLectura : undefined;
        if (activo === undefined && mejorLectura === undefined) {
          throw new BusinessRuleError('facturas', 'Falta indicar si se activa o se desactiva.');
        }
        // Sólo `activo` y "Mejorar lectura": el modelo del lector no se elige desde la pantalla.
        return servicio().configurar({
          ...(activo !== undefined ? { activo } : {}),
          ...(mejorLectura !== undefined ? { mejorLectura } : {}),
        });
      },
    ),

    'facturas:descargarLector': withSession(deps, async (_payload: unknown, ctx): Promise<EstadoFacturasDTO> => {
      requirePermission(ctx.currentUser, 'manage_hardware');
      servicio().descargarLector();
      return servicio().estado();
    }),

    /** Enlace para el QR de "Vincular teléfono". */
    'facturas:vincular': withSession(deps, async (_payload: unknown, ctx): Promise<FacturasVincularDTO> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return conMensaje(() => {
        const s = servicio();
        if (!s.getConfig().activo) throw new FacturasError('Las facturas por teléfono están desactivadas.', 'apagado');
        const ip = elegirIpLocal();
        const puerto = s.servidorFotos.puerto;
        const tunel = deps.lanExtras?.tunel?.estado();
        const internet = tunel?.estado === 'conectado' && tunel.direccion ? tunel.direccion.replace(/\/+$/, '') : null;
        if (!(ip && puerto) && !internet) {
          throw new BusinessRuleError(
            'facturas',
            s.servidorFotos.error ?? 'Esta PC no está conectada a una red. Conéctela a la misma red Wi-Fi que el teléfono.',
          );
        }
        const { token, vence, sesion } = s.crearSesion(ctx.currentUser.id);
        return {
          urlLocal: ip && puerto ? `http://${ip}:${puerto}${PREFIJO_FOTOS}${token}` : null,
          urlInternet: internet ? `${internet}${PREFIJO_FOTOS}${token}` : null,
          vence,
          sesion,
        };
      });
    }),

    /**
     * Lo que sigue Compras mientras espera la factura del teléfono: las que
     * mandó ese enlace y, por id, la que está en revisión (`esperaRevision`:
     * esta pantalla espera que vuelva).
     */
    'facturas:seguir': withSession(
      deps,
      async (payload: { sesion?: string; id?: string; esperaRevision?: boolean; pantalla?: string }, ctx): Promise<FacturasSeguimientoDTO> => {
        requirePermission(ctx.currentUser, 'manage_purchases');
        return servicio().seguir({ sesion: payload?.sesion, id: payload?.id, esperaRevision: payload?.esperaRevision, pantalla: payload?.pantalla });
      },
    ),

    /** La revisión manda la factura a la pantalla de Compras (`pantalla`) que la espera (no crea la compra). */
    'facturas:aCompras': withSession(deps, async (payload: { id: string; pantalla?: string }, ctx): Promise<{ recibe: boolean }> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return conMensaje(() => servicio().enviarACompras(payload?.id, payload?.pantalla));
    }),

    'facturas:listar': withSession(deps, async (_payload: unknown, ctx): Promise<FacturaEscaneadaResumenDTO[]> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return servicio().listar();
    }),

    'facturas:obtener': withSession(deps, async (payload: { id: string }, ctx): Promise<FacturaEscaneadaDetalleDTO> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return conMensaje(() => servicio().obtener(payload?.id));
    }),

    'facturas:foto': withSession(deps, async (payload: { id: string; hoja: number }, ctx): Promise<{ dataUrl: string }> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return conMensaje(() => ({ dataUrl: servicio().foto(payload?.id, payload?.hoja) }));
    }),

    'facturas:guardar': withSession(
      deps,
      async (
        payload: { id: string; supplierId?: string | null; header?: unknown; lines?: unknown },
        ctx,
      ): Promise<FacturaEscaneadaDetalleDTO> => {
        requirePermission(ctx.currentUser, 'manage_purchases');
        return conMensaje(() => servicio().guardar(payload ?? { id: '' }));
      },
    ),

    'facturas:releer': withSession(deps, async (payload: { id: string }, ctx): Promise<{ ok: true }> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return conMensaje(async () => {
        await servicio().releer(payload?.id);
        return { ok: true as const };
      });
    }),

    'facturas:descartar': withSession(deps, async (payload: { id: string }, ctx): Promise<{ ok: true }> => {
      requirePermission(ctx.currentUser, 'manage_purchases');
      return conMensaje(() => {
        servicio().descartar(payload?.id);
        return { ok: true as const };
      });
    }),

    'facturas:marcarCargada': withSession(
      deps,
      async (
        payload: { id: string; supplierId?: string; vinculos?: { code: string; articleId: string; unitsPerPack?: number | null }[] },
        ctx,
      ): Promise<{ ok: true; guardados: number }> => {
        requirePermission(ctx.currentUser, 'manage_purchases');
        return conMensaje(async () => {
          const r = await servicio().marcarCargada(payload ?? { id: '' });
          return { ok: true as const, guardados: r.guardados };
        });
      },
    ),
  };
}
