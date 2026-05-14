/**
 * Handlers IPC para la búsqueda global (P-BUSQUEDA).
 *
 * Un único canal `search:global` que delega en `SearchService` y devuelve un
 * resultado agrupado por categoría. Sin gating por permiso: cualquier usuario
 * con sesión activa puede ejecutarla.
 */
import { SearchService, type GlobalSearchCategory } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  ArticleDTO,
  CustomerDTO,
  GlobalSearchResultDTO,
  PurchaseDTO,
  SaleDTO,
  SupplierDTO,
} from '../types';

interface SearchPayload {
  query: string;
  limitPerCategory?: number;
  categories?: GlobalSearchCategory[];
}

export function buildSearchHandlers(deps: HandlerDeps): HandlerMap {
  void deps;
  return {
    'search:global': withSession(
      deps,
      async (payload: SearchPayload, ctx): Promise<GlobalSearchResultDTO> => {
        const service = new SearchService(ctx);
        const r = await service.globalSearch({
          query: payload?.query ?? '',
          limitPerCategory: payload?.limitPerCategory,
          categories: payload?.categories,
        });
        return {
          articles: r.articles as ArticleDTO[],
          customers: r.customers as CustomerDTO[],
          suppliers: r.suppliers as SupplierDTO[],
          sales: r.sales as SaleDTO[],
          purchases: r.purchases as PurchaseDTO[],
        };
      },
    ),
  };
}
