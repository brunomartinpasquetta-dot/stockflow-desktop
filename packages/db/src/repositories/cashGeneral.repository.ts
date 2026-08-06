/**
 * Repositorio Caja General: saldo histórico global (caja fuerte / acumulado).
 *
 * Single-row pattern: hay UNA sola fila en `cash_general` con id='singleton'
 * (creada por la migración 0007). Los movimientos van a `cash_general_movements`.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { addDecimal, subDecimal } from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashGeneral,
  cashGeneralMovements,
  cashMovements,
  cashRegisters,
  paymentMethods,
  type CashGeneralMovement,
} from '../schema/local';

const SINGLETON_ID = 'singleton';

export type CashGeneralMovementType = 'income' | 'expense' | 'transfer_from_daily';
export type CashGeneralCategory = 'deposit' | 'close_deposit' | 'withdrawal' | 'service' | 'salary' | 'other';

export interface AddCashGeneralMovementInput {
  type: CashGeneralMovementType;
  amount: string;
  description: string;
  category?: CashGeneralCategory | null;
  createdBy: string;
  referenceId?: string | null;
  /** true = efectivo físico, false = electrónico. Default efectivo. */
  isCash?: boolean;
}

export interface TransferFromDailyRepoInput {
  /** Caja diaria de origen (debe estar abierta). */
  cashRegisterId: string;
  amount: string;
  createdBy: string;
  /**
   * Desglose del depósito. Si se omite, todo se toma como efectivo (retrocompat).
   * `cashAmount + electronicAmount` debe ser igual a `amount`.
   */
  cashAmount?: string;
  electronicAmount?: string;
  /**
   * Tope de lo que ese cierre puede aportar (efectivo contado + neto de los
   * demás medios). Presente sólo en el depósito de cierre: habilita completar
   * un depósito parcial sin permitir depositar de más.
   */
  maxDepositable?: string;
}

/** Saldo de Caja General discriminado por naturaleza del dinero. */
export interface CashGeneralBalance {
  total: string;
  cash: string;
  electronic: string;
}

export interface ListMovementsFilter {
  from?: number;
  to?: number;
  type?: CashGeneralMovementType;
  category?: CashGeneralCategory;
  limit?: number;
}

export class CashGeneralRepository {
  constructor(private readonly db: LocalDatabase) {}

  /** Devuelve el saldo actual TOTAL (string decimal). Retrocompatible. */
  async getBalance(): Promise<string> {
    try {
      const row = this.db
        .select()
        .from(cashGeneral)
        .where(eq(cashGeneral.id, SINGLETON_ID))
        .get();
      return row?.currentBalance ?? '0';
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Devuelve el saldo discriminado en efectivo / electrónico / total. */
  /**
   * Declara cuánto del saldo está en EFECTIVO. El resto queda como
   * electrónico: el TOTAL no se toca y ningún movimiento se modifica ni se
   * borra — sólo se corrige el reparto entre las dos columnas.
   *
   * Hace falta porque el reparto puede desviarse de la realidad (historial
   * sin discriminar, o compras que se pagaron por transferencia y el sistema
   * descontaba del efectivo). El comercio es el único que sabe cuánto tiene
   * en la caja fuerte, así que lo declara y a partir de ahí el sistema lo
   * sigue llevando bien.
   */
  async adjustBreakdown(cashAmount: string, userId: string): Promise<CashGeneralBalance> {
    try {
      return this.db.transaction((tx) => {
        const row = tx.select().from(cashGeneral).where(eq(cashGeneral.id, SINGLETON_ID)).get();
        const total = row?.currentBalance ?? '0';
        if (Number(cashAmount) < 0) {
          throw new ConstraintError('NEGATIVE_CASH', 'El efectivo no puede ser negativo');
        }
        if (Number(cashAmount) > Number(total) + 0.005) {
          throw new ConstraintError(
            'CASH_OVER_TOTAL',
            `El efectivo declarado no puede superar el saldo total (${total})`,
          );
        }
        const electronic = subDecimal(total, cashAmount, 2);
        tx.update(cashGeneral)
          .set({ cashBalance: cashAmount, electronicBalance: electronic, lastUpdate: Date.now() })
          .where(eq(cashGeneral.id, SINGLETON_ID))
          .run();
        return { total, cash: cashAmount, electronic };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async getBalanceBreakdown(): Promise<CashGeneralBalance> {
    try {
      const row = this.db
        .select()
        .from(cashGeneral)
        .where(eq(cashGeneral.id, SINGLETON_ID))
        .get();
      return {
        total: row?.currentBalance ?? '0',
        cash: row?.cashBalance ?? '0',
        electronic: row?.electronicBalance ?? '0',
      };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findMovements(filter: ListMovementsFilter = {}): Promise<CashGeneralMovement[]> {
    try {
      const conds: SQL[] = [];
      if (filter.from != null) conds.push(gte(cashGeneralMovements.createdAt, filter.from));
      if (filter.to != null) conds.push(lte(cashGeneralMovements.createdAt, filter.to));
      if (filter.type) conds.push(eq(cashGeneralMovements.type, filter.type));
      if (filter.category) conds.push(eq(cashGeneralMovements.category, filter.category));

      let q = this.db.select().from(cashGeneralMovements).$dynamic();
      if (conds.length > 0) q = q.where(conds.length === 1 ? conds[0]! : and(...conds)!);
      q = q.orderBy(desc(cashGeneralMovements.createdAt));
      if (filter.limit != null && filter.limit > 0) q = q.limit(filter.limit);
      return q.all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Aplica un movimiento a los saldos (efectivo/electrónico/total) y lo inserta,
   * actualizando el singleton. Centraliza la lógica de los 3 flujos de ingreso.
   * `cashDelta`/`electronicDelta` son montos POSITIVOS a aplicar en el signo de
   * `isCredit`. Devuelve el movimiento insertado.
   */
  private applyMovement(
    tx: Parameters<Parameters<LocalDatabase['transaction']>[0]>[0],
    args: {
      type: CashGeneralMovementType;
      amount: string;
      description: string;
      category: CashGeneralCategory | null;
      createdBy: string;
      referenceId: string | null;
      cashDelta: string;
      electronicDelta: string;
      isCash: boolean;
      now: number;
    },
  ): CashGeneralMovement {
    const cur = tx.select().from(cashGeneral).where(eq(cashGeneral.id, SINGLETON_ID)).get();
    const prevTotal = cur?.currentBalance ?? '0';
    const prevCash = cur?.cashBalance ?? '0';
    const prevElec = cur?.electronicBalance ?? '0';

    const isCredit = args.type === 'income' || args.type === 'transfer_from_daily';
    const op = isCredit ? addDecimal : subDecimal;
    const balanceAfterCash = op(prevCash, args.cashDelta, 2);
    const balanceAfterElectronic = op(prevElec, args.electronicDelta, 2);
    // El TOTAL se deriva del saldo anterior ± el importe del movimiento, NO de
    // la suma de los dos parciales: si el desglose quedara desincronizado (como
    // pasó al migrar una caja que ya tenía saldo sin discriminar), sumar las
    // columnas arrastraría el error al total, que es el número que el comercio
    // usa todos los días.
    const balanceAfter = op(prevTotal, args.amount, 2);

    const newRow = {
      id: uuidv7(),
      type: args.type,
      amount: args.amount,
      description: args.description,
      category: args.category,
      createdBy: args.createdBy,
      referenceId: args.referenceId,
      balanceAfter,
      isCash: args.isCash,
      balanceAfterCash,
      balanceAfterElectronic,
      createdAt: args.now,
    };
    const inserted = tx.insert(cashGeneralMovements).values(newRow).returning().all();

    if (cur) {
      tx.update(cashGeneral)
        .set({
          currentBalance: balanceAfter,
          cashBalance: balanceAfterCash,
          electronicBalance: balanceAfterElectronic,
          lastUpdate: args.now,
        })
        .where(eq(cashGeneral.id, SINGLETON_ID))
        .run();
    } else {
      tx.insert(cashGeneral)
        .values({
          id: SINGLETON_ID,
          currentBalance: balanceAfter,
          cashBalance: balanceAfterCash,
          electronicBalance: balanceAfterElectronic,
          lastUpdate: args.now,
          createdAt: args.now,
        })
        .run();
    }

    const out = inserted[0];
    if (!out) throw new Error('No se devolvió el movimiento insertado');
    return out;
  }

  /**
   * Crea un movimiento manual de caja general (ingreso/egreso). El delta se
   * aplica al saldo de efectivo o electrónico según `isCash` (default efectivo).
   */
  async addMovement(input: AddCashGeneralMovementInput): Promise<CashGeneralMovement> {
    try {
      const isCash = input.isCash ?? true;
      return this.db.transaction((tx) =>
        this.applyMovement(tx, {
          type: input.type,
          amount: input.amount,
          description: input.description,
          category: input.category ?? null,
          createdBy: input.createdBy,
          referenceId: input.referenceId ?? null,
          cashDelta: isCash ? input.amount : '0',
          electronicDelta: isCash ? '0' : input.amount,
          isCash,
          now: Date.now(),
        }),
      );
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Transfiere efectivo de una caja diaria a la Caja General de forma ATÓMICA
   * (BUG-S01). Dentro de una sola transacción:
   *  1. valida que la caja diaria exista y esté abierta,
   *  2. inserta un `cash_movements` de tipo `expense` en la caja diaria origen
   *     (la contrapartida del dinero que sale del cajón), con el medio de pago
   *     de efectivo físico,
   *  3. inserta el `cash_general_movements` (type='transfer_from_daily'),
   *  4. actualiza el balance de la fila singleton de `cash_general`.
   *
   * Esto evita la duplicación: antes el dinero sumaba en Caja General pero nunca
   * descontaba de la caja diaria de origen.
   */
  /**
   * Ingreso a Caja General al CERRAR la caja diaria (flujo automático de cierre).
   * A diferencia de `transferFromDaily`, la caja debe estar CERRADA: el arqueo
   * ya quedó firme y acá solo se deposita la recaudación en Caja General (no se
   * toca la caja diaria — no genera cash_movement, no descuadra el cierre).
   * Idempotente por caja: un solo depósito de cierre por arqueo.
   */
  /**
   * De un conjunto de cajas cerradas, cuáles YA tienen su depósito de cierre
   * en Caja General. Sirve para que el historial marque los cierres huérfanos
   * (el diálogo de depósito aparece una sola vez tras el cierre: si se pierde
   * —error, reinicio, "No ingresar" por equivocación— acá se recupera).
   */
  async closeDepositRefIds(cashRegisterIds: string[]): Promise<Map<string, string>> {
    try {
      const acc = new Map<string, string>();
      if (cashRegisterIds.length === 0) return acc;
      const rows = this.db
        .select()
        .from(cashGeneralMovements)
        .where(
          and(
            eq(cashGeneralMovements.category, 'close_deposit'),
            inArray(cashGeneralMovements.referenceId, cashRegisterIds),
          ),
        )
        .all();
      // Puede haber más de un depósito por caja (un complemento tras uno
      // parcial), así que se acumulan.
      for (const r of rows) {
        if (!r.referenceId) continue;
        acc.set(r.referenceId, addDecimal(acc.get(r.referenceId) ?? '0', r.amount, 2));
      }
      return acc;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async transferFromClosed(input: TransferFromDailyRepoInput): Promise<CashGeneralMovement> {
    try {
      return this.db.transaction((tx) => {
        const now = Date.now();

        const reg = tx
          .select()
          .from(cashRegisters)
          .where(eq(cashRegisters.id, input.cashRegisterId))
          .get();
        if (!reg) throw new NotFoundError('Caja', input.cashRegisterId);
        if (reg.status !== 'closed') {
          throw new ConstraintError(
            'REGISTER_NOT_CLOSED',
            'El depósito de cierre se hace después de confirmar el cierre de la caja',
          );
        }

        // Se admite completar un depósito parcial (el usuario puede haber
        // ingresado sólo el efectivo y olvidado la parte electrónica), pero
        // NUNCA depositar más de lo que ese cierre recaudó: eso inventaría
        // plata que no existe.
        const previos = tx
          .select()
          .from(cashGeneralMovements)
          .where(
            and(
              eq(cashGeneralMovements.referenceId, input.cashRegisterId),
              eq(cashGeneralMovements.category, 'close_deposit'),
            ),
          )
          .all();
        let yaDepositado = '0';
        for (const p of previos) yaDepositado = addDecimal(yaDepositado, p.amount, 2);
        if (input.maxDepositable != null) {
          const tope = Number(input.maxDepositable);
          if (Number(yaDepositado) + Number(input.amount) > tope + 0.005) {
            const resta = Math.max(0, tope - Number(yaDepositado));
            throw new ConstraintError(
              'DEPOSIT_OVER_CLOSE',
              resta <= 0.005
                ? `El cierre de la caja #${reg.number} ya fue ingresado completo a Caja General`
                : `Del cierre de la caja #${reg.number} queda por ingresar ${resta.toFixed(2)}`,
            );
          }
        } else if (previos.length > 0) {
          throw new ConstraintError(
            'ALREADY_DEPOSITED',
            `El cierre de la caja #${reg.number} ya fue ingresado a Caja General`,
          );
        }

        // Desglose efectivo/electrónico del depósito (default: todo efectivo).
        const cashAmount = input.cashAmount ?? input.amount;
        const electronicAmount = input.electronicAmount ?? '0';
        // El movimiento se marca como "efectivo" si su parte física es la mayor;
        // es solo una etiqueta de fila (los saldos se llevan por los deltas).
        const isCash = Number(cashAmount) >= Number(electronicAmount);

        return this.applyMovement(tx, {
          type: 'transfer_from_daily',
          amount: input.amount,
          description: `Cierre de caja #${reg.number}`,
          category: 'close_deposit',
          createdBy: input.createdBy,
          referenceId: input.cashRegisterId,
          cashDelta: cashAmount,
          electronicDelta: electronicAmount,
          isCash,
          now,
        });
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async transferFromDaily(input: TransferFromDailyRepoInput): Promise<CashGeneralMovement> {
    try {
      return this.db.transaction((tx) => {
        const now = Date.now();

        // 1) Validar caja diaria (debe existir y estar abierta).
        const reg = tx
          .select()
          .from(cashRegisters)
          .where(eq(cashRegisters.id, input.cashRegisterId))
          .get();
        if (!reg) throw new NotFoundError('Caja', input.cashRegisterId);
        if (reg.status !== 'open') {
          throw new ConstraintError(
            'REGISTER_NOT_OPEN',
            'Sólo se puede transferir a Caja General desde una caja diaria abierta',
          );
        }

        // 2) Resolver el medio de pago de efectivo físico.
        const cashPm = tx
          .select()
          .from(paymentMethods)
          .where(and(eq(paymentMethods.type, 'cash'), eq(paymentMethods.isPhysicalCash, true)))
          .orderBy(asc(paymentMethods.sortOrder))
          .get();
        if (!cashPm) {
          throw new ConstraintError(
            'NO_CASH_PAYMENT_METHOD',
            'No hay un medio de pago de efectivo físico configurado',
          );
        }

        // 3) Egreso en la caja diaria origen (contrapartida contable).
        tx
          .insert(cashMovements)
          .values({
            cashRegisterId: input.cashRegisterId,
            type: 'expense',
            description: 'Transferencia a Caja General',
            amount: input.amount,
            date: now,
            userId: input.createdBy,
            paymentMethodId: cashPm.id,
          })
          .run();

        // 4) Movimiento + balance de Caja General. Es efectivo físico que sale
        //    del cajón de la caja diaria → suma al saldo de EFECTIVO.
        return this.applyMovement(tx, {
          type: 'transfer_from_daily',
          amount: input.amount,
          description: 'Transferencia desde caja diaria',
          category: 'deposit',
          createdBy: input.createdBy,
          referenceId: input.cashRegisterId,
          cashDelta: input.amount,
          electronicDelta: '0',
          isCash: true,
          now,
        });
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Conteo de movimientos (para diagnóstico/tests). */
  async count(): Promise<number> {
    try {
      const r = this.db
        .select({ c: sql<number>`count(*)` })
        .from(cashGeneralMovements)
        .get();
      return Number(r?.c ?? 0);
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
