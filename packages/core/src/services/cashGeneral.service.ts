/**
 * Servicio Caja General: saldo histórico global de la empresa.
 *
 * - Caja general es una "caja fuerte" lógica: nunca se cierra, sólo acumula
 *   movimientos (ingresos / egresos / transferencias desde caja diaria).
 * - `view_reports` para leer; `manage_cash_general` para registrar
 *   ingresos/egresos manuales; `close_cash` para transferir desde caja diaria.
 */
import { addDecimal, subDecimal } from '@stockflow/shared';
import type { CashGeneralCategory, CashGeneralMovement, CashGeneralMovementType } from '@stockflow/db';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { NotFoundError, ValidationError } from '../errors';

export interface CashGeneralMovementDTO {
  id: string;
  type: CashGeneralMovementType;
  amount: string;
  description: string;
  category: CashGeneralCategory | null;
  createdBy: string;
  referenceId: string | null;
  balanceAfter: string;
  isCash: boolean;
  balanceAfterCash: string;
  balanceAfterElectronic: string;
  createdAt: number;
}

/** Saldo de Caja General discriminado efectivo/electrónico/total. */
export interface CashGeneralBalanceDTO {
  total: string;
  cash: string;
  electronic: string;
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
  /** true = efectivo físico, false = electrónico. Default efectivo. */
  isCash?: boolean;
}

export interface TransferFromDailyInput {
  cashRegisterId: string;
  amount: string;
  /** Desglose del depósito de cierre (suma = amount). Si se omite, todo efectivo. */
  cashAmount?: string;
  electronicAmount?: string;
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

  /** Saldo discriminado efectivo/electrónico/total. */
  async getBalanceBreakdown(): Promise<CashGeneralBalanceDTO> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'view_reports');
    return repos.cashGeneral.getBalanceBreakdown();
  }

  /**
   * Corrige el reparto efectivo/electrónico declarando cuánto hay en la caja
   * fuerte. No altera el total ni los movimientos.
   */
  async adjustBreakdown(input: { cashAmount: string }): Promise<CashGeneralBalanceDTO> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'manage_cash_general');
    // A diferencia de los movimientos, acá CERO es válido (puede no tener
    // nada en efectivo), pero nunca negativo.
    const n = Number(input.cashAmount);
    if (!Number.isFinite(n) || n < 0) {
      throw new ValidationError('cashAmount', 'El efectivo declarado no puede ser negativo');
    }
    return repos.cashGeneral.adjustBreakdown(input.cashAmount, currentUser.id);
  }

  async listMovements(input: ListCashGeneralMovementsInput = {}): Promise<CashGeneralMovementDTO[]> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'view_reports');
    const rows = await repos.cashGeneral.findMovements(input);
    return rows.map((r) => this.toDTO(r));
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
      isCash: input.isCash ?? true,
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
      isCash: input.isCash ?? true,
    });
    return this.toDTO(m);
  }

  /**
   * Transfiere efectivo desde una caja diaria ABIERTA hacia la Caja General.
   *
   * BUG-S01 / BUG-S10: la operación es atómica y registra la contrapartida en
   * la caja diaria de origen (un `cash_movements` de egreso). La caja debe estar
   * abierta — si ya se cerró, el dinero ya quedó arqueado y no puede transferirse
   * sin descuadrar el cierre. La UI debe ofrecer transferir ANTES de cerrar.
   */
  /**
   * Depósito automático al CERRAR la caja: permite al dueño de la caja (aunque
   * no tenga `close_cash`, igual que el cierre) o a quien tenga el permiso.
   */
  async transferFromClosed(input: TransferFromDailyInput): Promise<CashGeneralMovementDTO> {
    const { repos, currentUser } = this.ctx;
    const reg = await repos.cashRegisters.findById(input.cashRegisterId);
    if (!reg) throw new NotFoundError('Caja', input.cashRegisterId);
    if (reg.userId !== currentUser?.id) {
      requirePermission(currentUser, 'close_cash');
    }
    // Tope de lo que ese cierre puede aportar: efectivo contado + neto de los
    // medios no físicos. Permite completar un depósito parcial (típico: se
    // ingresó sólo el efectivo y quedó afuera la parte electrónica) sin
    // habilitar que se deposite más de lo recaudado.
    const movs = await repos.cashMovements.findByRegister(input.cashRegisterId);
    const pmById = await repos.paymentMethods.byId();
    let noFisico = '0';
    for (const mv of movs) {
      const fisico = mv.paymentMethodId == null || pmById.get(mv.paymentMethodId)?.isPhysicalCash === true;
      if (fisico) continue;
      noFisico =
        mv.type === 'income'
          ? addDecimal(noFisico, mv.amount, 2)
          : subDecimal(noFisico, mv.amount, 2);
    }
    const maxDepositable = addDecimal(
      reg.closingAmount ?? '0',
      Number(noFisico) > 0 ? noFisico : '0',
      2,
    );
    const m = await repos.cashGeneral.transferFromClosed({
      cashRegisterId: input.cashRegisterId,
      amount: input.amount,
      createdBy: currentUser?.id ?? 'system',
      cashAmount: input.cashAmount,
      electronicAmount: input.electronicAmount,
      maxDepositable,
    });
    return this.toDTO(m);
  }

  async transferFromDaily(input: TransferFromDailyInput): Promise<CashGeneralMovementDTO> {
    const { currentUser, repos } = this.ctx;
    requirePermission(currentUser, 'close_cash');
    assertPositive(input.amount);
    const m = await repos.cashGeneral.transferFromDaily({
      cashRegisterId: input.cashRegisterId,
      amount: input.amount,
      createdBy: currentUser.id,
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
    isCash: boolean;
    balanceAfterCash: string;
    balanceAfterElectronic: string;
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
      isCash: m.isCash,
      balanceAfterCash: m.balanceAfterCash,
      balanceAfterElectronic: m.balanceAfterElectronic,
      createdAt: m.createdAt,
    };
  }
}
