/**
 * Servicio de Analytics: agregados consultivos para el dashboard de estadísticas.
 *
 * Todos los métodos requieren `view_reports` y filtran ventas con
 * `status != 'voided'` (idem compras).
 *
 * Diseño: una clase delgada que delega en SQL crudo de better-sqlite3
 * (`db.$client.prepare(...).all(...)`). Para los GROUP BY con agregados, las
 * funciones de strftime / SUM / AVG nativas de SQLite son más eficientes y
 * legibles que armar pipelines en JS. Todos los montos se devuelven como
 * `string` para mantener coherencia con el resto del dominio.
 */
import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';

export interface DateRange {
  from: number;
  to: number;
}

export interface TopProductRow {
  articleId: string;
  code: string;
  description: string;
  brand: string | null;
  quantity: string;
  revenue: string;
  marginPct: string;
}

export interface PaymentMethodRankRow {
  paymentMethodId: string;
  name: string;
  totalAmount: string;
  salesCount: number;
  percentageOfTotal: string;
}

export interface CustomerRankRow {
  customerId: string;
  fullName: string;
  salesCount: number;
  totalAmount: string;
}

export interface SupplierRankRow {
  supplierId: string;
  supplierName: string;
  purchasesCount: number;
  totalAmount: string;
}

export interface SalesTrendRow {
  bucket: string;
  count: number;
  total: string;
}

export interface AverageTicketResult {
  avg: string;
  min: string;
  max: string;
  count: number;
}

export interface SalesByHourRow {
  hour: number;
  count: number;
  total: string;
}

export interface SalesByDayOfWeekRow {
  dayOfWeek: number;
  count: number;
  total: string;
}

export interface MarginRow {
  familyId: string | null;
  familyName: string;
  revenue: string;
  cost: string;
  margin: string;
  marginPct: string;
}

export interface StockRotationRow {
  articleId: string;
  description: string;
  quantitySold: string;
  currentStock: string;
  rotation: string;
}

function fmt(n: unknown): string {
  if (n == null) return '0.00';
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '0.00';
  return v.toFixed(2);
}

export class AnalyticsService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireRead(): void {
    requirePermission(this.ctx.currentUser, 'view_reports');
  }

  async getTopSellingProducts(input: DateRange & { limit?: number }): Promise<TopProductRow[]> {
    this.requireRead();
    const limit = input.limit ?? 10;
    const sql = `
      SELECT
        a.id AS articleId,
        a.barcode AS code,
        a.description AS description,
        a.brand AS brand,
        SUM(CAST(sl.quantity AS REAL)) AS qty,
        SUM(CAST(sl.line_total AS REAL)) AS revenue,
        SUM(CAST(sl.quantity AS REAL) * CAST(a.cost_price AS REAL)) AS cost
      FROM sale_lines sl
      JOIN sales s ON s.id = sl.sale_id
      JOIN articles a ON a.id = sl.article_id
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY a.id, a.barcode, a.description, a.brand
      ORDER BY qty DESC
      LIMIT ?
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to, limit) as Array<{
      articleId: string;
      code: string;
      description: string;
      brand: string | null;
      qty: number;
      revenue: number;
      cost: number;
    }>;
    return rows.map((r) => {
      const margin = r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0;
      return {
        articleId: r.articleId,
        code: r.code,
        description: r.description,
        brand: r.brand,
        quantity: fmt(r.qty),
        revenue: fmt(r.revenue),
        marginPct: fmt(margin),
      };
    });
  }

  async getBottomSellingProducts(input: DateRange & { limit?: number }): Promise<TopProductRow[]> {
    this.requireRead();
    const limit = input.limit ?? 10;
    // LEFT JOIN para incluir artículos sin ventas
    const sql = `
      SELECT
        a.id AS articleId,
        a.barcode AS code,
        a.description AS description,
        a.brand AS brand,
        COALESCE(SUM(CAST(sl.quantity AS REAL)), 0) AS qty,
        COALESCE(SUM(CAST(sl.line_total AS REAL)), 0) AS revenue,
        COALESCE(SUM(CAST(sl.quantity AS REAL) * CAST(a.cost_price AS REAL)), 0) AS cost
      FROM articles a
      LEFT JOIN sale_lines sl ON sl.article_id = a.id
      LEFT JOIN sales s ON s.id = sl.sale_id AND s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      WHERE a.active = 1
      GROUP BY a.id, a.barcode, a.description, a.brand
      ORDER BY qty ASC
      LIMIT ?
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to, limit) as Array<{
      articleId: string;
      code: string;
      description: string;
      brand: string | null;
      qty: number;
      revenue: number;
      cost: number;
    }>;
    return rows.map((r) => {
      const margin = r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0;
      return {
        articleId: r.articleId,
        code: r.code,
        description: r.description,
        brand: r.brand,
        quantity: fmt(r.qty),
        revenue: fmt(r.revenue),
        marginPct: fmt(margin),
      };
    });
  }

  async getPaymentMethodsRanking(input: DateRange): Promise<PaymentMethodRankRow[]> {
    this.requireRead();
    const sql = `
      SELECT
        pm.id AS paymentMethodId,
        pm.name AS name,
        SUM(CAST(sp.amount AS REAL)) AS total,
        COUNT(DISTINCT sp.sale_id) AS salesCount
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      JOIN payment_methods pm ON pm.id = sp.payment_method_id
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY pm.id, pm.name
      ORDER BY total DESC
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to) as Array<{
      paymentMethodId: string;
      name: string;
      total: number;
      salesCount: number;
    }>;
    const grand = rows.reduce((acc, r) => acc + (r.total || 0), 0);
    return rows.map((r) => ({
      paymentMethodId: r.paymentMethodId,
      name: r.name,
      totalAmount: fmt(r.total),
      salesCount: r.salesCount,
      percentageOfTotal: fmt(grand > 0 ? (r.total / grand) * 100 : 0),
    }));
  }

  async getTopCustomers(input: DateRange & { limit?: number }): Promise<CustomerRankRow[]> {
    this.requireRead();
    const limit = input.limit ?? 10;
    const sql = `
      SELECT
        c.id AS customerId,
        c.last_name AS lastName,
        c.first_name AS firstName,
        COUNT(s.id) AS salesCount,
        SUM(CAST(s.total AS REAL)) AS total
      FROM sales s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY c.id, c.last_name, c.first_name
      ORDER BY total DESC
      LIMIT ?
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to, limit) as Array<{
      customerId: string;
      lastName: string;
      firstName: string | null;
      salesCount: number;
      total: number;
    }>;
    return rows.map((r) => ({
      customerId: r.customerId,
      fullName: r.firstName ? `${r.lastName}, ${r.firstName}` : r.lastName,
      salesCount: r.salesCount,
      totalAmount: fmt(r.total),
    }));
  }

  async getTopSuppliers(input: DateRange & { limit?: number }): Promise<SupplierRankRow[]> {
    this.requireRead();
    const limit = input.limit ?? 10;
    const sql = `
      SELECT
        sup.id AS supplierId,
        sup.name AS supplierName,
        COUNT(p.id) AS purchasesCount,
        SUM(CAST(p.total AS REAL)) AS total
      FROM purchases p
      JOIN suppliers sup ON sup.id = p.supplier_id
      WHERE p.status != 'voided'
        AND p.date BETWEEN ? AND ?
      GROUP BY sup.id, sup.name
      ORDER BY total DESC
      LIMIT ?
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to, limit) as Array<{
      supplierId: string;
      supplierName: string;
      purchasesCount: number;
      total: number;
    }>;
    return rows.map((r) => ({
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      purchasesCount: r.purchasesCount,
      totalAmount: fmt(r.total),
    }));
  }

  async getSalesTrend(
    input: DateRange & { granularity: 'daily' | 'weekly' | 'monthly' },
  ): Promise<SalesTrendRow[]> {
    this.requireRead();
    const fmtSpec =
      input.granularity === 'daily'
        ? "%Y-%m-%d"
        : input.granularity === 'weekly'
          ? "%Y-W%W"
          : "%Y-%m";
    const sql = `
      SELECT
        strftime('${fmtSpec}', s.date / 1000, 'unixepoch') AS bucket,
        COUNT(*) AS count,
        SUM(CAST(s.total AS REAL)) AS total
      FROM sales s
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to) as Array<{
      bucket: string;
      count: number;
      total: number;
    }>;
    return rows.map((r) => ({ bucket: r.bucket, count: r.count, total: fmt(r.total) }));
  }

  async getAverageTicket(input: DateRange): Promise<AverageTicketResult> {
    this.requireRead();
    const sql = `
      SELECT
        AVG(CAST(s.total AS REAL)) AS avg,
        MIN(CAST(s.total AS REAL)) AS min,
        MAX(CAST(s.total AS REAL)) AS max,
        COUNT(*) AS count
      FROM sales s
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
    `;
    const row = this.ctx.db.$client.prepare(sql).get(input.from, input.to) as {
      avg: number | null;
      min: number | null;
      max: number | null;
      count: number;
    };
    return {
      avg: fmt(row.avg),
      min: fmt(row.min),
      max: fmt(row.max),
      count: row.count,
    };
  }

  async getSalesByHour(input: DateRange): Promise<SalesByHourRow[]> {
    this.requireRead();
    const sql = `
      SELECT
        CAST(strftime('%H', s.date / 1000, 'unixepoch') AS INTEGER) AS hour,
        COUNT(*) AS count,
        SUM(CAST(s.total AS REAL)) AS total
      FROM sales s
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY hour
      ORDER BY hour ASC
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to) as Array<{
      hour: number;
      count: number;
      total: number;
    }>;
    return rows.map((r) => ({ hour: r.hour, count: r.count, total: fmt(r.total) }));
  }

  async getSalesByDayOfWeek(input: DateRange): Promise<SalesByDayOfWeekRow[]> {
    this.requireRead();
    const sql = `
      SELECT
        CAST(strftime('%w', s.date / 1000, 'unixepoch') AS INTEGER) AS dayOfWeek,
        COUNT(*) AS count,
        SUM(CAST(s.total AS REAL)) AS total
      FROM sales s
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY dayOfWeek
      ORDER BY dayOfWeek ASC
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to) as Array<{
      dayOfWeek: number;
      count: number;
      total: number;
    }>;
    return rows.map((r) => ({ dayOfWeek: r.dayOfWeek, count: r.count, total: fmt(r.total) }));
  }

  async getMarginByCategory(input: DateRange): Promise<MarginRow[]> {
    this.requireRead();
    const sql = `
      SELECT
        f.id AS familyId,
        COALESCE(f.name, '(Sin familia)') AS familyName,
        SUM(CAST(sl.line_total AS REAL)) AS revenue,
        SUM(CAST(sl.quantity AS REAL) * CAST(a.cost_price AS REAL)) AS cost
      FROM sale_lines sl
      JOIN sales s ON s.id = sl.sale_id
      JOIN articles a ON a.id = sl.article_id
      LEFT JOIN families f ON f.id = a.family_id
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY f.id, f.name
      ORDER BY revenue DESC
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to) as Array<{
      familyId: string | null;
      familyName: string;
      revenue: number;
      cost: number;
    }>;
    return rows.map((r) => {
      const margin = (r.revenue || 0) - (r.cost || 0);
      const marginPct = r.revenue > 0 ? (margin / r.revenue) * 100 : 0;
      return {
        familyId: r.familyId,
        familyName: r.familyName,
        revenue: fmt(r.revenue),
        cost: fmt(r.cost),
        margin: fmt(margin),
        marginPct: fmt(marginPct),
      };
    });
  }

  async getStockRotation(input: DateRange & { limit?: number }): Promise<StockRotationRow[]> {
    this.requireRead();
    const limit = input.limit ?? 20;
    const sql = `
      SELECT
        a.id AS articleId,
        a.description AS description,
        COALESCE(SUM(CAST(sl.quantity AS REAL)), 0) AS quantitySold,
        CAST(a.stock AS REAL) AS currentStock
      FROM articles a
      LEFT JOIN sale_lines sl ON sl.article_id = a.id
      LEFT JOIN sales s ON s.id = sl.sale_id AND s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      WHERE a.active = 1
      GROUP BY a.id, a.description, a.stock
      ORDER BY quantitySold DESC
      LIMIT ?
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to, limit) as Array<{
      articleId: string;
      description: string;
      quantitySold: number;
      currentStock: number;
    }>;
    return rows.map((r) => {
      const rotation = r.currentStock > 0 ? r.quantitySold / r.currentStock : r.quantitySold;
      return {
        articleId: r.articleId,
        description: r.description,
        quantitySold: fmt(r.quantitySold),
        currentStock: fmt(r.currentStock),
        rotation: fmt(rotation),
      };
    });
  }
}
