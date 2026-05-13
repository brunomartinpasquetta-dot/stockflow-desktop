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
}

export interface PaySupplierInvoiceResult {
  payments: SupplierPayment[];
  account: SupplierAccountPayable;
}

export interface SupplierStatementEntry {
  date: number;
  kind: 'purchase' | 'payment';
  reference: string;
  /** importe que aumenta la deuda (compras a cuenta) */
  debit: string;
  /** importe que disminuye la deuda (pagos) */
  credit: string;
  runningBalance: string;
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
    return balances
      .filter((b) => Number(b.totalDebt) > 0)
      .map((b) => ({
        supplierId: b.supplierId,
        supplierName: nameById.get(b.supplierId) ?? b.supplierId,
        totalDebt: b.totalDebt,
        openInvoicesCount: b.openInvoicesCount,
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

    const cashRegisterId =
      input.cashRegisterId ??
      (this.ctx.currentCashRegister?.status === 'open'
        ? this.ctx.currentCashRegister.id
        : (await repos.cashRegisters.getCurrentOpen())?.id);
    if (!cashRegisterId) {
      throw new BusinessRuleError('no_open_cash_register', 'No hay una caja abierta para registrar el egreso');
    }

    const payments = await repos.supplierPayments.createPayment({
      accountId: input.accountId,
      payments: input.payments.map((p) => ({
        paymentMethodId: p.paymentMethodId,
        amount: p.amount,
        reference: p.reference ?? null,
      })),
      notes: input.notes ?? null,
      cashRegisterId,
      userId: currentUser.id,
    });
    const updatedAccount = await repos.supplierAccountsPayable.findById(input.accountId);
    if (!updatedAccount) throw new NotFoundError('Cuenta de proveedor', input.accountId);
    return { payments, account: updatedAccount };
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

    type RawEntry = { date: number; kind: 'purchase' | 'payment'; reference: string; debit: string; credit: string };
    const raw: RawEntry[] = [];
    for (const ac of accounts) {
      const p = purchasesById.get(ac.purchaseId);
      raw.push({
        date: ac.createdAt,
        kind: 'purchase',
        reference: p ? `Compra ${p.type} #${p.number}` : `Cuenta ${ac.id}`,
        debit: ac.total,
        credit: '0.0000',
      });
      const pays = await repos.supplierPayments.findByAccount(ac.id);
      for (const pay of pays) {
        const pmName = pmById.get(pay.paymentMethodId)?.name ?? 'medio desconocido';
        raw.push({
          date: pay.date,
          kind: 'payment',
          reference: `Pago — ${pmName}`,
          debit: '0.0000',
          credit: pay.amount,
        });
      }
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
