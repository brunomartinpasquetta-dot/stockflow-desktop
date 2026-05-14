/**
 * Servicio Contable (sólo lectura). Requiere permiso `view_accounting`.
 *
 * Provee:
 *  - Resumen financiero (activos, ventas, compras, CMV, resultado bruto, posición IVA).
 *  - Libro IVA Ventas (alícuotas discriminadas por línea).
 *  - Libro IVA Compras (idem).
 *
 * Limitación conocida: el CMV se calcula con `articles.costPrice` actual (no
 * histórico). Se indica al consumidor con `cmv.calculatedFromCurrent = true`.
 */
import { sumDecimals, subDecimal, mulDecimal, vatBreakdown, type PriceMode } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';

export interface FinancialSummary {
  period: { from: number; to: number };
  assets: { articlesValue: string; cashValue: string; total: string };
  sales: { total: string; count: number; vatAmount: string };
  purchases: { total: string; count: number; vatAmount: string };
  cmv: { total: string; calculatedFromCurrent: boolean };
  grossResult: string;
  grossMarginPct: string;
  vatPosition: string;
}

export interface VatBookSaleRow {
  saleId: string;
  date: number;
  type: 'A' | 'B' | 'C' | 'X';
  number: number;
  customerName: string;
  customerCuit: string | null;
  netAmount: string;
  vat21: string;
  vat105: string;
  vat27: string;
  total: string;
  status: 'completed' | 'voided' | 'pending';
}

export interface VatBookPurchaseRow {
  purchaseId: string;
  date: number;
  type: 'A' | 'B' | 'C' | 'X';
  supplierInvoiceNumber: string;
  supplierName: string;
  supplierCuit: string | null;
  netAmount: string;
  vat21: string;
  vat105: string;
  vat27: string;
  total: string;
  status: 'completed' | 'voided' | 'pending';
}

function vatBucketKey(rate: string | number): 'vat21' | 'vat105' | 'vat27' | null {
  const r = Number(rate);
  if (r === 21) return 'vat21';
  if (r === 10.5) return 'vat105';
  if (r === 27) return 'vat27';
  return null;
}

export class AccountingService {
  constructor(private readonly ctx: ServiceContext) {}

  private requireView(): void {
    requirePermission(this.ctx.currentUser, 'view_accounting');
  }

  private async getPriceMode(): Promise<PriceMode> {
    const c = await this.ctx.repos.company.getOrCreate();
    return c.priceMode === 'net' ? 'net' : 'gross';
  }

  async getFinancialSummary(input: { from: number; to: number }): Promise<FinancialSummary> {
    this.requireView();
    const { from, to } = input;

    const priceMode = await this.getPriceMode();

    // 1) Activos
    const articles = await this.ctx.repos.articles.findAll();
    let articlesValue = '0.0000';
    for (const a of articles) {
      if (a.active === false) continue;
      articlesValue = sumDecimals([articlesValue, mulDecimal(a.stock, a.costPrice, 4)]);
    }

    // Efectivo: aperturas de cajas abiertas + saldo de movimientos cash en cajas abiertas
    const allRegisters = await this.ctx.repos.cashRegisters.findAll();
    const openRegs = allRegisters.filter((r) => r.status === 'open');
    let cashValue = '0.0000';
    if (openRegs.length > 0) {
      const allPms = await this.ctx.repos.paymentMethods.findAll();
      const cashPmIds = new Set(allPms.filter((p) => p.type === 'cash').map((p) => p.id));
      cashValue = sumDecimals(openRegs.map((r) => r.openingAmount));
      for (const reg of openRegs) {
        const movs = await this.ctx.repos.cashMovements.findByRegister(reg.id);
        for (const m of movs) {
          if (!m.paymentMethodId || !cashPmIds.has(m.paymentMethodId)) continue;
          if (m.type === 'income') cashValue = sumDecimals([cashValue, m.amount]);
          else cashValue = subDecimal(cashValue, m.amount);
        }
      }
    }
    const assetsTotal = sumDecimals([articlesValue, cashValue]);

    // 2) Ventas
    const salesAll = await this.ctx.repos.sales.findByDateRange(from, to);
    const salesCompleted = salesAll.filter((s) => s.status === 'completed');
    const salesIds = salesCompleted.map((s) => s.id);
    const saleLinesAll = await this.ctx.repos.saleLines.findAll();
    const salesLinesByCompleted = saleLinesAll.filter((l) => salesIds.includes(l.saleId));
    let salesVat = '0.0000';
    for (const l of salesLinesByCompleted) {
      const br = vatBreakdown(l.lineTotal, l.vatRate, priceMode);
      salesVat = sumDecimals([salesVat, br.vat]);
    }
    const salesTotal = sumDecimals(salesCompleted.map((s) => s.total));

    // 3) Compras
    const purchasesAll = await this.ctx.repos.purchases.findByDateRange(from, to);
    const purchasesCompleted = purchasesAll.filter((p) => p.status === 'completed');
    const purchaseIds = purchasesCompleted.map((p) => p.id);
    let purchasesVat = '0.0000';
    for (const pid of purchaseIds) {
      const lines = await this.ctx.repos.purchaseLines.findByPurchase(pid);
      for (const l of lines) {
        const br = vatBreakdown(l.lineTotal, l.vatRate, priceMode);
        purchasesVat = sumDecimals([purchasesVat, br.vat]);
      }
    }
    const purchasesTotal = sumDecimals(purchasesCompleted.map((p) => p.total));

    // 4) CMV (con costo ACTUAL — limitación documentada)
    const articleCostById = new Map(articles.map((a) => [a.id, a.costPrice]));
    let cmv = '0.0000';
    for (const l of salesLinesByCompleted) {
      const cost = articleCostById.get(l.articleId) ?? '0.0000';
      cmv = sumDecimals([cmv, mulDecimal(l.quantity, cost, 4)]);
    }

    // 5) Resultado bruto
    const grossResult = subDecimal(salesTotal, cmv);
    const salesNum = Number(salesTotal);
    const grossMarginPct = salesNum > 0
      ? ((Number(grossResult) / salesNum) * 100).toFixed(2)
      : '0.00';

    // 6) Posición IVA
    const vatPosition = subDecimal(salesVat, purchasesVat);

    return {
      period: { from, to },
      assets: { articlesValue, cashValue, total: assetsTotal },
      sales: { total: salesTotal, count: salesCompleted.length, vatAmount: salesVat },
      purchases: { total: purchasesTotal, count: purchasesCompleted.length, vatAmount: purchasesVat },
      cmv: { total: cmv, calculatedFromCurrent: true },
      grossResult,
      grossMarginPct,
      vatPosition,
    };
  }

  async getVatBookSales(input: {
    from: number;
    to: number;
    type?: 'A' | 'B' | 'C' | 'X' | 'all';
  }): Promise<VatBookSaleRow[]> {
    this.requireView();
    const priceMode = await this.getPriceMode();
    const filter = input.type ?? 'all';

    let sales = await this.ctx.repos.sales.findByDateRange(input.from, input.to);
    if (filter !== 'all') sales = sales.filter((s) => s.type === filter);

    const customers = await this.ctx.repos.customers.findAll();
    const customerById = new Map(customers.map((c) => [c.id, c]));

    const allLines = await this.ctx.repos.saleLines.findAll();
    const linesBySale = new Map<string, typeof allLines>();
    for (const l of allLines) {
      const arr = linesBySale.get(l.saleId);
      if (arr) arr.push(l);
      else linesBySale.set(l.saleId, [l]);
    }

    const rows: VatBookSaleRow[] = sales.map((s) => {
      const c = customerById.get(s.customerId);
      const customerName = c
        ? c.lastName + (c.firstName ? `, ${c.firstName}` : '')
        : '—';
      const customerCuit = c && c.docType === 'CUIT' ? c.docNumber : null;

      let netAmount = '0.0000';
      let vat21 = '0.0000';
      let vat105 = '0.0000';
      let vat27 = '0.0000';
      const lines = linesBySale.get(s.id) ?? [];
      for (const l of lines) {
        const br = vatBreakdown(l.lineTotal, l.vatRate, priceMode);
        netAmount = sumDecimals([netAmount, br.net]);
        const key = vatBucketKey(l.vatRate);
        if (key === 'vat21') vat21 = sumDecimals([vat21, br.vat]);
        else if (key === 'vat105') vat105 = sumDecimals([vat105, br.vat]);
        else if (key === 'vat27') vat27 = sumDecimals([vat27, br.vat]);
      }

      return {
        saleId: s.id,
        date: s.date,
        type: s.type,
        number: s.number,
        customerName,
        customerCuit,
        netAmount,
        vat21,
        vat105,
        vat27,
        total: s.total,
        status: s.status,
      };
    });

    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date - b.date;
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.number - b.number;
    });
    return rows;
  }

  async getVatBookPurchases(input: { from: number; to: number }): Promise<VatBookPurchaseRow[]> {
    this.requireView();
    const priceMode = await this.getPriceMode();

    const purchases = await this.ctx.repos.purchases.findByDateRange(input.from, input.to);
    const suppliers = await this.ctx.repos.suppliers.findAll();
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));

    const rows: VatBookPurchaseRow[] = [];
    for (const p of purchases) {
      const sup = supplierById.get(p.supplierId);
      const supplierName = sup?.name ?? '—';
      const supplierCuit = sup?.cuit ?? null;
      const lines = await this.ctx.repos.purchaseLines.findByPurchase(p.id);
      let netAmount = '0.0000';
      let vat21 = '0.0000';
      let vat105 = '0.0000';
      let vat27 = '0.0000';
      for (const l of lines) {
        const br = vatBreakdown(l.lineTotal, l.vatRate, priceMode);
        netAmount = sumDecimals([netAmount, br.net]);
        const key = vatBucketKey(l.vatRate);
        if (key === 'vat21') vat21 = sumDecimals([vat21, br.vat]);
        else if (key === 'vat105') vat105 = sumDecimals([vat105, br.vat]);
        else if (key === 'vat27') vat27 = sumDecimals([vat27, br.vat]);
      }
      rows.push({
        purchaseId: p.id,
        date: p.date,
        type: p.type,
        supplierInvoiceNumber: p.supplierInvoiceNumber ?? '',
        supplierName,
        supplierCuit,
        netAmount,
        vat21,
        vat105,
        vat27,
        total: p.total,
        status: p.status,
      });
    }

    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date - b.date;
      return a.supplierInvoiceNumber.localeCompare(b.supplierInvoiceNumber);
    });
    return rows;
  }
}
