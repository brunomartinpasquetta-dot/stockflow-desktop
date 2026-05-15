/**
 * Servicio Caja General: saldo histórico global de la empresa.
 *
 * - Caja general es una "caja fuerte" lógica: nunca se cierra, sólo acumula
 *   movimientos (ingresos / egresos / transferencias desde caja diaria).
 * - `view_reports` para leer; `manage_cash_general` para registrar
 *   ingresos/egresos manuales; `close_cash` para transferir desde caja diaria.
 */
import type { CashGeneralCategory, CashGeneralMovementType } from '@stockflow/db';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { ValidationError } from '../errors';

export interface CashGeneralMovementDTO {
  id: string;
  type: CashGeneralMovementType;
  amount: string;
  description: string;
  category: CashGeneralCategory | null;
  createdBy: string;
  referenceId: string | null;
  balanceAfter: string;
  createdAt: number;
}

export interface ListCashGeneralMovementsInput {
  from?: number;
  to?: number;
  type?: CashGeneralMovementType;
  category?: CashGeneralCategory;
  limit?: number;
}

export interface AddIncomeOrExpenseInput {
  amount: string;
  description: string;
  category?: CashGeneralCategory;
}

export interface TransferFromDailyInput {
  cashRegisterId: string;
  amount: string;
}

function assertPositive(amount: string): void {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError('amount', 'El monto debe ser mayor a cero');
  }
}

function assertDescription(description: string): void {
  if (!description || description.trim() === '') {
    throw new ValidationError('description', 'El concepto es obligatorio');
  }
}

export class CashGeneralService {
  constructor(private readonly ctx: ServiceContext) {}

  async getBalance(): Promise<string> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'view_reports');
    return repos.cashGeneral.getBalance();
  }

  async listMovements(input: ListCashGeneralMovementsInput = {}): Promise<CashGeneralMovementDTO[]> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'view_reports');
    const rows = await repos.cashGeneral.findMovements(input);
    return rows.map((r) => ({
      id: r.id,
      type: r.type as CashGeneralMovementType,
      amount: r.amount,
      description: r.description,
      category: (r.category ?? null) as CashGeneralCategory | null,
      createdBy: r.createdBy,
      referenceId: r.referenceId,
      balanceAfter: r.balanceAfter,
      createdAt: r.createdAt,
    }));
  }

  async addIncome(input: AddIncomeOrExpenseInput): Promise<CashGeneralMovementDTO> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'manage_cash_general');
    assertPositive(input.amount);
    assertDescription(input.description);
    const m = await repos.cashGeneral.addMovement({
      type: 'income',
      amount: input.amount,
      description: input.description.trim(),
      category: input.category ?? null,
      createdBy: currentUser.id,
    });
    return this.toDTO(m);
  }

  async addExpense(input: AddIncomeOrExpenseInput): Promise<CashGeneralMovementDTO> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'manage_cash_general');
    assertPositive(input.amount);
    assertDescription(input.description);
    const m = await repos.cashGeneral.addMovement({
      type: 'expense',
      amount: input.amount,
      description: input.description.trim(),
      category: input.category ?? null,
      createdBy: currentUser.id,
    });
    return this.toDTO(m);
  }

  async transferFromDaily(input: TransferFromDailyInput): Promise<CashGeneralMovementDTO> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'close_cash');
    assertPositive(input.amount);
    const m = await repos.cashGeneral.addMovement({
      type: 'transfer_from_daily',
      amount: input.amount,
      description: `Transferencia desde caja diaria`,
      category: 'deposit',
      createdBy: currentUser.id,
      referenceId: input.cashRegisterId,
    });
    return this.toDTO(m);
  }

  private toDTO(m: {
    id: string;
    type: string;
    amount: string;
    description: string;
    category: string | null;
    createdBy: string;
    referenceId: string | null;
    balanceAfter: string;
    createdAt: number;
  }): CashGeneralMovementDTO {
    return {
      id: m.id,
      type: m.type as CashGeneralMovementType,
      amount: m.amount,
      description: m.description,
      category: (m.category ?? null) as CashGeneralCategory | null,
      createdBy: m.createdBy,
      referenceId: m.referenceId,
      balanceAfter: m.balanceAfter,
      createdAt: m.createdAt,
    };
  }
}
