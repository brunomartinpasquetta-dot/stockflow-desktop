/**
 * Servicio de cuentas corrientes con proveedores: pagos y estados de cuenta.
 */
import type { Purchase, Supplier, SupplierAccountPayable, SupplierPayment } from '@stockflow/shared';
import { addDecimal, cmpDecimal, subDecimal, sumDecimals } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors';

/** Una línea de pago a proveedor (un medio de pago + monto). */
export interface SupplierPaymentDraft {
  paymentMethodId: string;
  amount: string;
  reference?: string | null;
}

export interface PaySupplierInvoiceInput {
  accountId: string;
  payments: SupplierPaymentDraft[];
  /** Si se indica, la suma de los pagos debe coincidir exactamente con este monto. */
  expectedAmount?: string;
  notes?: string | null;
  /** Caja donde impacta el egreso (default: caja activa / caja abierta). */
  cashRegisterId?: string;
  /**
   * De dónde sale el dinero: 'daily' (caja diaria, default, exige caja
   * abierta) o 'general' (Caja General — no exige caja diaria y valida saldo).
   * Mismo patrón que las compras contado.
   */
  fundingSource?: 'daily' | 'general';
}

export interface PaySupplierInvoiceResult {
  payments: SupplierPayment[];
  account: SupplierAccountPayable;
}

/** Pago a NIVEL CUENTA de proveedor: se aplica al saldo total (FIFO). */
export interface PayToSupplierInput {
  supplierId: string;
  payments: SupplierPaymentDraft[];
  /** Si se indica, la suma de los pagos debe coincidir exactamente con este monto. */
  expectedAmount?: string;
  notes?: string | null;
  cashRegisterId?: string;
  /** De dónde sale el dinero ('daily' default | 'general'). Ver PaySupplierInvoiceInput. */
  fundingSource?: 'daily' | 'general';
}

export interface PayToSupplierResult {
  payments: SupplierPayment[];
  /** Comprobantes afectados, con su balance/status ya actualizados. */
  accounts: SupplierAccountPayable[];
  totalApplied: string;
}

export interface SupplierStatementEntry {
  date: number;
  kind: 'purchase' | 'payment' | 'return';
  reference: string;
  /** importe que aumenta la deuda (compras a cuenta) */
  debit: string;
  /** importe que disminuye la deuda (pagos) */
  credit: string;
  runningBalance: string;
  /** nombre del medio de pago (sólo en pagos). */
  paymentMethodName: string | null;
  /** saldo del comprobante luego de este pago (sólo en pagos). */
  comprobanteBalance: string | null;
  /** compra asociada (para lanzar una devolución desde el estado de cuenta). */
  purchaseId: string | null;
}

export interface SupplierStatement {
  supplier: Supplier;
  entries: SupplierStatementEntry[];
  currentBalance: string;
}

export interface SupplierBalance {
  supplierId: string;
  supplierName: string;
  totalDebt: string;
  openInvoicesCount: number;
  phone: string | null;
}

/** Una línea de la compra con la descripción/marca del artículo resueltas. */
export interface SupplierAccountDetailLine {
  id: string;
  purchaseId: string;
  articleId: string;
  lineNumber: number;
  quantity: string;
  costPrice: string;
  salePrice: string;
  vatRate: string;
  lineTotal: string;
  createdAt: number;
  description: string;
  brand: string | null;
}

/** Un pago aplicado a la cuenta con el nombre del medio de pago. */
export interface SupplierAccountDetailPayment extends SupplierPayment {
  paymentMethodName: string;
}

/** Detalle completo de una cuenta de proveedor: compra, líneas y pagos. */
export interface SupplierAccountPayableDetail {
  account: SupplierAccountPayable;
  purchase: Purchase | null;
  lines: SupplierAccountDetailLine[];
  payments: SupplierAccountDetailPayment[];
}

export class SupplierAccountsService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Deuda por proveedor (sólo los que se les debe), con nombre. */
  async listSupplierBalances(): Promise<SupplierBalance[]> {
    const { repos } = this.ctx;
    const [balances, suppliers] = await Promise.all([
      repos.supplierAccountsPayable.listBalances(),
      repos.suppliers.findAll(),
    ]);
    const nameById = new Map(suppliers.map((s) => [s.id, `${s.code} — ${s.name}`]));
    const phoneById = new Map(suppliers.map((s) => [s.id, s.mobile ?? s.phone ?? null]));
    // Incluye proveedores con cuenta saldada (deuda $0) para que una cuenta
    // cancelada en su totalidad no desaparezca de la lista.
    return balances
      .map((b) => ({
        supplierId: b.supplierId,
        supplierName: nameById.get(b.supplierId) ?? b.supplierId,
        totalDebt: b.totalDebt,
        openInvoicesCount: b.openInvoicesCount,
        phone: phoneById.get(b.supplierId) ?? null,
      }));
  }

  async listOpenBySupplier(supplierId: string): Promise<SupplierAccountPayable[]> {
    return this.ctx.repos.supplierAccountsPayable.findOpenBySupplier(supplierId);
  }

  /** Registra un pago (posiblemente mixto) a una cuenta de proveedor. */
  async payInvoice(input: PaySupplierInvoiceInput): Promise<PaySupplierInvoiceResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_supplier_accounts');

    const account = await repos.supplierAccountsPayable.findById(input.accountId);
    if (!account) throw new NotFoundError('Cuenta de proveedor', input.accountId);
    if (input.payments.length === 0) {
      throw new BusinessRuleError('no_payment_lines', 'Hay que registrar al menos un pago');
    }
    const totalPaid = sumDecimals(input.payments.map((p) => p.amount));
    if (cmpDecimal(totalPaid, '0') <= 0) {
      throw new BusinessRuleError('invalid_payment_amount', 'El monto pagado debe ser positivo');
    }
    if (input.expectedAmount != null) {
      const cmp = cmpDecimal(totalPaid, input.expectedAmount);
      if (cmp > 0) throw new ValidationError('payments', 'Los pagos exceden el monto a pagar');
      if (cmp < 0) throw new ValidationError('payments', 'Los pagos no cubren el monto a pagar');
    }
    if (cmpDecimal(totalPaid, account.balance) > 0) {
      throw new BusinessRuleError(
        'payment_exceeds_balance',
        `El pago (${totalPaid}) supera el saldo de la cuenta (${account.balance})`,
      );
    }

    const fundingSource: 'daily' | 'general' = input.fundingSource === 'general' ? 'general' : 'daily';
    const cashRegisterId = await this.resolveFunding(fundingSource, input.cashRegisterId, totalPaid);

    const payments = await repos.supplierPayments.createPayment({
      accountId: input.accountId,
      payments: input.payments.map((p) => ({
        paymentMethodId: p.paymentMethodId,
        amount: p.amount,
        reference: p.reference ?? null,
      })),
      notes: input.notes ?? null,
      cashRegisterId,
      fundingSource,
      userId: currentUser.id,
    });
    const updatedAccount = await repos.supplierAccountsPayable.findById(input.accountId);
    if (!updatedAccount) throw new NotFoundError('Cuenta de proveedor', input.accountId);
    return { payments, account: updatedAccount };
  }

  /**
   * Registra un pago a NIVEL CUENTA de proveedor: el monto se aplica al saldo
   * total del proveedor, distribuyéndose automáticamente entre sus comprobantes
   * abiertos en orden FIFO (del más viejo al más nuevo). El repositorio hace la
   * transacción atómica. No rompe el pago per-comprobante (`payInvoice`).
   */
  async payToSupplier(input: PayToSupplierInput): Promise<PayToSupplierResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_supplier_accounts');

    const supplier = await repos.suppliers.findById(input.supplierId);
    if (!supplier) throw new NotFoundError('Proveedor', input.supplierId);
    if (input.payments.length === 0) {
      throw new BusinessRuleError('no_payment_lines', 'Hay que registrar al menos un pago');
    }
    const totalPaid = sumDecimals(input.payments.map((p) => p.amount));
    if (cmpDecimal(totalPaid, '0') <= 0) {
      throw new BusinessRuleError('invalid_payment_amount', 'El monto pagado debe ser positivo');
    }
    if (input.expectedAmount != null) {
      const cmp = cmpDecimal(totalPaid, input.expectedAmount);
      if (cmp > 0) throw new ValidationError('payments', 'Los pagos exceden el monto a pagar');
      if (cmp < 0) throw new ValidationError('payments', 'Los pagos no cubren el monto a pagar');
    }

    const totalOpen = await repos.supplierAccountsPayable.getTotalBalance(input.supplierId);
    if (cmpDecimal(totalPaid, totalOpen) > 0) {
      throw new BusinessRuleError(
        'payment_exceeds_balance',
        `El pago (${totalPaid}) supera el saldo total del proveedor (${totalOpen})`,
      );
    }

    const fundingSource: 'daily' | 'general' = input.fundingSource === 'general' ? 'general' : 'daily';
    const cashRegisterId = await this.resolveFunding(fundingSource, input.cashRegisterId, totalPaid);

    const result = await repos.supplierPayments.createAccountPayment({
      supplierId: input.supplierId,
      payments: input.payments.map((p) => ({
        paymentMethodId: p.paymentMethodId,
        amount: p.amount,
        reference: p.reference ?? null,
      })),
      notes: input.notes ?? null,
      cashRegisterId,
      fundingSource,
      userId: currentUser.id,
    });
    return result;
  }

  /**
   * Resuelve el origen del dinero de un pago a proveedor (mismo criterio que
   * las compras contado): con 'daily' exige una caja diaria abierta y devuelve
   * su id; con 'general' no hace falta caja (devuelve null) pero Caja General
   * tiene que tener saldo suficiente para el total del pago.
   */
  private async resolveFunding(
    fundingSource: 'daily' | 'general',
    inputCashRegisterId: string | undefined,
    totalPaid: string,
  ): Promise<string | null> {
    const { repos } = this.ctx;
    if (fundingSource === 'general') {
      const cgBalance = await repos.cashGeneral.getBalance();
      if (cmpDecimal(cgBalance, totalPaid) < 0) {
        throw new BusinessRuleError(
          'insufficient_cash_general',
          `Caja General no tiene saldo suficiente (disponible ${cgBalance}, pago ${totalPaid})`,
        );
      }
      return null;
    }
    const cashRegisterId =
      inputCashRegisterId ??
      (this.ctx.currentCashRegister?.status === 'open'
        ? this.ctx.currentCashRegister.id
        : (await repos.cashRegisters.getCurrentOpen())?.id);
    if (!cashRegisterId) {
      throw new BusinessRuleError('no_open_cash_register', 'No hay una caja abierta para registrar el egreso');
    }
    return cashRegisterId;
  }

  /**
   * Detalle de un comprobante de proveedor: la cuenta, la compra asociada, sus
   * líneas (con descripción/marca del artículo) y los pagos aplicados a ESA
   * cuenta (con el nombre del medio de pago).
   */
  async getAccountDetail(accountId: string): Promise<SupplierAccountPayableDetail> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_supplier_accounts');

    const account = await repos.supplierAccountsPayable.findById(accountId);
    if (!account) throw new NotFoundError('Cuenta de proveedor', accountId);

    const purchase = (await repos.purchases.findById(account.purchaseId)) ?? null;
    const rawLines = await repos.purchaseLines.findByPurchase(account.purchaseId);

    const articleIds = [...new Set(rawLines.map((l) => l.articleId))];
    const articlesById = new Map<string, { description: string; brand: string | null }>();
    for (const id of articleIds) {
      const art = await repos.articles.findById(id);
      if (art) articlesById.set(id, { description: art.description, brand: art.brand ?? null });
    }

    const lines: SupplierAccountDetailLine[] = rawLines
      .slice()
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        ...l,
        description: articlesById.get(l.articleId)?.description ?? l.articleId,
        brand: articlesById.get(l.articleId)?.brand ?? null,
      }));

    const pmById = await repos.paymentMethods.byId();
    const rawPayments = await repos.supplierPayments.findByAccount(accountId);
    const payments: SupplierAccountDetailPayment[] = rawPayments
      .slice()
      .sort((a, b) => a.date - b.date)
      .map((p) => ({
        ...p,
        paymentMethodName: pmById.get(p.paymentMethodId)?.name ?? 'medio desconocido',
      }));

    return { account, purchase, lines, payments };
  }

  /** Estado de cuenta cronológico de un proveedor (compras a cuenta + pagos). */
  async getSupplierStatement(
    supplierId: string,
    dateRange?: { from: number; to: number },
  ): Promise<SupplierStatement> {
    const { repos } = this.ctx;
    const supplier = await repos.suppliers.findById(supplierId);
    if (!supplier) throw new NotFoundError('Proveedor', supplierId);

    const accounts = await repos.supplierAccountsPayable.findAll({ supplierId });
    const purchasesById = new Map<string, Purchase>();
    for (const ac of accounts) {
      const p = await repos.purchases.findById(ac.purchaseId);
      if (p) purchasesById.set(ac.purchaseId, p);
    }
    const pmById = await repos.paymentMethods.byId();

    type RawEntry = Omit<SupplierStatementEntry, 'runningBalance'>;
    const raw: RawEntry[] = [];
    for (const ac of accounts) {
      const p = purchasesById.get(ac.purchaseId);
      raw.push({
        date: ac.createdAt,
        kind: 'purchase',
        reference: p ? `Compra ${p.type} #${p.number}` : `Cuenta ${ac.id}`,
        debit: ac.total,
        credit: '0.0000',
        paymentMethodName: null,
        comprobanteBalance: null,
        purchaseId: ac.purchaseId,
      });
      const pays = (await repos.supplierPayments.findByAccount(ac.id))
        .slice()
        .sort((a, b) => a.date - b.date);
      let paidSoFar = '0.0000';
      for (const pay of pays) {
        const pmName = pmById.get(pay.paymentMethodId)?.name ?? 'medio desconocido';
        paidSoFar = addDecimal(paidSoFar, pay.amount, 4);
        raw.push({
          date: pay.date,
          kind: 'payment',
          reference: `Pago — ${pmName}`,
          debit: '0.0000',
          credit: pay.amount,
          paymentMethodName: pmName,
          comprobanteBalance: subDecimal(ac.total, paidSoFar, 4),
          purchaseId: null,
        });
      }
    }

    // Devoluciones al proveedor con crédito a cuenta (bajan la deuda).
    const accountReturns = await repos.returns.findAccountCreditsByPurchases([...purchasesById.keys()]);
    for (const r of accountReturns) {
      const purchase = purchasesById.get(r.purchaseId) ?? null;
      raw.push({
        date: r.date,
        kind: 'return',
        reference: `Devolución DPC #${r.number}`,
        debit: '0.0000',
        credit: r.total,
        paymentMethodName: null,
        comprobanteBalance: null,
        purchaseId: r.purchaseId,
      });
      void purchase;
    }

    raw.sort((a, b) => a.date - b.date);

    let running = '0.0000';
    const entries: SupplierStatementEntry[] = [];
    for (const e of raw) {
      running = subDecimal(addDecimal(running, e.debit, 4), e.credit, 4);
      entries.push({ ...e, runningBalance: running });
    }

    const filtered =
      dateRange != null
        ? entries.filter((e) => e.date >= dateRange.from && e.date <= dateRange.to)
        : entries;

    const currentBalance = sumDecimals(accounts.map((a) => a.balance));
    return { supplier, entries: filtered, currentBalance };
  }
}
