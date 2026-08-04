import { and, asc, desc, eq, gte, lte, max } from 'drizzle-orm';
import {
  CloseCashRegisterSchema,
  OpenCashRegisterSchema,
  type CloseCashRegisterInput,
  type OpenCashRegisterInput,
  sumDecimals,
  subDecimal,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashMovements,
  cashRegisters,
  paymentMethods,
  purchases,
  sales,
  type CashMovement,
  type CashRegister,
} from '../schema/local';
import { BaseRepository } from './base.repository';

/** Movimiento enriquecido con datos de venta/compra/medio de pago para el detalle histórico. */
export type CashMovementEnriched = CashMovement & {
  paymentMethodName: string | null;
  saleNumber: number | null;
  saleType: string | null;
  purchaseNumber: number | null;
};

export class CashRegisterRepository extends BaseRepository<
  CashRegister,
  typeof cashRegisters.$inferInsert
> {
  constructor(db: LocalDatabase) {
    super(db, cashRegisters, 'Caja');
  }

  /**
   * Caja abierta de una terminal, o `null`.
   *
   * Con `terminalId` devuelve la caja de ESE puesto (o la compartida heredada,
   * con terminal_id NULL, para no romper instalaciones que ya venían operando).
   * Sin `terminalId` mantiene el comportamiento previo: la última abierta.
   */
  async getCurrentOpen(terminalId?: string | null): Promise<CashRegister | null> {
    try {
      const rows = this.db
        .select()
        .from(cashRegisters)
        .where(eq(cashRegisters.status, 'open'))
        .all();
      if (!terminalId) {
        return rows.sort((a, b) => b.number - a.number)[0] ?? null;
      }
      const mine = rows.filter((r) => r.terminalId === terminalId);
      if (mine.length > 0) return mine.sort((a, b) => b.number - a.number)[0] ?? null;
      // Caja heredada sin terminal asignada: la toma cualquier puesto.
      const shared = rows.filter((r) => r.terminalId == null);
      return shared.sort((a, b) => b.number - a.number)[0] ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Abre una caja nueva. Falla si ya hay una abierta. */
  async openRegister(rawData: unknown): Promise<CashRegister> {
    try {
      const data = this.parseOrThrow<OpenCashRegisterInput>(OpenCashRegisterSchema, rawData);
      return this.db.transaction((tx) => {
        const openRows = tx
          .select({ id: cashRegisters.id, terminalId: cashRegisters.terminalId })
          .from(cashRegisters)
          .where(eq(cashRegisters.status, 'open'))
          .all();
        // Con multi-terminal cada puesto tiene su caja: solo bloquea si ESTA
        // terminal ya tiene una abierta. Sin terminal (instalación de una sola
        // PC) se mantiene la regla previa: una caja a la vez.
        const terminalId = data.terminalId ?? null;
        const conflict = terminalId
          ? openRows.find((r) => r.terminalId === terminalId || r.terminalId == null)
          : openRows[0];
        if (conflict) {
          throw new ConstraintError(
            'CASH_ALREADY_OPEN',
            terminalId
              ? 'Esta terminal ya tiene una caja abierta'
              : 'Ya hay una caja abierta',
          );
        }
        const numRow = tx.select({ value: max(cashRegisters.number) }).from(cashRegisters).get();
        const number = (numRow?.value ?? 0) + 1;
        const now = Date.now();
        const inserted = tx
          .insert(cashRegisters)
          .values({
            number,
            openDate: now,
            openingAmount: data.openingAmount ?? '0.0000',
            status: 'open',
            userId: data.userId,
            terminalId: data.terminalId ?? null,
            terminalName: data.terminalName ?? null,
          })
          .returning()
          .all()[0];
        if (!inserted) throw new ConstraintError('CASH_INSERT', 'No se pudo abrir la caja');
        return inserted;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Cierra una caja: registra `closingAmount`, `closeDate`, calcula la diferencia
   * contra (apertura + ingresos − egresos) y la guarda en `notes`.
   */
  async closeRegister(id: string, rawData: CloseCashRegisterInput): Promise<CashRegister> {
    try {
      const data = this.parseOrThrow<CloseCashRegisterInput>(CloseCashRegisterSchema, rawData);
      return this.db.transaction((tx) => {
        const register = tx.select().from(cashRegisters).where(eq(cashRegisters.id, id)).get();
        if (!register) throw new NotFoundError(this.entityName, id);
        if (register.status === 'closed') {
          throw new ConstraintError('CASH_ALREADY_CLOSED', `La caja ${id} ya está cerrada`);
        }

        // Sólo los movimientos en efectivo físico (o sin medio asignado: legacy) afectan el arqueo.
        const movements = tx
          .select({
            type: cashMovements.type,
            amount: cashMovements.amount,
            pmId: cashMovements.paymentMethodId,
            isCash: paymentMethods.isPhysicalCash,
          })
          .from(cashMovements)
          .leftJoin(paymentMethods, eq(cashMovements.paymentMethodId, paymentMethods.id))
          .where(eq(cashMovements.cashRegisterId, id))
          .all();
        const cashMovs = movements.filter((m) => m.pmId == null || m.isCash === true);
        const incomes = sumDecimals(cashMovs.filter((m) => m.type === 'income').map((m) => m.amount));
        const expenses = sumDecimals(cashMovs.filter((m) => m.type === 'expense').map((m) => m.amount));
        const expected = subDecimal(
          sumDecimals([register.openingAmount, incomes]),
          expenses,
          4,
        );
        const difference = subDecimal(data.closingAmount, expected, 4);
        const arqueo = `Esperado: ${expected} | Declarado: ${data.closingAmount} | Diferencia: ${difference}`;
        const userNotes = data.notes?.trim();
        const notes = userNotes ? `${userNotes}\n${arqueo}` : arqueo;

        const updated = tx
          .update(cashRegisters)
          .set({
            status: 'closed',
            closeDate: Date.now(),
            closingAmount: data.closingAmount,
            notes,
          })
          .where(eq(cashRegisters.id, id))
          .returning()
          .all()[0];
        if (!updated) throw new NotFoundError(this.entityName, id);
        return updated;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByDateRange(opts: {
    from: number;
    to: number;
    userId?: string;
  }): Promise<CashRegister[]> {
    try {
      const conds = [gte(cashRegisters.openDate, opts.from), lte(cashRegisters.openDate, opts.to)];
      if (opts.userId) conds.push(eq(cashRegisters.userId, opts.userId));
      return this.db
        .select()
        .from(cashRegisters)
        .where(and(...conds))
        .orderBy(desc(cashRegisters.openDate))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Movimientos de una caja enriquecidos con: nombre del medio de pago,
   * número/tipo de la venta relacionada y número de la compra relacionada.
   * Ordenados por fecha ASC.
   */
  async getMovementsByCashRegister(cashRegisterId: string): Promise<CashMovementEnriched[]> {
    try {
      const rows = this.db
        .select({
          mov: cashMovements,
          paymentMethodName: paymentMethods.name,
          saleNumber: sales.number,
          saleType: sales.type,
          purchaseNumber: purchases.number,
        })
        .from(cashMovements)
        .leftJoin(paymentMethods, eq(cashMovements.paymentMethodId, paymentMethods.id))
        .leftJoin(sales, eq(cashMovements.relatedSaleId, sales.id))
        .leftJoin(purchases, eq(cashMovements.relatedPurchaseId, purchases.id))
        .where(eq(cashMovements.cashRegisterId, cashRegisterId))
        .orderBy(asc(cashMovements.date))
        .all();
      return rows.map((r) => ({
        ...r.mov,
        paymentMethodName: r.paymentMethodName ?? null,
        saleNumber: r.saleNumber ?? null,
        saleType: r.saleType ?? null,
        purchaseNumber: r.purchaseNumber ?? null,
      }));
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
