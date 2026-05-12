/**
 * Servicio de reportes consolidados (sólo lectura). Requiere permiso `view_reports`.
 */
import type { Purchase, Sale } from '@stockflow/shared';
import { mulDecimal, sumDecimals } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { CashService, type CashReport } from './cash.service';

export interface SalesReport {
  from: number;
  to: number;
  count: number;
  total: string;
  byStatus: Record<string, { count: number; total: string }>;
  byPaymentType: Record<string, { count: number; total: string }>;
  sales: Sale[];
}

export interface PurchasesReport {
  from: number;
  to: number;
  count: number;
  total: string;
  purchases: Purchase[];
}

export interface SellerReportRow {
  sellerId: string;
  sellerName: string;
  count: number;
  total: string;
}

export interface FamilyInventoryRow {
  familyId: string | null;
  familyName: string;
  articleCount: number;
  totalStock: string;
  costValue: string;
  saleValue: string;
}

export interface TopArticleRow {
  articleId: string;
  description: string;
  quantity: string;
  amount: string;
}

function groupAccumulate<T extends string>(
  rows: Array<{ key: T; total: string }>,
): Record<string, { count: number; total: string }> {
  const out: Record<string, { count: number; total: string }> = {};
  for (const r of rows) {
    const bucket = out[r.key] ?? { count: 0, total: '0.0000' };
    bucket.count += 1;
    bucket.total = sumDecimals([bucket.total, r.total]);
    out[r.key] = bucket;
  }
  return out;
}

export class ReportsService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireReports(): void {
    requirePermission(this.ctx.currentUser, 'view_reports');
  }

  async salesByDateRange(
    from: number,
    to: number,
    filters?: { sellerId?: string; customerId?: string },
  ): Promise<SalesReport> {
    this.requireReports();
    let sales = await this.ctx.repos.sales.findByDateRange(from, to);
    if (filters?.sellerId) sales = sales.filter((s) => s.sellerId === filters.sellerId);
    if (filters?.customerId) sales = sales.filter((s) => s.customerId === filters.customerId);
    const completed = sales.filter((s) => s.status === 'completed');
    return {
      from,
      to,
      count: completed.length,
      total: sumDecimals(completed.map((s) => s.total)),
      byStatus: groupAccumulate(sales.map((s) => ({ key: s.status, total: s.total }))),
      byPaymentType: groupAccumulate(completed.map((s) => ({ key: s.paymentType, total: s.total }))),
      sales,
    };
  }

  async purchasesByDateRange(
    from: number,
    to: number,
    filters?: { supplierId?: string },
  ): Promise<PurchasesReport> {
    this.requireReports();
    let purchases = await this.ctx.repos.purchases.findByDateRange(from, to);
    if (filters?.supplierId) purchases = purchases.filter((p) => p.supplierId === filters.supplierId);
    const completed = purchases.filter((p) => p.status === 'completed');
    return {
      from,
      to,
      count: completed.length,
      total: sumDecimals(completed.map((p) => p.total)),
      purchases,
    };
  }

  async salesBySeller(from: number, to: number): Promise<SellerReportRow[]> {
    this.requireReports();
    const sales = (await this.ctx.repos.sales.findByDateRange(from, to)).filter(
      (s) => s.status === 'completed',
    );
    const users = await this.ctx.repos.users.findAll();
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));
    const byId = new Map<string, { count: number; total: string }>();
    for (const s of sales) {
      const bucket = byId.get(s.sellerId) ?? { count: 0, total: '0.0000' };
      bucket.count += 1;
      bucket.total = sumDecimals([bucket.total, s.total]);
      byId.set(s.sellerId, bucket);
    }
    return [...byId.entries()].map(([sellerId, b]) => ({
      sellerId,
      sellerName: nameById.get(sellerId) ?? sellerId,
      count: b.count,
      total: b.total,
    }));
  }

  async inventoryByFamily(): Promise<FamilyInventoryRow[]> {
    this.requireReports();
    const [articles, families] = await Promise.all([
      this.ctx.repos.articles.findAll(),
      this.ctx.repos.families.findAll(),
    ]);
    const familyName = new Map(families.map((f) => [f.id, f.name]));
    const buckets = new Map<string | null, FamilyInventoryRow>();
    for (const a of articles) {
      const key = a.familyId ?? null;
      const row =
        buckets.get(key) ??
        ({
          familyId: key,
          familyName: key ? (familyName.get(key) ?? key) : 'Sin familia',
          articleCount: 0,
          totalStock: '0.000',
          costValue: '0.0000',
          saleValue: '0.0000',
        } satisfies FamilyInventoryRow);
      row.articleCount += 1;
      row.totalStock = sumDecimals([row.totalStock, a.stock], 3);
      row.costValue = sumDecimals([row.costValue, mulDecimal(a.stock, a.costPrice, 4)]);
      row.saleValue = sumDecimals([row.saleValue, mulDecimal(a.stock, a.listPrice1, 4)]);
      buckets.set(key, row);
    }
    return [...buckets.values()];
  }

  async topArticles(from: number, to: number, limit = 10): Promise<TopArticleRow[]> {
    this.requireReports();
    const sales = (await this.ctx.repos.sales.findByDateRange(from, to)).filter(
      (s) => s.status === 'completed',
    );
    const saleIds = new Set(sales.map((s) => s.id));
    const lines = (await this.ctx.repos.saleLines.findAll()).filter((l) => saleIds.has(l.saleId));
    const articles = await this.ctx.repos.articles.findAll();
    const descById = new Map(articles.map((a) => [a.id, a.description]));
    const agg = new Map<string, { quantity: string; amount: string }>();
    for (const l of lines) {
      const cur = agg.get(l.articleId) ?? { quantity: '0.000', amount: '0.0000' };
      cur.quantity = sumDecimals([cur.quantity, l.quantity], 3);
      cur.amount = sumDecimals([cur.amount, l.lineTotal]);
      agg.set(l.articleId, cur);
    }
    return [...agg.entries()]
      .map(([articleId, v]) => ({
        articleId,
        description: descById.get(articleId) ?? articleId,
        quantity: v.quantity,
        amount: v.amount,
      }))
      .sort((a, b) => Number(b.quantity) - Number(a.quantity))
      .slice(0, limit);
  }

  async cashRegisterReport(registerId: string): Promise<CashReport> {
    this.requireReports();
    return new CashService(this.ctx).getCashReport(registerId);
  }
}
