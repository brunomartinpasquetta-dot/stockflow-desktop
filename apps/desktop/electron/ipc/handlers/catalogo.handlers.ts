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
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { CatalogoEstadisticasDTO } from '../types';

const TIMEOUT_MS = 8000;

export function buildCatalogoHandlers(deps: HandlerDeps): HandlerMap {
  return {
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
