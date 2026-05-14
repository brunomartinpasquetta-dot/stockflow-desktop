/**
 * Servicio de reportes consolidados (sólo lectura). Requiere permiso `view_reports`.
 */
import type { Purchase, Sale } from '@stockflow/shared';
import { decimalString, mulDecimal, subDecimal, sumDecimals } from '@stockflow/shared';

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

export interface LowStockEntry {
  articleId: string;
  barcode: string;
  description: string;
  currentStock: string;
  threshold: string;
  suggestedQty: string;
  supplierId: string | null;
  supplierName: string | null;
  familyId: string | null;
  familyName: string | null;
  lastCost: string;
}

export interface InventoryArticleRow {
  articleId: string;
  barcode: string;
  description: string;
  stock: string;
  costPrice: string;
  listPrice1: string;
  costValue: string;
  saleValue: string;
}

export interface InventoryFamilyGroup {
  familyId: string | null;
  familyName: string;
  articles: InventoryArticleRow[];
  totals: { costValue: string; saleValue: string; articles: number };
}

export interface InventorySupplierGroup {
  supplierId: string | null;
  supplierName: string;
  families: InventoryFamilyGroup[];
  totals: { costValue: string; saleValue: string; articles: number };
}

export interface InventoryReport {
  groups: InventorySupplierGroup[];
  grandTotal: {
    costValue: string;
    saleValue: string;
    articles: number;
    marginAmount: string;
    marginPct: string;
  };
}

export interface VendorRankingRow {
  userId: string;
  userName: string;
  salesCount: number;
  totalAmount: string;
  averageTicket: string;
  /** "12.34" — porcentaje del total general. */
  percentageOfTotal: string;
}

export interface SalesByVendorReport {
  rows: VendorRankingRow[];
  grandTotal: string;
  totalSales: number;
  vendorCount: number;
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
      byPaymentType: groupAccumulate(
        completed.map((s) => ({ key: s.isAccountSale ? 'cuenta_corriente' : 'contado', total: s.total })),
      ),
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

  async getLowStockArticles(
    input: { supplierId?: string; familyId?: string; criteria?: 'min' | 'ideal' },
    _ctx?: ServiceContext,
  ): Promise<LowStockEntry[]> {
    this.requireReports();
    const criteria = input.criteria ?? 'min';
    const [articles, suppliers, families] = await Promise.all([
      this.ctx.repos.articles.findAll(),
      this.ctx.repos.suppliers.findAll(),
      this.ctx.repos.families.findAll(),
    ]);
    const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
    const familyName = new Map(families.map((f) => [f.id, f.name]));

    const rows: LowStockEntry[] = [];
    for (const a of articles) {
      if (!a.active) continue;
      if (input.supplierId && a.supplierId !== input.supplierId) continue;
      if (input.familyId && a.familyId !== input.familyId) continue;
      const min = Number(a.minStock ?? '0');
      const ideal = Number(a.idealStock ?? '0');
      const stock = Number(a.stock ?? '0');
      let threshold: number;
      if (criteria === 'min') {
        if (!(min > 0) || !(stock < min)) continue;
        threshold = min;
      } else {
        if (!(ideal > 0) || !(stock < ideal)) continue;
        threshold = ideal;
      }
      const suggested = ideal > 0 ? Math.max(0, ideal - stock) : Math.max(0, min - stock);
      rows.push({
        articleId: a.id,
        barcode: a.barcode,
        description: a.description,
        currentStock: decimalString(a.stock, 3),
        threshold: decimalString(threshold, 3),
        suggestedQty: decimalString(suggested, 3),
        supplierId: a.supplierId ?? null,
        supplierName: a.supplierId ? (supplierName.get(a.supplierId) ?? null) : null,
        familyId: a.familyId ?? null,
        familyName: a.familyId ? (familyName.get(a.familyId) ?? null) : null,
        lastCost: a.costPrice,
      });
    }

    rows.sort((a, b) => {
      const sa = (a.supplierName ?? 'zzzz').localeCompare(b.supplierName ?? 'zzzz', 'es');
      if (sa !== 0) return sa;
      const fa = (a.familyName ?? 'zzzz').localeCompare(b.familyName ?? 'zzzz', 'es');
      if (fa !== 0) return fa;
      return a.description.localeCompare(b.description, 'es');
    });
    return rows;
  }

  async getInventoryReport(
    input: { supplierId?: string; familyId?: string; includeZeroStock?: boolean },
    _ctx?: ServiceContext,
  ): Promise<InventoryReport> {
    this.requireReports();
    const includeZero = input.includeZeroStock === true;
    const [articles, suppliers, families] = await Promise.all([
      this.ctx.repos.articles.findAll(),
      this.ctx.repos.suppliers.findAll(),
      this.ctx.repos.families.findAll(),
    ]);
    const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
    const familyName = new Map(families.map((f) => [f.id, f.name]));

    // sup → fam → rows
    const map = new Map<string, Map<string, InventoryArticleRow[]>>();
    const NULL_KEY = '__none__';
    for (const a of articles) {
      if (!a.active) continue;
      if (input.supplierId && a.supplierId !== input.supplierId) continue;
      if (input.familyId && a.familyId !== input.familyId) continue;
      if (!includeZero && Number(a.stock) <= 0) continue;
      const sKey = a.supplierId ?? NULL_KEY;
      const fKey = a.familyId ?? NULL_KEY;
      let bySup = map.get(sKey);
      if (!bySup) {
        bySup = new Map();
        map.set(sKey, bySup);
      }
      let arr = bySup.get(fKey);
      if (!arr) {
        arr = [];
        bySup.set(fKey, arr);
      }
      const costValue = mulDecimal(a.stock, a.costPrice, 4);
      const saleValue = mulDecimal(a.stock, a.listPrice1, 4);
      arr.push({
        articleId: a.id,
        barcode: a.barcode,
        description: a.description,
        stock: decimalString(a.stock, 3),
        costPrice: a.costPrice,
        listPrice1: a.listPrice1,
        costValue,
        saleValue,
      });
    }

    const groups: InventorySupplierGroup[] = [];
    let grandCost = '0.0000';
    let grandSale = '0.0000';
    let grandArticles = 0;

    const supplierKeys = [...map.keys()].sort((a, b) => {
      const na = a === NULL_KEY ? 'Sin proveedor' : (supplierName.get(a) ?? a);
      const nb = b === NULL_KEY ? 'Sin proveedor' : (supplierName.get(b) ?? b);
      return na.localeCompare(nb, 'es');
    });
    for (const sKey of supplierKeys) {
      const bySup = map.get(sKey)!;
      const famGroups: InventoryFamilyGroup[] = [];
      let supCost = '0.0000';
      let supSale = '0.0000';
      let supArts = 0;
      const familyKeys = [...bySup.keys()].sort((a, b) => {
        const na = a === NULL_KEY ? 'Sin familia' : (familyName.get(a) ?? a);
        const nb = b === NULL_KEY ? 'Sin familia' : (familyName.get(b) ?? b);
        return na.localeCompare(nb, 'es');
      });
      for (const fKey of familyKeys) {
        const arts = bySup.get(fKey)!;
        arts.sort((x, y) => x.description.localeCompare(y.description, 'es'));
        const cost = sumDecimals(arts.map((r) => r.costValue));
        const sale = sumDecimals(arts.map((r) => r.saleValue));
        famGroups.push({
          familyId: fKey === NULL_KEY ? null : fKey,
          familyName: fKey === NULL_KEY ? 'Sin familia' : (familyName.get(fKey) ?? fKey),
          articles: arts,
          totals: { costValue: cost, saleValue: sale, articles: arts.length },
        });
        supCost = sumDecimals([supCost, cost]);
        supSale = sumDecimals([supSale, sale]);
        supArts += arts.length;
      }
      groups.push({
        supplierId: sKey === NULL_KEY ? null : sKey,
        supplierName: sKey === NULL_KEY ? 'Sin proveedor' : (supplierName.get(sKey) ?? sKey),
        families: famGroups,
        totals: { costValue: supCost, saleValue: supSale, articles: supArts },
      });
      grandCost = sumDecimals([grandCost, supCost]);
      grandSale = sumDecimals([grandSale, supSale]);
      grandArticles += supArts;
    }

    const marginAmount = subDecimal(grandSale, grandCost);
    const marginPct = Number(grandCost) > 0
      ? ((Number(marginAmount) / Number(grandCost)) * 100).toFixed(2)
      : '0.00';
    return {
      groups,
      grandTotal: {
        costValue: grandCost,
        saleValue: grandSale,
        articles: grandArticles,
        marginAmount,
        marginPct,
      },
    };
  }

  async getSalesByVendor(
    input: { from: number; to: number; userId?: string },
    _ctx?: ServiceContext,
  ): Promise<SalesByVendorReport> {
    this.requireReports();
    let sales = (await this.ctx.repos.sales.findByDateRange(input.from, input.to)).filter(
      (s) => s.status !== 'voided',
    );
    if (input.userId) sales = sales.filter((s) => s.sellerId === input.userId);

    const users = await this.ctx.repos.users.findAll();
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));

    const byId = new Map<string, { count: number; total: string }>();
    for (const s of sales) {
      const bucket = byId.get(s.sellerId) ?? { count: 0, total: '0.0000' };
      bucket.count += 1;
      bucket.total = sumDecimals([bucket.total, s.total]);
      byId.set(s.sellerId, bucket);
    }

    const grandTotalNum = [...byId.values()].reduce((a, b) => a + Number(b.total), 0);
    const grandTotal = grandTotalNum.toFixed(4);
    const totalSales = [...byId.values()].reduce((a, b) => a + b.count, 0);

    const rows: VendorRankingRow[] = [...byId.entries()].map(([userId, b]) => {
      const avg = b.count > 0 ? (Number(b.total) / b.count).toFixed(4) : '0.0000';
      const pct = grandTotalNum > 0 ? ((Number(b.total) / grandTotalNum) * 100).toFixed(2) : '0.00';
      return {
        userId,
        userName: nameById.get(userId) ?? userId,
        salesCount: b.count,
        totalAmount: b.total,
        averageTicket: avg,
        percentageOfTotal: pct,
      };
    });
    rows.sort((a, b) => Number(b.totalAmount) - Number(a.totalAmount));

    return {
      rows,
      grandTotal,
      totalSales,
      vendorCount: rows.length,
    };
  }
}
