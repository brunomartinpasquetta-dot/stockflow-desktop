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
  /** null = el artículo no tiene costo cargado: no se puede calcular. */
  marginPct: string | null;
}

export interface PaymentMethodRankRow {
  paymentMethodId: string;
  name: string;
  totalAmount: string;
  salesCount: number;
  percentageOfTotal: string;
}

export interface VentaPorFormaPagoRow {
  paymentMethodId: string;
  name: string;
  isPhysicalCash: boolean;
  montoTotal: string;
  cantidadOperaciones: number;
  cantidadVentas: number;
  porcentajeDelTotal: string;
  ticketPromedio: string;
}

export interface VentaPorFormaPagoEnTiempoRow {
  bucket: string;
  paymentMethodId: string;
  name: string;
  monto: string;
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
  /** null = sin costo cargado en los artículos de la familia. */
  marginPct: string | null;
}

export interface StockRotationRow {
  articleId: string;
  description: string;
  quantitySold: string;
  currentStock: string;
  rotation: string;
}


export interface ResumenDiaSegmento {
  total: string;
  count: number;
}
export interface ResumenDelDiaResult {
  hoy: ResumenDiaSegmento;
  ayer: ResumenDiaSegmento;
  mismoDiaSemanaAnterior: ResumenDiaSegmento;
}

export interface AvanceDelMesInput {
  mesActual: DateRange;
  mesAnteriorParcial: DateRange;
  mesAnteriorCompleto: DateRange;
  diasTranscurridos: number;
  diasDelMes: number;
}
export interface AvanceDelMesResult {
  mesActual: string;
  mesAnteriorParcial: string;
  mesAnteriorCompleto: string;
  /** Cierre estimado al ritmo actual: mesActual / díasTranscurridos × díasDelMes. */
  proyeccionCierre: string;
  /** Variación % contra el mes anterior a la misma altura (null sin base). */
  variacionPct: string | null;
}

export interface ResultadoNetoResult {
  ventasNetas: string;
  /** Costo de mercadería vendida (costo congelado al vender; devoluciones no descontadas). */
  cmv: string;
  comisiones: string;
  resultado: string;
  margenPct: string | null;
}

export interface AntiguedadDeudaBucket {
  rango: string;
  monto: string;
  comprobantes: number;
}
export interface AntiguedadDeudaResult {
  total: string;
  clientesConDeuda: number;
  buckets: AntiguedadDeudaBucket[];
}

export interface ConversionPresupuestosResult {
  total: number;
  convertidos: number;
  aceptados: number;
  rechazados: number;
  pendientes: number;
  tasaConversionPct: string | null;
  montoConvertido: string;
}

export interface StockSinMovimientoRow {
  articleId: string;
  description: string;
  stock: string;
  capitalInmovilizado: string;
  ultimaVenta: number | null;
}
export interface StockSinMovimientoResult {
  capitalTotal: string;
  articulos: number;
  top: StockSinMovimientoRow[];
}

export interface VentasDeArticuloResult {
  cantidad: string;
  monto: string;
  operaciones: number;
  /** null = sin costo conocido. */
  margenPct: string | null;
}

export interface ReposicionPrioritariaRow {
  articleId: string;
  description: string;
  stock: string;
  minStock: string;
  vendidoEnRango: string;
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
        SUM(CAST(sl.quantity AS REAL) * CAST(COALESCE(sl.cost_at_sale, a.cost_price) AS REAL)) AS cost
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
      const sinCosto = (r.cost || 0) <= 0 && (r.revenue || 0) > 0;
      const margin = r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0;
      return {
        articleId: r.articleId,
        code: r.code,
        description: r.description,
        brand: r.brand,
        quantity: fmt(r.qty),
        revenue: fmt(r.revenue),
        marginPct: sinCosto ? null : fmt(margin),
      };
    });
  }

  async getBottomSellingProducts(input: DateRange & { limit?: number }): Promise<TopProductRow[]> {
    this.requireRead();
    const limit = input.limit ?? 10;
    // LEFT JOIN contra una SUBCONSULTA ya filtrada por rango y estado: con el
    // filtro en el ON del join de sales (como estaba), las sale_lines entraban
    // TODAS igual (con s NULL) y el selector de fechas no tenía efecto real —
    // el ranking sumaba la historia completa, anuladas incluidas.
    const sql = `
      SELECT
        a.id AS articleId,
        a.barcode AS code,
        a.description AS description,
        a.brand AS brand,
        COALESCE(v.qty, 0) AS qty,
        COALESCE(v.revenue, 0) AS revenue,
        COALESCE(v.qty, 0) * CAST(a.cost_price AS REAL) AS cost
      FROM articles a
      LEFT JOIN (
        SELECT sl.article_id,
               SUM(CAST(sl.quantity AS REAL)) AS qty,
               SUM(CAST(sl.line_total AS REAL)) AS revenue
        FROM sale_lines sl
        JOIN sales s ON s.id = sl.sale_id
        WHERE s.status != 'voided' AND s.date BETWEEN ? AND ?
        GROUP BY sl.article_id
      ) v ON v.article_id = a.id
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
      const sinCosto = (r.cost || 0) <= 0 && (r.revenue || 0) > 0;
      const margin = r.revenue > 0 ? ((r.revenue - r.cost) / r.revenue) * 100 : 0;
      return {
        articleId: r.articleId,
        code: r.code,
        description: r.description,
        brand: r.brand,
        quantity: fmt(r.qty),
        revenue: fmt(r.revenue),
        marginPct: sinCosto ? null : fmt(margin),
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

  /**
   * Ventas DESGLOSADAS por forma de pago. Trabaja sobre `sale_payments`, así que
   * los pagos MIXTOS (split: parte efectivo + parte tarjeta) reparten cada porción
   * a su medio. Las ventas a CUENTA CORRIENTE no tienen sale_payments (se cobran
   * después), así que se agregan como una línea sintética "Cuenta Corriente" con
   * el total de esas ventas → el total de TODOS los medios cuadra con el total de
   * ventas del período. Excluye anuladas (voided).
   */
  async getVentasPorFormaPago(input: DateRange): Promise<VentaPorFormaPagoRow[]> {
    this.requireRead();
    const sqlPagos = `
      SELECT
        pm.id AS paymentMethodId,
        pm.name AS name,
        pm.is_physical_cash AS isPhysicalCash,
        SUM(CAST(sp.amount AS REAL)) AS monto,
        COUNT(*) AS operaciones,
        COUNT(DISTINCT sp.sale_id) AS ventas
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      JOIN payment_methods pm ON pm.id = sp.payment_method_id
      WHERE s.status != 'voided'
        AND s.date BETWEEN ? AND ?
      GROUP BY pm.id, pm.name, pm.is_physical_cash
    `;
    const pagos = this.ctx.db.$client.prepare(sqlPagos).all(input.from, input.to) as Array<{
      paymentMethodId: string;
      name: string;
      isPhysicalCash: number;
      monto: number;
      operaciones: number;
      ventas: number;
    }>;
    // Cuenta corriente: ventas a crédito (sin pago al momento) → línea sintética.
    const sqlCtaCte = `
      SELECT SUM(CAST(s.total AS REAL)) AS monto, COUNT(*) AS ventas
      FROM sales s
      WHERE s.status != 'voided'
        AND s.is_account_sale = 1
        AND s.date BETWEEN ? AND ?
    `;
    const cc = this.ctx.db.$client.prepare(sqlCtaCte).get(input.from, input.to) as {
      monto: number | null;
      ventas: number;
    };

    const items = pagos.map((p) => ({
      paymentMethodId: p.paymentMethodId,
      name: p.name,
      isPhysicalCash: !!p.isPhysicalCash,
      monto: p.monto || 0,
      operaciones: p.operaciones,
      ventas: p.ventas,
    }));
    if (cc && (cc.monto || 0) > 0) {
      items.push({
        paymentMethodId: 'cuenta-corriente',
        name: 'Cuenta Corriente',
        isPhysicalCash: false,
        monto: cc.monto || 0,
        operaciones: cc.ventas,
        ventas: cc.ventas,
      });
    }
    const grand = items.reduce((acc, r) => acc + r.monto, 0);
    items.sort((a, b) => b.monto - a.monto);
    return items.map((r) => ({
      paymentMethodId: r.paymentMethodId,
      name: r.name,
      isPhysicalCash: r.isPhysicalCash,
      montoTotal: fmt(r.monto),
      cantidadOperaciones: r.operaciones,
      cantidadVentas: r.ventas,
      porcentajeDelTotal: fmt(grand > 0 ? (r.monto / grand) * 100 : 0),
      ticketPromedio: fmt(r.ventas > 0 ? r.monto / r.ventas : 0),
    }));
  }

  /**
   * Evolución temporal del monto por forma de pago (para gráfico de barras
   * apiladas / líneas). Formato LARGO: una fila por (bucket, medio). Incluye la
   * cuenta corriente como medio sintético (UNION) para consistencia con
   * getVentasPorFormaPago. Excluye anuladas.
   */
  async getVentasPorFormaPagoEnTiempo(
    input: DateRange & { granularity: 'daily' | 'weekly' | 'monthly' },
  ): Promise<VentaPorFormaPagoEnTiempoRow[]> {
    this.requireRead();
    const fmtSpec =
      input.granularity === 'daily' ? '%Y-%m-%d' : input.granularity === 'weekly' ? '%Y-W%W' : '%Y-%m';
    const sql = `
      SELECT bucket, paymentMethodId, name, SUM(monto) AS monto FROM (
        SELECT
          strftime('${fmtSpec}', s.date / 1000, 'unixepoch', 'localtime') AS bucket,
          pm.id AS paymentMethodId,
          pm.name AS name,
          CAST(sp.amount AS REAL) AS monto
        FROM sale_payments sp
        JOIN sales s ON s.id = sp.sale_id
        JOIN payment_methods pm ON pm.id = sp.payment_method_id
        WHERE s.status != 'voided' AND s.date BETWEEN ? AND ?
        UNION ALL
        SELECT
          strftime('${fmtSpec}', s.date / 1000, 'unixepoch', 'localtime') AS bucket,
          'cuenta-corriente' AS paymentMethodId,
          'Cuenta Corriente' AS name,
          CAST(s.total AS REAL) AS monto
        FROM sales s
        WHERE s.status != 'voided' AND s.is_account_sale = 1 AND s.date BETWEEN ? AND ?
      )
      GROUP BY bucket, paymentMethodId, name
      ORDER BY bucket ASC
    `;
    const rows = this.ctx.db.$client
      .prepare(sql)
      .all(input.from, input.to, input.from, input.to) as Array<{
      bucket: string;
      paymentMethodId: string;
      name: string;
      monto: number;
    }>;
    return rows.map((r) => ({
      bucket: r.bucket,
      paymentMethodId: r.paymentMethodId,
      name: r.name,
      monto: fmt(r.monto),
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
    // VENTAS NETAS: las devoluciones restan en el bucket del día en que se
    // hicieron (antes todo era venta bruta y el KPI sobreestimaba). El count
    // sigue siendo la cantidad de VENTAS (operaciones), no se mezcla.
    const sql = `
      SELECT bucket, SUM(cnt) AS count, SUM(total) AS total FROM (
        SELECT
          strftime('${fmtSpec}', s.date / 1000, 'unixepoch', 'localtime') AS bucket,
          1 AS cnt,
          CAST(s.total AS REAL) AS total
        FROM sales s
        WHERE s.status != 'voided' AND s.date BETWEEN ? AND ?
        UNION ALL
        SELECT
          strftime('${fmtSpec}', r.date / 1000, 'unixepoch', 'localtime') AS bucket,
          0 AS cnt,
          -CAST(r.total AS REAL) AS total
        FROM returns r
        WHERE r.date BETWEEN ? AND ?
      )
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to, input.from, input.to) as Array<{
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
        CAST(strftime('%H', s.date / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
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
        CAST(strftime('%w', s.date / 1000, 'unixepoch', 'localtime') AS INTEGER) AS dayOfWeek,
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
        SUM(CAST(sl.quantity AS REAL) * CAST(COALESCE(sl.cost_at_sale, a.cost_price) AS REAL)) AS cost
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
      // Sin costo cargado el "margen" daría 100% (mentira): se informa null y
      // la pantalla lo muestra como "s/costo" en lugar de inflar la ganancia.
      const sinCosto = (r.cost || 0) <= 0 && (r.revenue || 0) > 0;
      const marginPct = r.revenue > 0 ? (margin / r.revenue) * 100 : 0;
      return {
        familyId: r.familyId,
        familyName: r.familyName,
        revenue: fmt(r.revenue),
        cost: fmt(r.cost),
        margin: sinCosto ? fmt(0) : fmt(margin),
        marginPct: sinCosto ? null : fmt(marginPct),
      };
    });
  }

  async getStockRotation(input: DateRange & { limit?: number }): Promise<StockRotationRow[]> {
    this.requireRead();
    const limit = input.limit ?? 20;
    // Mismo fix que en getBottomSellingProducts: el filtro va en una
    // subconsulta, no en el ON — si no, suma la historia completa.
    const sql = `
      SELECT
        a.id AS articleId,
        a.description AS description,
        COALESCE(v.qty, 0) AS quantitySold,
        CAST(a.stock AS REAL) AS currentStock
      FROM articles a
      LEFT JOIN (
        SELECT sl.article_id, SUM(CAST(sl.quantity AS REAL)) AS qty
        FROM sale_lines sl
        JOIN sales s ON s.id = sl.sale_id
        WHERE s.status != 'voided' AND s.date BETWEEN ? AND ?
        GROUP BY sl.article_id
      ) v ON v.article_id = a.id
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
  /** Total NETO (ventas − devoluciones) y operaciones de un rango. */
  private netoDeRango(range: DateRange): { total: number; count: number } {
    const v = this.ctx.db.$client
      .prepare(`SELECT COALESCE(SUM(CAST(total AS REAL)), 0) AS t, COUNT(*) AS c FROM sales WHERE status != 'voided' AND date BETWEEN ? AND ?`)
      .get(range.from, range.to) as { t: number; c: number };
    const d = this.ctx.db.$client
      .prepare(`SELECT COALESCE(SUM(CAST(total AS REAL)), 0) AS t FROM returns WHERE date BETWEEN ? AND ?`)
      .get(range.from, range.to) as { t: number };
    return { total: (v.t || 0) - (d.t || 0), count: v.c || 0 };
  }

  /** Resumen del día: hoy, ayer y el mismo día de la semana anterior (rangos armados por el llamador en hora local). */
  async getResumenDelDia(input: { hoy: DateRange; ayer: DateRange; mismoDiaSemanaAnterior: DateRange }): Promise<ResumenDelDiaResult> {
    this.requireRead();
    const seg = (r: DateRange): ResumenDiaSegmento => {
      const n = this.netoDeRango(r);
      return { total: fmt(n.total), count: n.count };
    };
    return {
      hoy: seg(input.hoy),
      ayer: seg(input.ayer),
      mismoDiaSemanaAnterior: seg(input.mismoDiaSemanaAnterior),
    };
  }

  /** Avance del mes con proyección de cierre al ritmo de venta actual. */
  async getAvanceDelMes(input: AvanceDelMesInput): Promise<AvanceDelMesResult> {
    this.requireRead();
    const actual = this.netoDeRango(input.mesActual).total;
    const anteriorParcial = this.netoDeRango(input.mesAnteriorParcial).total;
    const anteriorCompleto = this.netoDeRango(input.mesAnteriorCompleto).total;
    const dias = Math.max(1, input.diasTranscurridos);
    const proyeccion = (actual / dias) * Math.max(dias, input.diasDelMes);
    const variacion = anteriorParcial > 0 ? ((actual - anteriorParcial) / anteriorParcial) * 100 : null;
    return {
      mesActual: fmt(actual),
      mesAnteriorParcial: fmt(anteriorParcial),
      mesAnteriorCompleto: fmt(anteriorCompleto),
      proyeccionCierre: fmt(proyeccion),
      variacionPct: variacion == null ? null : fmt(variacion),
    };
  }

  /**
   * Resultado neto del período: ventas netas − CMV − comisiones de medios.
   * CMV con costo congelado al vender (COALESCE al costo actual para ventas
   * previas a la migración 0024). Las devoluciones restan de las ventas pero
   * no del CMV (no registran costo): resultado levemente conservador.
   */
  async getResultadoNeto(input: DateRange): Promise<ResultadoNetoResult> {
    this.requireRead();
    const ventasNetas = this.netoDeRango(input).total;
    const cmvRow = this.ctx.db.$client
      .prepare(`
        SELECT COALESCE(SUM(CAST(sl.quantity AS REAL) * CAST(COALESCE(sl.cost_at_sale, a.cost_price) AS REAL)), 0) AS cmv
        FROM sale_lines sl
        JOIN sales s ON s.id = sl.sale_id
        LEFT JOIN articles a ON a.id = sl.article_id
        WHERE s.status != 'voided' AND s.date BETWEEN ? AND ?
      `)
      .get(input.from, input.to) as { cmv: number };
    const comRow = this.ctx.db.$client
      .prepare(`
        SELECT COALESCE(SUM(CAST(sp.commission_amount AS REAL)), 0) AS com
        FROM sale_payments sp
        JOIN sales s ON s.id = sp.sale_id
        WHERE s.status != 'voided' AND s.date BETWEEN ? AND ?
      `)
      .get(input.from, input.to) as { com: number };
    const resultado = ventasNetas - (cmvRow.cmv || 0) - (comRow.com || 0);
    return {
      ventasNetas: fmt(ventasNetas),
      cmv: fmt(cmvRow.cmv),
      comisiones: fmt(comRow.com),
      resultado: fmt(resultado),
      margenPct: ventasNetas > 0 ? fmt((resultado / ventasNetas) * 100) : null,
    };
  }

  /** Antigüedad de la deuda de clientes: saldos abiertos por edad del comprobante. */
  async getAntiguedadDeuda(): Promise<AntiguedadDeudaResult> {
    this.requireRead();
    const rows = this.ctx.db.$client
      .prepare(`
        SELECT
          CASE
            WHEN (? - created_at) <= 30 * 86400000 THEN '0-30'
            WHEN (? - created_at) <= 60 * 86400000 THEN '31-60'
            WHEN (? - created_at) <= 90 * 86400000 THEN '61-90'
            ELSE '+90'
          END AS rango,
          SUM(CAST(balance AS REAL)) AS monto,
          COUNT(*) AS comprobantes
        FROM accounts_receivable
        WHERE status != 'paid' AND CAST(balance AS REAL) > 0.005
        GROUP BY rango
      `)
      .all(Date.now(), Date.now(), Date.now()) as Array<{ rango: string; monto: number; comprobantes: number }>;
    const orden = ['0-30', '31-60', '61-90', '+90'];
    const porRango = new Map(rows.map((r) => [r.rango, r]));
    const clientes = this.ctx.db.$client
      .prepare(`SELECT COUNT(DISTINCT customer_id) AS c FROM accounts_receivable WHERE status != 'paid' AND CAST(balance AS REAL) > 0.005`)
      .get() as { c: number };
    return {
      total: fmt(rows.reduce((acc, r) => acc + (r.monto || 0), 0)),
      clientesConDeuda: clientes.c || 0,
      buckets: orden.map((rango) => ({
        rango: rango === '+90' ? 'Más de 90 días' : `${rango} días`,
        monto: fmt(porRango.get(rango)?.monto ?? 0),
        comprobantes: porRango.get(rango)?.comprobantes ?? 0,
      })),
    };
  }

  /** Conversión de presupuestos del rango: cuántos terminan en venta. */
  async getConversionPresupuestos(input: DateRange): Promise<ConversionPresupuestosResult> {
    this.requireRead();
    const rows = this.ctx.db.$client
      .prepare(`SELECT status, COUNT(*) AS c, COALESCE(SUM(CAST(total AS REAL)), 0) AS t FROM quotes WHERE date BETWEEN ? AND ? GROUP BY status`)
      .all(input.from, input.to) as Array<{ status: string; c: number; t: number }>;
    const por = new Map(rows.map((r) => [r.status, r]));
    const total = rows.reduce((acc, r) => acc + r.c, 0);
    const convertidos = por.get('converted')?.c ?? 0;
    return {
      total,
      convertidos,
      aceptados: por.get('accepted')?.c ?? 0,
      rechazados: por.get('rejected')?.c ?? 0,
      pendientes: por.get('pending')?.c ?? 0,
      tasaConversionPct: total > 0 ? fmt((convertidos / total) * 100) : null,
      montoConvertido: fmt(por.get('converted')?.t ?? 0),
    };
  }

  /** Stock sin movimiento: capital inmovilizado en artículos sin ventas en N días. */
  async getStockSinMovimiento(input: { dias?: number; limit?: number }): Promise<StockSinMovimientoResult> {
    this.requireRead();
    const dias = input.dias ?? 90;
    const limit = input.limit ?? 20;
    const desde = Date.now() - dias * 86400000;
    const sql = `
      SELECT
        a.id AS articleId,
        a.description AS description,
        CAST(a.stock AS REAL) AS stock,
        CAST(a.stock AS REAL) * CAST(a.cost_price AS REAL) AS capital,
        v.ultimaVenta AS ultimaVenta
      FROM articles a
      LEFT JOIN (
        SELECT sl.article_id, MAX(s.date) AS ultimaVenta
        FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        WHERE s.status != 'voided'
        GROUP BY sl.article_id
      ) v ON v.article_id = a.id
      WHERE a.active = 1 AND CAST(a.stock AS REAL) > 0
        AND (v.ultimaVenta IS NULL OR v.ultimaVenta < ?)
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(desde) as Array<{
      articleId: string;
      description: string;
      stock: number;
      capital: number;
      ultimaVenta: number | null;
    }>;
    const capitalTotal = rows.reduce((acc, r) => acc + (r.capital || 0), 0);
    const top = rows
      .sort((x, y) => (y.capital || 0) - (x.capital || 0))
      .slice(0, limit)
      .map((r) => ({
        articleId: r.articleId,
        description: r.description,
        stock: fmt(r.stock),
        capitalInmovilizado: fmt(r.capital),
        ultimaVenta: r.ultimaVenta,
      }));
    return { capitalTotal: fmt(capitalTotal), articulos: rows.length, top };
  }

  /** Reposición prioritaria: bajo el stock mínimo Y con ventas en el rango. */
  async getReposicionPrioritaria(input: DateRange & { limit?: number }): Promise<ReposicionPrioritariaRow[]> {
    this.requireRead();
    const limit = input.limit ?? 20;
    const sql = `
      SELECT
        a.id AS articleId,
        a.description AS description,
        CAST(a.stock AS REAL) AS stock,
        CAST(a.min_stock AS REAL) AS minStock,
        v.qty AS vendido
      FROM articles a
      JOIN (
        SELECT sl.article_id, SUM(CAST(sl.quantity AS REAL)) AS qty
        FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        WHERE s.status != 'voided' AND s.date BETWEEN ? AND ?
        GROUP BY sl.article_id
      ) v ON v.article_id = a.id
      WHERE a.active = 1
        AND CAST(a.min_stock AS REAL) > 0
        AND CAST(a.stock AS REAL) <= CAST(a.min_stock AS REAL)
      ORDER BY v.qty DESC
      LIMIT ?
    `;
    const rows = this.ctx.db.$client.prepare(sql).all(input.from, input.to, limit) as Array<{
      articleId: string;
      description: string;
      stock: number;
      minStock: number;
      vendido: number;
    }>;
    return rows.map((r) => ({
      articleId: r.articleId,
      description: r.description,
      stock: fmt(r.stock),
      minStock: fmt(r.minStock),
      vendidoEnRango: fmt(r.vendido),
    }));
  }
  /** Ventas de UN artículo en el rango: cantidad, monto, operaciones y margen. */
  async getVentasDeArticulo(input: DateRange & { articleId: string }): Promise<VentasDeArticuloResult> {
    this.requireRead();
    const row = this.ctx.db.$client
      .prepare(`
        SELECT
          COALESCE(SUM(CAST(sl.quantity AS REAL)), 0) AS cantidad,
          COALESCE(SUM(CAST(sl.line_total AS REAL)), 0) AS monto,
          COUNT(DISTINCT sl.sale_id) AS operaciones,
          COALESCE(SUM(CAST(sl.quantity AS REAL) * CAST(COALESCE(sl.cost_at_sale, a.cost_price) AS REAL)), 0) AS costo
        FROM sale_lines sl
        JOIN sales s ON s.id = sl.sale_id
        JOIN articles a ON a.id = sl.article_id
        WHERE sl.article_id = ? AND s.status != 'voided' AND s.date BETWEEN ? AND ?
      `)
      .get(input.articleId, input.from, input.to) as { cantidad: number; monto: number; operaciones: number; costo: number };
    const sinCosto = (row.costo || 0) <= 0 && (row.monto || 0) > 0;
    const margen = row.monto > 0 ? ((row.monto - row.costo) / row.monto) * 100 : 0;
    return {
      cantidad: fmt(row.cantidad),
      monto: fmt(row.monto),
      operaciones: row.operaciones || 0,
      margenPct: sinCosto ? null : fmt(margen),
    };
  }
}
