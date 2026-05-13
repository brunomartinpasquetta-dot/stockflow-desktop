/**
 * Servicio de cuentas corrientes: cobranzas y estados de cuenta de clientes.
 */
import type { AccountReceivable, Customer, Payment, Sale } from '@stockflow/shared';
import { addDecimal, cmpDecimal, subDecimal, sumDecimals } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors';

/** Una línea de cobranza (un medio de pago + monto). */
export interface PaymentDraft {
  paymentMethodId: string;
  amount: string;
  reference?: string | null;
}

export interface ReceivePaymentInput {
  accountId: string;
  /** Una o más líneas de pago; la suma es lo cobrado. */
  payments: PaymentDraft[];
  /** Si se indica, la suma de los pagos debe coincidir EXACTAMENTE con este monto. */
  expectedAmount?: string;
  notes?: string | null;
  /** Caja donde impacta el ingreso (default: caja activa / caja abierta). */
  cashRegisterId?: string;
}

export interface ReceivePaymentResult {
  payments: Payment[];
  account: AccountReceivable;
}

export interface StatementEntry {
  date: number;
  kind: 'sale' | 'payment';
  reference: string;
  /** importe que aumenta la deuda (ventas a cuenta) */
  debit: string;
  /** importe que disminuye la deuda (pagos) */
  credit: string;
  /** saldo acumulado luego de este movimiento */
  runningBalance: string;
}

export interface CustomerStatement {
  customer: Customer;
  entries: StatementEntry[];
  currentBalance: string;
}

export interface CustomerBalance {
  customerId: string;
  customerName: string;
  totalDebt: string;
  openInvoicesCount: number;
  lastPaymentDate: number | null;
}

export class AccountsReceivableService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Registra una cobranza contra una cuenta corriente. El repositorio hace la
   * transacción atómica (pago + actualización de saldo/estado + movimiento de caja).
   */
  async receivePayment(input: ReceivePaymentInput): Promise<ReceivePaymentResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'receive_payment');

    const account = await repos.accountsReceivable.findById(input.accountId);
    if (!account) throw new NotFoundError('Cuenta corriente', input.accountId);
    if (input.payments.length === 0) {
      throw new BusinessRuleError('no_payment_lines', 'Hay que registrar al menos un pago');
    }
    const totalPaid = sumDecimals(input.payments.map((p) => p.amount));
    if (cmpDecimal(totalPaid, '0') <= 0) {
      throw new BusinessRuleError('invalid_payment_amount', 'El monto cobrado debe ser positivo');
    }
    if (input.expectedAmount != null) {
      const cmp = cmpDecimal(totalPaid, input.expectedAmount);
      if (cmp > 0) throw new ValidationError('payments', 'Los pagos exceden el monto a cobrar');
      if (cmp < 0) throw new ValidationError('payments', 'Los pagos no cubren el monto a cobrar');
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
      throw new BusinessRuleError('no_open_cash_register', 'No hay una caja abierta para registrar el ingreso');
    }

    const payments = await repos.payments.createPayment({
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
    const updatedAccount = await repos.accountsReceivable.findById(input.accountId);
    if (!updatedAccount) throw new NotFoundError('Cuenta corriente', input.accountId);
    return { payments, account: updatedAccount };
  }

  /** Estado de cuenta cronológico de un cliente (ventas a cuenta + pagos). */
  async getCustomerStatement(
    customerId: string,
    dateRange?: { from: number; to: number },
  ): Promise<CustomerStatement> {
    const { repos } = this.ctx;
    const customer = await repos.customers.findById(customerId);
    if (!customer) throw new NotFoundError('Cliente', customerId);

    const accounts = await repos.accountsReceivable.findAll({ customerId });
    const salesById = new Map<string, Sale>();
    for (const ac of accounts) {
      const sale = await repos.sales.findById(ac.saleId);
      if (sale) salesById.set(ac.saleId, sale);
    }
    const pmById = await repos.paymentMethods.byId();

    type RawEntry = { date: number; kind: 'sale' | 'payment'; reference: string; debit: string; credit: string };
    const raw: RawEntry[] = [];
    for (const ac of accounts) {
      raw.push({
        date: ac.createdAt,
        kind: 'sale',
        reference: salesById.get(ac.saleId)
          ? `Venta ${salesById.get(ac.saleId)!.type} #${salesById.get(ac.saleId)!.number}`
          : `Cuenta ${ac.id}`,
        debit: ac.total,
        credit: '0.0000',
      });
      const payments = await repos.payments.findByAccount(ac.id);
      for (const p of payments) {
        const pmName = pmById.get(p.paymentMethodId)?.name ?? 'medio desconocido';
        raw.push({
          date: p.date,
          kind: 'payment',
          reference: `Cobranza — ${pmName}`,
          debit: '0.0000',
          credit: p.amount,
        });
      }
    }

    raw.sort((a, b) => a.date - b.date);

    let running = '0.0000';
    const entries: StatementEntry[] = [];
    for (const e of raw) {
      running = subDecimal(addDecimal(running, e.debit, 4), e.credit, 4);
      entries.push({ ...e, runningBalance: running });
    }

    const filtered =
      dateRange != null
        ? entries.filter((e) => e.date >= dateRange.from && e.date <= dateRange.to)
        : entries;

    const currentBalance = sumDecimals(accounts.map((a) => a.balance));
    return { customer, entries: filtered, currentBalance };
  }

  /** Total adeudado por todos los clientes. */
  async getTotalReceivables(): Promise<string> {
    const accounts = await this.ctx.repos.accountsReceivable.findAll();
    return sumDecimals(accounts.map((a) => a.balance));
  }

  /** Deuda por cliente (sólo los que deben), con nombre y fecha del último pago. */
  async listCustomerBalances(): Promise<CustomerBalance[]> {
    const { repos } = this.ctx;
    const [balances, lastPayments, customers] = await Promise.all([
      repos.accountsReceivable.listBalances(),
      repos.accountsReceivable.lastPaymentByCustomer(),
      repos.customers.findAll(),
    ]);
    const nameById = new Map(
      customers.map((c) => [c.id, c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName]),
    );
    return balances
      .filter((b) => Number(b.totalDebt) > 0)
      .map((b) => ({
        customerId: b.customerId,
        customerName: nameById.get(b.customerId) ?? b.customerId,
        totalDebt: b.totalDebt,
        openInvoicesCount: b.openInvoicesCount,
        lastPaymentDate: lastPayments.get(b.customerId) ?? null,
      }));
  }
}
