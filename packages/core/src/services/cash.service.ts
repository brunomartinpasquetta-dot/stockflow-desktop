/**
 * Servicio de caja: apertura/cierre, movimientos manuales y reportes de arqueo.
 */
import type { CashMovement, CashRegister, PaymentMethod, PaymentMethodType } from '@stockflow/shared';
import { addDecimal, subDecimal, sumDecimals } from '@stockflow/shared';

import { hasPermission, requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError, PermissionDeniedError } from '../errors';

export interface AddMovementInput {
  type: 'income' | 'expense';
  description: string;
  amount: string;
  /** Medio de pago del movimiento (default en la UI: Efectivo). null = efectivo físico. */
  paymentMethodId?: string | null;
  /** Si se omite, se usa la caja activa del contexto / la caja abierta actual. */
  cashRegisterId?: string;
}

/** Movimiento de caja enriquecido con el estado de la venta relacionada (si aplica). */
export type CashMovementWithStatus = CashMovement & {
  relatedSaleStatus?: 'completed' | 'voided' | 'pending';
};

/** Desglose de ingresos/egresos por medio de pago (para el dashboard de caja). */
export interface PaymentMethodBreakdown {
  /** null = movimientos sin medio asignado (legacy). */
  paymentMethodId: string | null;
  name: string;
  type: PaymentMethodType | null;
  /** true = afecta el arqueo físico del cajón. */
  isPhysicalCash: boolean;
  incomeTotal: string;
  expenseTotal: string;
  net: string;
}

export interface CashReport {
  register: CashRegister;
  openingAmount: string;
  incomeCount: number;
  incomeTotal: string;
  expenseCount: number;
  expenseTotal: string;
  salesCount: number;
  salesTotal: string;
  /** efectivo físico esperado = apertura + ingresos en efectivo − egresos en efectivo */
  expectedCash: string;
  /** monto declarado al cerrar (null si la caja sigue abierta) */
  closingAmount: string | null;
  /** declarado − esperado (null si la caja sigue abierta) */
  difference: string | null;
  /** Desglose por medio de pago (efectivo, transferencia, tarjetas, ...). */
  byPaymentMethod: PaymentMethodBreakdown[];
  movements: CashMovementWithStatus[];
}

export class CashService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Abre una caja a nombre del usuario actual (falla si ya hay una abierta). */
  async openCashRegister(openingAmount: string): Promise<CashRegister> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'open_cash');
    return repos.cashRegisters.openRegister({ openingAmount, userId: currentUser.id });
  }

  /**
   * Cierra una caja. Puede hacerlo el dueño de la caja o un usuario con permiso
   * `close_cash` (admin/manager). Devuelve la caja cerrada + el reporte de arqueo.
   */
  async closeCashRegister(
    registerId: string,
    closingAmount: string,
    notes?: string,
  ): Promise<{ register: CashRegister; report: CashReport }> {
    const { repos, currentUser } = this.ctx;
    const register = await repos.cashRegisters.findById(registerId);
    if (!register) throw new NotFoundError('Caja', registerId);
    if (register.userId !== currentUser.id && !hasPermission(currentUser.role, 'close_cash')) {
      throw new PermissionDeniedError('close_cash', currentUser.role);
    }
    if (register.status === 'closed') {
      throw new BusinessRuleError('cash_already_closed', `La caja ${registerId} ya está cerrada`);
    }

    const closed = await repos.cashRegisters.closeRegister(registerId, { closingAmount, notes });
    const report = await this.buildReport(closed);
    return { register: closed, report };
  }

  /** Reporte de arqueo de una caja (abierta o cerrada). Lectura: no requiere permiso. */
  async getCashReport(registerId: string): Promise<CashReport> {
    const register = await this.ctx.repos.cashRegisters.findById(registerId);
    if (!register) throw new NotFoundError('Caja', registerId);
    return this.buildReport(register);
  }

  /** Registra un movimiento manual de caja (ingreso/egreso). */
  async addMovement(input: AddMovementInput): Promise<CashMovement> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'add_cash_movement');

    const registerId =
      input.cashRegisterId ??
      (this.ctx.currentCashRegister?.status === 'open'
        ? this.ctx.currentCashRegister.id
        : (await repos.cashRegisters.getCurrentOpen())?.id);
    if (!registerId) {
      throw new BusinessRuleError('no_open_cash_register', 'No hay una caja abierta');
    }

    return repos.cashMovements.create({
      cashRegisterId: registerId,
      type: input.type,
      description: input.description,
      amount: input.amount,
      userId: currentUser.id,
      paymentMethodId: input.paymentMethodId ?? null,
      date: Date.now(),
    });
  }

  private async buildReport(register: CashRegister): Promise<CashReport> {
    const { repos } = this.ctx;
    const [rawMovements, pmById] = await Promise.all([
      repos.cashMovements.findByRegister(register.id),
      repos.paymentMethods.byId(),
    ]);
    const saleIds = [
      ...new Set(rawMovements.filter((m) => m.relatedSaleId).map((m) => m.relatedSaleId as string)),
    ];
    const saleStatuses = await repos.sales.findStatusesByIds(saleIds);
    const movements: CashMovementWithStatus[] = rawMovements.map((m) => {
      const status = m.relatedSaleId ? saleStatuses.get(m.relatedSaleId) : undefined;
      return status ? { ...m, relatedSaleStatus: status } : m;
    });

    const isPhysical = (m: CashMovement): boolean =>
      m.paymentMethodId == null || pmById.get(m.paymentMethodId)?.isPhysicalCash === true;

    const incomes = movements.filter((m) => m.type === 'income');
    const expenses = movements.filter((m) => m.type === 'expense');
    const incomeTotal = sumDecimals(incomes.map((m) => m.amount));
    const expenseTotal = sumDecimals(expenses.map((m) => m.amount));

    const cashIncome = sumDecimals(incomes.filter(isPhysical).map((m) => m.amount));
    const cashExpense = sumDecimals(expenses.filter(isPhysical).map((m) => m.amount));
    const expectedCash = subDecimal(sumDecimals([register.openingAmount, cashIncome]), cashExpense, 4);

    // Desglose por medio de pago.
    const byPmMap = new Map<string, PaymentMethodBreakdown>();
    const NONE_KEY = '__none__';
    for (const m of movements) {
      const key = m.paymentMethodId ?? NONE_KEY;
      let b = byPmMap.get(key);
      if (!b) {
        const pm: PaymentMethod | undefined = m.paymentMethodId ? pmById.get(m.paymentMethodId) : undefined;
        b = {
          paymentMethodId: m.paymentMethodId ?? null,
          name: pm?.name ?? (m.paymentMethodId ? `(${m.paymentMethodId})` : 'Efectivo (sin asignar)'),
          type: pm?.type ?? null,
          isPhysicalCash: pm?.isPhysicalCash ?? m.paymentMethodId == null,
          incomeTotal: '0.0000',
          expenseTotal: '0.0000',
          net: '0.0000',
        };
        byPmMap.set(key, b);
      }
      if (m.type === 'income') b.incomeTotal = addDecimal(b.incomeTotal, m.amount, 4);
      else b.expenseTotal = addDecimal(b.expenseTotal, m.amount, 4);
    }
    const byPaymentMethod = [...byPmMap.values()]
      .map((b) => ({ ...b, net: subDecimal(b.incomeTotal, b.expenseTotal, 4) }))
      .sort((a, b) => {
        const oa = a.paymentMethodId ? pmById.get(a.paymentMethodId)?.sortOrder ?? 999 : 0;
        const ob = b.paymentMethodId ? pmById.get(b.paymentMethodId)?.sortOrder ?? 999 : 0;
        return oa - ob;
      });

    const sales = await repos.sales.findAll({ cashRegisterId: register.id });
    const completedSales = sales.filter((s) => s.status === 'completed');
    const salesTotal = sumDecimals(completedSales.map((s) => s.total));
    const difference =
      register.closingAmount != null ? subDecimal(register.closingAmount, expectedCash, 4) : null;

    return {
      register,
      openingAmount: register.openingAmount,
      incomeCount: incomes.length,
      incomeTotal,
      expenseCount: expenses.length,
      expenseTotal,
      salesCount: completedSales.length,
      salesTotal,
      expectedCash,
      closingAmount: register.closingAmount ?? null,
      difference,
      byPaymentMethod,
      movements,
    };
  }
}
