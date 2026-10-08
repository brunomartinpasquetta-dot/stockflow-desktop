/**
 * Servicio de caja: apertura/cierre, movimientos manuales y reportes de arqueo.
 */
import type { CashMovement, CashRegister, PaymentMethod, PaymentMethodType } from '@stockflow/shared';
import { CashRegisterRepository } from '@stockflow/db';
import {
  addDecimal,
  cmpDecimal,
  netoElectronico,
  subDecimal,
  sumDecimals,
  totalParaCajaGeneral,
} from '@stockflow/shared';

import { hasPermission, requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { CashGeneralService } from './cashGeneral.service';
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
  /** Comisión absorbida por el comercio en las ventas completadas con este medio. */
  commissionTotal: string;
}

export interface HistoricalCashRegisterSummary {
  id: string;
  openDate: number;
  closeDate: number | null;
  userId: string;
  userName: string;
  openingAmount: string;
  totalIncome: string;
  totalExpense: string;
  expectedAmount: string | null;
  closingAmount: string | null;
  difference: string | null;
  status: 'open' | 'closed';
  movementCount: number;
  number: number;
  /** true si el cierre ya fue ingresado COMPLETO a Caja General. */
  depositedToGeneral: boolean;
  /** Cuánto de ese cierre ya se ingresó a Caja General. */
  depositedAmount: string;
  /** Desglose de lo ya ingresado (auditoría sep-2026, A8). */
  depositedCashAmount: string;
  depositedElectronicAmount: string;
  /** Cuánto podía ingresarse en total (efectivo contado + neto electrónico). */
  depositableAmount: string;
  /**
   * Caja importada del sistema anterior (migración desde StockFácil). No se
   * ingresa a Caja General: la Caja General arranca en cero el día de la
   * migración (decisión de Bruno, 4-oct-2026) y ofrecer "Ingresar" en 3.000
   * cajas viejas confundía y dejaba meter plata que ya no existe.
   */
  importada: boolean;
  /**
   * Ingresos de esa caja separados por forma de pago. Va en el LISTADO —y no
   * sólo en el detalle— porque la pregunta del comercio es "cuánto vendí por
   * transferencia" en un día o en un mes, y respondiéndola caja por caja habría
   * que abrir cada una.
   */
  incomeByPaymentMethod: { paymentMethodId: string | null; name: string; income: string }[];
}

export interface HistoricalCashMovement {
  id: string;
  date: number;
  createdAt: number;
  type: 'income' | 'expense';
  amount: string;
  description: string;
  paymentMethodId: string | null;
  paymentMethodName: string | null;
  relatedSaleId: string | null;
  relatedPurchaseId: string | null;
  saleNumber: number | null;
  saleType: string | null;
  purchaseNumber: number | null;
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
  /** Comisión total absorbida por el comercio en las ventas completadas de esta caja. */
  commissionTotal: string;
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

/**
 * Efectivo FÍSICO disponible en una caja: apertura + ingresos en efectivo −
 * egresos en efectivo (misma regla que el arqueo: paymentMethodId null o
 * isPhysicalCash). Compartido por los flujos que egresan efectivo del cajón.
 */
export async function availablePhysicalCash(
  repos: ServiceContext['repos'],
  registerId: string,
): Promise<string> {
  const register = await repos.cashRegisters.findById(registerId);
  if (!register) throw new NotFoundError('Caja', registerId);
  const [movs, pmById] = await Promise.all([
    repos.cashMovements.findByRegister(registerId),
    repos.paymentMethods.byId(),
  ]);
  const fisico = (pmId: string | null): boolean => pmId == null || pmById.get(pmId)?.isPhysicalCash === true;
  const inc = movs.filter((m) => m.type === 'income' && fisico(m.paymentMethodId)).map((m) => m.amount);
  const exp = movs.filter((m) => m.type === 'expense' && fisico(m.paymentMethodId)).map((m) => m.amount);
  return subDecimal(sumDecimals([register.openingAmount, ...inc]), sumDecimals(exp), 4);
}

/** Valida que la caja tenga efectivo físico suficiente para un egreso. */
export async function assertPhysicalCashAvailable(
  repos: ServiceContext['repos'],
  registerId: string,
  amount: string,
): Promise<void> {
  if (cmpDecimal(amount, '0') <= 0) return;
  const disponible = await availablePhysicalCash(repos, registerId);
  if (cmpDecimal(amount, disponible) > 0) {
    throw new BusinessRuleError(
      'insufficient_cash_daily',
      `No hay efectivo suficiente en la caja (disponible ${disponible}, egreso en efectivo ${amount})`,
    );
  }
}

export class CashService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Caja General, para el ingreso automático al cerrar. */
  private cashGeneral(): CashGeneralService {
    return new CashGeneralService(this.ctx);
  }

  /**
   * Abre una caja a nombre del usuario actual.
   *
   * Con `terminal`, la caja queda ligada a ese puesto: cada terminal de una
   * instalación en red abre y arquea la suya. Sin terminal (una sola PC) se
   * mantiene la regla de una caja a la vez.
   */
  /**
   * Cuánto proponer como apertura: el cambio que dejó el último cierre. Es
   * una lectura mínima y NO pide `view_reports` a propósito: el cajero que
   * abre el turno muchas veces no tiene permiso de reportes, y sin esto
   * tendría que adivinar el número (riesgo detectado en el análisis del
   * 7-oct-2026).
   */
  async sugerenciaDeApertura(terminalId?: string | null): Promise<string | null> {
    return this.ctx.repos.cashRegisters.cambioDelUltimoCierre(terminalId ?? null);
  }

  async openCashRegister(
    openingAmount: string,
    terminal?: { id: string; name?: string | null } | null,
  ): Promise<CashRegister> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'open_cash');
    return repos.cashRegisters.openRegister({
      openingAmount,
      userId: currentUser.id,
      terminalId: terminal?.id ?? null,
      terminalName: terminal?.name ?? null,
    });
  }

  /**
   * Cierra una caja. Puede hacerlo el dueño de la caja o un usuario con permiso
   * `close_cash` (admin/manager). Devuelve la caja cerrada + el reporte de arqueo.
   */
  /**
   * Cierra la caja en UNA sola operación (rediseño pedido por Bruno,
   * 8-oct-2026).
   *
   * Antes el cierre eran dos trámites separados: cerrar, y después aceptar o
   * no un diálogo de «Ingresar a Caja General». Si ese segundo paso se
   * cerraba, la recaudación del día se quedaba colgada sin que nadie lo
   * notara. Y el cambio para el día siguiente se sacaba con un EGRESO MANUAL,
   * que descuadraba el arqueo.
   *
   * Ahora: se cuenta el efectivo, se dice cuánto cambio queda, y lo que
   * recaudó el día —el efectivo menos ese cambio, más lo cobrado por medios
   * electrónicos— entra solo a Caja General. El cambio queda registrado y es
   * la apertura sugerida del turno siguiente.
   */
  async closeCashRegister(
    registerId: string,
    closingAmount: string,
    notes?: string,
    changeLeft?: string | null,
  ): Promise<{
    register: CashRegister;
    report: CashReport;
    /** Lo que entró a Caja General, o null si no entró nada (y por qué). */
    deposito: { efectivo: string; electronico: string; total: string } | null;
    motivoSinDeposito: string | null;
  }> {
    const { repos, currentUser } = this.ctx;
    const register = await repos.cashRegisters.findById(registerId);
    if (!register) throw new NotFoundError('Caja', registerId);
    if (register.userId !== currentUser.id && !hasPermission(currentUser.role, 'close_cash')) {
      throw new PermissionDeniedError('close_cash', currentUser.role);
    }
    if (register.status === 'closed') {
      throw new BusinessRuleError('cash_already_closed', `La caja ${registerId} ya está cerrada`);
    }

    const closed = await repos.cashRegisters.closeRegister(registerId, {
      closingAmount,
      notes,
      changeLeft: changeLeft ?? null,
      closedByUserId: currentUser.id,
    });
    const report = await this.buildReport(closed);

    /**
     * El depósito se intenta SIEMPRE y su fallo NO voltea el cierre: la caja
     * ya quedó cerrada y arqueada. Si no se pudo, se dice por qué y queda el
     * botón de ingresar desde el Historial de cajas.
     */
    let deposito: { efectivo: string; electronico: string; total: string } | null = null;
    let motivoSinDeposito: string | null = null;
    const electronico = netoElectronico(report.byPaymentMethod);
    const { efectivo, total } = totalParaCajaGeneral(closingAmount, changeLeft ?? '0', electronico);
    if (Number(total) <= 0) {
      motivoSinDeposito = 'No quedó nada para ingresar a Caja General.';
    } else {
      try {
        await this.cashGeneral().transferFromClosed({
          cashRegisterId: registerId,
          amount: total,
          cashAmount: efectivo,
          electronicAmount: electronico,
        });
        deposito = { efectivo, electronico, total };
      } catch (err) {
        motivoSinDeposito = err instanceof Error ? err.message : 'No se pudo ingresar a Caja General.';
      }
    }

    return { register: closed, report, deposito, motivoSinDeposito };
  }

  /** Reporte de arqueo de una caja (abierta o cerrada). Lectura: no requiere permiso. */
  async getCashReport(registerId: string): Promise<CashReport> {
    const register = await this.ctx.repos.cashRegisters.findById(registerId);
    if (!register) throw new NotFoundError('Caja', registerId);
    return this.buildReport(register);
  }

  /**
   * Lista cajas (abiertas y cerradas) dentro de un rango, con totales
   * agregados de ingresos/egresos y nombre del cajero. Requiere `view_reports`.
   */
  async listHistoricalCashRegisters(input: {
    from: number;
    to: number;
    userId?: string;
  }): Promise<HistoricalCashRegisterSummary[]> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'view_reports');

    const registers = await repos.cashRegisters.findByDateRange({
      from: input.from,
      to: input.to,
      userId: input.userId,
    });
    if (registers.length === 0) return [];

    // Cargamos en paralelo: usuarios involucrados + movimientos por caja.
    const userIds = [...new Set(registers.map((r) => r.userId))];
    const users = await Promise.all(userIds.map((id) => repos.users.findById(id)));
    const userNameById = new Map<string, string>();
    for (const u of users) {
      if (u) userNameById.set(u.id, u.fullName);
    }

    const pmById = await repos.paymentMethods.byId();
    const isPhysical = (paymentMethodId: string | null): boolean =>
      paymentMethodId == null || pmById.get(paymentMethodId)?.isPhysicalCash === true;

    // Qué cierres ya fueron ingresados a Caja General (para marcar huérfanos).
    const depositedIds = await repos.cashGeneral.closeDepositRefIds(registers.map((r) => r.id));
    // Cajas importadas del sistema anterior (base migrada): no se ingresan.
    const fechaMigracion = await repos.cashRegisters.fechaDeMigracion();

    const summaries: HistoricalCashRegisterSummary[] = [];
    for (const r of registers) {
      const movements = await repos.cashMovements.findByRegister(r.id);
      const totalIncome = sumDecimals(movements.filter((m) => m.type === 'income').map((m) => m.amount));
      const totalExpense = sumDecimals(movements.filter((m) => m.type === 'expense').map((m) => m.amount));
      // Arqueo de efectivo: sólo movimientos en efectivo físico (igual que closeRegister).
      const cashIncome = sumDecimals(
        movements.filter((m) => m.type === 'income' && isPhysical(m.paymentMethodId)).map((m) => m.amount),
      );
      const cashExpense = sumDecimals(
        movements.filter((m) => m.type === 'expense' && isPhysical(m.paymentMethodId)).map((m) => m.amount),
      );
      const expectedAmount = subDecimal(
        sumDecimals([r.openingAmount, cashIncome]),
        cashExpense,
        4,
      );
      const difference =
        r.closingAmount != null ? subDecimal(r.closingAmount, expectedAmount, 4) : null;

      // Ingresos por forma de pago de esta caja. Los movimientos ya están
      // cargados: no cuesta una consulta más.
      // Los reversos de anulación (egresos ligados a una venta) restan del
      // medio con el que se había cobrado; un egreso manual no.
      const porMedio = new Map<string, { paymentMethodId: string | null; name: string; income: string }>();
      for (const m of movements) {
        const esReverso = m.type === 'expense' && m.relatedSaleId != null;
        if (m.type !== 'income' && !esReverso) continue;
        const clave = m.paymentMethodId ?? '__efectivo__';
        const nombre = m.paymentMethodId
          ? (pmById.get(m.paymentMethodId)?.name ?? 'Medio eliminado')
          : 'Efectivo';
        const prev = porMedio.get(clave)?.income ?? '0';
        porMedio.set(clave, {
          paymentMethodId: m.paymentMethodId,
          name: nombre,
          income: esReverso ? subDecimal(prev, m.amount, 4) : addDecimal(prev, m.amount, 4),
        });
      }
      // Lo que ese cierre podía aportar a Caja General y lo que realmente
      // aportó: si aportó menos, el historial ofrece completar la diferencia.
      const netoElectronico = subDecimal(
        subDecimal(totalIncome, totalExpense, 2),
        subDecimal(cashIncome, cashExpense, 2),
        2,
      );
      /**
       * Lo que ESA caja puede aportar a Caja General. El cambio que quedó en
       * el cajón no cuenta: es la apertura del turno siguiente (migración
       * 0040). Sin descontarlo, el Historial mostraba «Sin ingresar» para
       * siempre una caja que ya había ingresado todo lo que correspondía.
       */
      const efectivoDepositable = subDecimal(r.closingAmount ?? '0', r.changeLeft ?? '0', 4);
      const depositable =
        r.status === 'closed'
          ? sumDecimals([
              Number(efectivoDepositable) > 0 ? efectivoDepositable : '0',
              Number(netoElectronico) > 0 ? netoElectronico : '0',
            ])
          : '0';
      const deposito = depositedIds.get(r.id);
      const yaDepositado = deposito?.total ?? '0';
      const importada = CashRegisterRepository.esImportada(r, fechaMigracion);
      summaries.push({
        id: r.id,
        number: r.number,
        openDate: r.openDate,
        closeDate: r.closeDate,
        userId: r.userId,
        userName: userNameById.get(r.userId) ?? r.userId,
        openingAmount: r.openingAmount,
        totalIncome,
        totalExpense,
        expectedAmount,
        closingAmount: r.closingAmount,
        difference,
        status: r.status,
        movementCount: movements.length,
        // Importada: nada para ingresar (ni el botón, ni "Sin ingresar").
        depositedToGeneral: importada || Number(yaDepositado) >= Number(depositable) - 0.005,
        depositedAmount: yaDepositado,
        depositedCashAmount: deposito?.cash ?? '0',
        depositedElectronicAmount: deposito?.electronic ?? '0',
        incomeByPaymentMethod: [...porMedio.values()],
        depositableAmount: importada ? '0' : depositable,
        importada,
      });
    }
    return summaries;
  }

  /**
   * Reporte completo de una caja para drill-down histórico, con movimientos
   * enriquecidos (medio de pago, número de venta/compra). Requiere `view_reports`.
   */
  async getHistoricalCashReport(
    cashRegisterId: string,
  ): Promise<CashReport & { movementsDetail: HistoricalCashMovement[] }> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'view_reports');

    const register = await repos.cashRegisters.findById(cashRegisterId);
    if (!register) throw new NotFoundError('Caja', cashRegisterId);

    const report = await this.buildReport(register);
    const enriched = await repos.cashRegisters.getMovementsByCashRegister(cashRegisterId);
    const movementsDetail: HistoricalCashMovement[] = enriched.map((m) => ({
      id: m.id,
      date: m.date,
      createdAt: m.createdAt,
      type: m.type,
      amount: m.amount,
      description: m.description,
      paymentMethodId: m.paymentMethodId,
      paymentMethodName: m.paymentMethodName,
      relatedSaleId: m.relatedSaleId,
      relatedPurchaseId: m.relatedPurchaseId,
      saleNumber: m.saleNumber,
      saleType: m.saleType,
      purchaseNumber: m.purchaseNumber,
    }));
    return { ...report, movementsDetail };
  }

  /** Registra un movimiento manual de caja (ingreso/egreso). */
  async addMovement(input: AddMovementInput): Promise<CashMovement> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'add_cash_movement');

    if (cmpDecimal(input.amount, '0') <= 0) {
      throw new BusinessRuleError('invalid_amount', 'El monto debe ser mayor a cero');
    }

    const registerId =
      input.cashRegisterId ??
      (this.ctx.currentCashRegister?.status === 'open'
        ? this.ctx.currentCashRegister.id
        : (await repos.cashRegisters.getCurrentOpen())?.id);
    if (!registerId) {
      throw new BusinessRuleError('no_open_cash_register', 'No hay una caja abierta');
    }

    // Un egreso en EFECTIVO no puede sacar del cajón más de lo que hay.
    // (Los medios electrónicos no tienen esta restricción física; los reversos
    // de anulaciones tampoco pasan por acá — van directo al repositorio.)
    if (input.type === 'expense') {
      const pmById = await repos.paymentMethods.byId();
      const fisico = input.paymentMethodId == null || pmById.get(input.paymentMethodId)?.isPhysicalCash === true;
      if (fisico) await assertPhysicalCashAvailable(repos, registerId, input.amount);
    }

    return repos.cashMovements.createInOpenRegister({
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
    const [rawMovements, pmById, commission] = await Promise.all([
      repos.cashMovements.findByRegister(register.id),
      repos.paymentMethods.byId(),
      repos.salePayments.getCommissionByRegister(register.id),
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
          commissionTotal: m.paymentMethodId
            ? commission.byMethod.get(m.paymentMethodId) ?? '0.0000'
            : '0.0000',
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
      commissionTotal: commission.total,
      expectedCash,
      closingAmount: register.closingAmount ?? null,
      difference,
      byPaymentMethod,
      movements,
    };
  }
}
