/**
 * SearchService — búsqueda global unificada (P-BUSQUEDA).
 *
 * Expone un único punto de entrada (`globalSearch`) que paraleliza la consulta
 * sobre los repositorios de artículos, clientes, proveedores, ventas y compras.
 * No aplica permisos: cualquier usuario autenticado puede usar la búsqueda
 * (los items siempre llevan a pantallas que sí aplican gating).
 */
import type { Article, Customer, Purchase, Sale, Supplier } from '@stockflow/db';

import type { ServiceContext } from '../context';

export type GlobalSearchCategory =
  | 'articles'
  | 'customers'
  | 'suppliers'
  | 'sales'
  | 'purchases';

export interface GlobalSearchOptions {
  query: string;
  /** Filas por categoría; default 8. */
  limitPerCategory?: number;
  /** Categorías a buscar; default todas. */
  categories?: GlobalSearchCategory[];
}

export interface GlobalSearchResult {
  articles: Article[];
  customers: Customer[];
  suppliers: Supplier[];
  sales: Sale[];
  purchases: Purchase[];
}

const ALL_CATEGORIES: GlobalSearchCategory[] = [
  'articles',
  'customers',
  'suppliers',
  'sales',
  'purchases',
];

const EMPTY: GlobalSearchResult = {
  articles: [],
  customers: [],
  suppliers: [],
  sales: [],
  purchases: [],
};

export class SearchService {
  constructor(private readonly ctx: ServiceContext) {}

  async globalSearch(opts: GlobalSearchOptions): Promise<GlobalSearchResult> {
    const q = (opts.query ?? '').trim();
    if (q.length < 1) return { ...EMPTY };
    const limit = opts.limitPerCategory ?? 8;
    const cats = new Set<GlobalSearchCategory>(opts.categories ?? ALL_CATEGORIES);
    const { repos } = this.ctx;

    const [articles, customers, suppliers, sales, purchases] = await Promise.all([
      cats.has('articles') ? repos.articles.findByText(q, limit) : Promise.resolve([] as Article[]),
      cats.has('customers') ? repos.customers.findByText(q, limit) : Promise.resolve([] as Customer[]),
      cats.has('suppliers') ? repos.suppliers.findByText(q, limit) : Promise.resolve([] as Supplier[]),
      cats.has('sales') ? repos.sales.findByNumberText(q, limit) : Promise.resolve([] as Sale[]),
      cats.has('purchases') ? repos.purchases.findByText(q, limit) : Promise.resolve([] as Purchase[]),
    ]);

    return { articles, customers, suppliers, sales, purchases };
  }
}
