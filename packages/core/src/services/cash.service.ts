/**
 * Servicio de caja: apertura/cierre, movimientos manuales y reportes de arqueo.
 */
import type { CashMovement, CashRegister } from '@stockflow/shared';
import { subDecimal, sumDecimals } from '@stockflow/shared';

import { hasPermission, requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError, PermissionDeniedError } from '../errors';

export interface AddMovementInput {
  type: 'income' | 'expense';
  description: string;
  amount: string;
  /** Si se omite, se usa la caja activa del contexto / la caja abierta actual. */
  cashRegisterId?: string;
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
  /** efectivo esperado en caja = apertura + ingresos − egresos */
  expectedCash: string;
  /** monto declarado al cerrar (null si la caja sigue abierta) */
  closingAmount: string | null;
  /** declarado − esperado (null si la caja sigue abierta) */
  difference: string | null;
  movements: CashMovement[];
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

    const closed = await repos.cashRegisters.closeRegister(registerId, { closingAmount });
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
      date: Date.now(),
    });
  }

  private async buildReport(register: CashRegister): Promise<CashReport> {
    const { repos } = this.ctx;
    const movements = await repos.cashMovements.findByRegister(register.id);
    const incomes = movements.filter((m) => m.type === 'income');
    const expenses = movements.filter((m) => m.type === 'expense');
    const incomeTotal = sumDecimals(incomes.map((m) => m.amount));
    const expenseTotal = sumDecimals(expenses.map((m) => m.amount));
    const sales = await repos.sales.findAll({ cashRegisterId: register.id });
    const completedSales = sales.filter((s) => s.status === 'completed');
    const salesTotal = sumDecimals(completedSales.map((s) => s.total));
    const expectedCash = subDecimal(
      sumDecimals([register.openingAmount, incomeTotal]),
      expenseTotal,
      4,
    );
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
      movements,
    };
  }
}
