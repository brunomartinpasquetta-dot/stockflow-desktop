import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  CreateSupplierAccountPaymentSchema,
  CreateSupplierPaymentSchema,
  type CreateSupplierAccountPaymentInput,
  type CreateSupplierPaymentInput,
  addDecimal,
  cmpDecimal,
  subDecimal,
  sumDecimals,
} from '@stockflow/shared';

import { ConstraintError, NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  cashGeneral,
  cashGeneralMovements,
  cashMovements,
  paymentMethods,
  suppliers,
  supplierAccountsPayable,
  supplierPayments,
  type NewSupplierPayment,
  type PaymentMethod,
  type SupplierAccountPayable,
  type SupplierPayment,
} from '../schema/local';
import { BaseRepository } from './base.repository';

/** Tipo del `tx` dentro de `db.transaction((tx) => …)`. */
type Tx = Parameters<Parameters<LocalDatabase['transaction']>[0]>[0];

/**
 * Egreso de CAJA GENERAL por un pago a proveedor (fundingSource='general'),
 * DENTRO de la transacción del pago. Mismo patrón que las compras contado
 * desde Caja General (purchase.repository): un solo movimiento por el total,
 * desglose efectivo/electrónico según isPhysicalCash de los medios usados,
 * el TOTAL se deriva del saldo previo y el reparto se mueve por deltas.
 * Categoría propia 'supplier_payment' para poder distinguirlo en el listado.
 */
function cashGeneralExpenseInTx(
  tx: Tx,
  opts: {
    total: string;
    parts: { paymentMethodId: string; amount: string }[];
    pmMap: Map<string, PaymentMethod>;
    description: string;
    referenceId: string;
    userId: string;
    now: number;
  },
): void {
  const cgCur = tx.select().from(cashGeneral).where(eq(cashGeneral.id, 'singleton')).get();
  const prevBalance = cgCur?.currentBalance ?? '0';
  const prevCash = cgCur?.cashBalance ?? '0';
  const prevElec = cgCur?.electronicBalance ?? '0';
  // Defensa doble (el service ya validó): sin saldo no hay pago.
  if (cmpDecimal(prevBalance, opts.total) < 0) {
    throw new ConstraintError(
      'INSUFFICIENT_CASH_GENERAL',
      `Caja General no tiene saldo suficiente (disponible ${prevBalance}, pago ${opts.total})`,
    );
  }
  let cashPart = '0';
  let elecPart = '0';
  for (const p of opts.parts) {
    const pm = opts.pmMap.get(p.paymentMethodId);
    if (!pm) throw new NotFoundError('Medio de pago', p.paymentMethodId);
    if (pm.isPhysicalCash) cashPart = addDecimal(cashPart, p.amount, 2);
    else elecPart = addDecimal(elecPart, p.amount, 2);
  }
  const balanceAfter = subDecimal(prevBalance, opts.total, 2);
  const balanceAfterCash = subDecimal(prevCash, cashPart, 2);
  const balanceAfterElec = subDecimal(prevElec, elecPart, 2);
  tx.insert(cashGeneralMovements)
    .values({
      id: uuidv7(),
      type: 'expense',
      amount: opts.total,
      description: opts.description,
      category: 'supplier_payment',
      createdBy: opts.userId,
      referenceId: opts.referenceId,
      balanceAfter,
      isCash: Number(cashPart) >= Number(elecPart),
      balanceAfterCash,
      balanceAfterElectronic: balanceAfterElec,
      createdAt: opts.now,
    })
    .run();
  if (cgCur) {
    tx.update(cashGeneral)
      .set({
        currentBalance: balanceAfter,
        cashBalance: balanceAfterCash,
        electronicBalance: balanceAfterElec,
        lastUpdate: opts.now,
      })
      .where(eq(cashGeneral.id, 'singleton'))
      .run();
  } else {
    tx.insert(cashGeneral)
      .values({
        id: 'singleton',
        currentBalance: balanceAfter,
        cashBalance: balanceAfterCash,
        electronicBalance: balanceAfterElec,
        lastUpdate: opts.now,
        createdAt: opts.now,
      })
      .run();
  }
}

/** Resultado de un pago a nivel cuenta de proveedor (distribuido FIFO). */
export interface SupplierAccountPaymentResult {
  payments: SupplierPayment[];
  accounts: SupplierAccountPayable[];
  totalApplied: string;
}

export class SupplierPaymentRepository extends BaseRepository<
  SupplierPayment,
  NewSupplierPayment
> {
  constructor(db: LocalDatabase) {
    super(db, supplierPayments, 'Pago a proveedor');
  }

  async findByAccount(accountId: string): Promise<SupplierPayment[]> {
    try {
      return this.db.select().from(supplierPayments).where(eq(supplierPayments.accountId, accountId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async existsForPaymentMethod(paymentMethodId: string): Promise<boolean> {
    try {
      const row = this.db
        .select({ id: supplierPayments.id })
        .from(supplierPayments)
        .where(eq(supplierPayments.paymentMethodId, paymentMethodId))
        .limit(1)
        .get();
      return !!row;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Registra un pago (posiblemente mixto) a una cuenta de proveedor: inserta N
   * filas de pago, descuenta el saldo de la cuenta (recalculando su estado) y
   * genera un egreso de caja por cada pago (sólo los de efectivo físico afectan
   * el arqueo). Lanza `ConstraintError` si el total pagado supera el saldo.
   */
  async createPayment(rawData: CreateSupplierPaymentInput): Promise<SupplierPayment[]> {
    try {
      const data = this.parseOrThrow<CreateSupplierPaymentInput>(CreateSupplierPaymentSchema, rawData);
      const now = data.date ?? Date.now();
      const totalPaid = sumDecimals(data.payments.map((p) => p.amount));

      return this.db.transaction((tx) => {
        const account = tx
          .select()
          .from(supplierAccountsPayable)
          .where(eq(supplierAccountsPayable.id, data.accountId))
          .get();
        if (!account) throw new NotFoundError('Cuenta de proveedor', data.accountId);
        if (cmpDecimal(totalPaid, '0') <= 0) {
          throw new ConstraintError('SUPPLIER_PAYMENT_ZERO', 'El pago debe ser mayor a cero');
        }
        if (cmpDecimal(totalPaid, account.balance) > 0) {
          throw new ConstraintError(
            'SUPPLIER_PAYMENT_EXCEEDS_BALANCE',
            `El pago (${totalPaid}) supera el saldo de la cuenta (${account.balance})`,
          );
        }

        const fromGeneral = data.fundingSource === 'general';
        if (!fromGeneral && !data.cashRegisterId) {
          throw new ConstraintError(
            'SUPPLIER_PAYMENT_NO_REGISTER',
            'Falta la caja diaria para registrar el egreso del pago',
          );
        }

        const pmIds = [...new Set(data.payments.map((p) => p.paymentMethodId))];
        const pmRows = tx.select().from(paymentMethods).where(inArray(paymentMethods.id, pmIds)).all();
        const pmMap = new Map(pmRows.map((r) => [r.id, r]));

        const inserted: SupplierPayment[] = [];
        for (const p of data.payments) {
          const pm = pmMap.get(p.paymentMethodId);
          if (!pm) throw new NotFoundError('Medio de pago', p.paymentMethodId);
          const row = tx
            .insert(supplierPayments)
            .values({
              accountId: data.accountId,
              paymentMethodId: p.paymentMethodId,
              amount: p.amount,
              date: now,
              reference: p.reference ?? null,
              notes: data.notes ?? null,
            })
            .returning()
            .all()[0];
          if (!row) throw new ConstraintError('SUPPLIER_PAYMENT_INSERT', 'No se pudo registrar el pago');
          inserted.push(row);
          if (fromGeneral) continue; // el egreso va a Caja General, un solo movimiento al final
          const desc = pm.isPhysicalCash
            ? 'Pago a proveedor'
            : `Pago a proveedor — ${pm.name}`;
          tx
            .insert(cashMovements)
            .values({
              cashRegisterId: data.cashRegisterId!,
              type: 'expense',
              description: desc,
              amount: p.amount,
              date: now,
              userId: data.userId,
              paymentMethodId: pm.id,
            })
            .run();
        }

        if (fromGeneral) {
          const supplierRow = tx
            .select({ name: suppliers.name })
            .from(suppliers)
            .where(eq(suppliers.id, account.supplierId))
            .get();
          cashGeneralExpenseInTx(tx, {
            total: totalPaid,
            parts: data.payments.map((p) => ({ paymentMethodId: p.paymentMethodId, amount: p.amount })),
            pmMap,
            description: `Pago a proveedor — ${supplierRow?.name ?? 'proveedor'}`,
            referenceId: data.accountId,
            userId: data.userId,
            now,
          });
        }

        const newBalance = subDecimal(account.balance, totalPaid, 4);
        const newStatus =
          cmpDecimal(newBalance, '0') === 0
            ? 'paid'
            : cmpDecimal(newBalance, account.total) === 0
              ? 'open'
              : 'partial';
        tx
          .update(supplierAccountsPayable)
          .set({ balance: newBalance, status: newStatus })
          .where(eq(supplierAccountsPayable.id, data.accountId))
          .run();

        return inserted;
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Registra un pago a NIVEL CUENTA de proveedor: un monto (posiblemente mixto)
   * que se aplica al saldo total del proveedor distribuyéndose automáticamente
   * entre sus comprobantes abiertos en orden FIFO (del más viejo al más nuevo),
   * todo en una transacción. Por cada (comprobante × medio) usado inserta una
   * fila de pago y un egreso de caja; recalcula balance/status de cada comprobante
   * igual que `createPayment`. Lanza `ConstraintError` si el total pagado supera
   * la suma de saldos abiertos.
   */
  async createAccountPayment(
    rawData: CreateSupplierAccountPaymentInput,
  ): Promise<SupplierAccountPaymentResult> {
    try {
      const data = this.parseOrThrow<CreateSupplierAccountPaymentInput>(
        CreateSupplierAccountPaymentSchema,
        rawData,
      );
      const now = data.date ?? Date.now();
      const total = sumDecimals(data.payments.map((p) => p.amount));

      return this.db.transaction((tx) => {
        if (cmpDecimal(total, '0') <= 0) {
          throw new ConstraintError('SUPPLIER_PAYMENT_ZERO', 'El pago debe ser mayor a cero');
        }

        const supplier = tx
          .select({ name: suppliers.name })
          .from(suppliers)
          .where(eq(suppliers.id, data.supplierId))
          .get();
        if (!supplier) throw new NotFoundError('Proveedor', data.supplierId);
        const supplierName = supplier.name;

        const openSAPs = tx
          .select()
          .from(supplierAccountsPayable)
          .where(
            and(
              eq(supplierAccountsPayable.supplierId, data.supplierId),
              ne(supplierAccountsPayable.status, 'paid'),
            ),
          )
          .orderBy(asc(supplierAccountsPayable.createdAt))
          .all();

        const totalOpen = sumDecimals(openSAPs.map((sap) => sap.balance));
        if (cmpDecimal(total, totalOpen) > 0) {
          throw new ConstraintError(
            'SUPPLIER_PAYMENT_EXCEEDS_BALANCE',
            `El pago (${total}) supera el saldo total del proveedor (${totalOpen})`,
          );
        }

        const pmIds = [...new Set(data.payments.map((p) => p.paymentMethodId))];
        const pmRows = tx
          .select()
          .from(paymentMethods)
          .where(inArray(paymentMethods.id, pmIds))
          .all();
        const pmMap = new Map(pmRows.map((r) => [r.id, r]));
        for (const p of data.payments) {
          if (!pmMap.has(p.paymentMethodId)) {
            throw new NotFoundError('Medio de pago', p.paymentMethodId);
          }
        }

        const fromGeneral = data.fundingSource === 'general';
        if (!fromGeneral && !data.cashRegisterId) {
          throw new ConstraintError(
            'SUPPLIER_PAYMENT_NO_REGISTER',
            'Falta la caja diaria para registrar el egreso del pago',
          );
        }

        const remaining = data.payments.map((p) => ({
          methodId: p.paymentMethodId,
          amount: p.amount,
          reference: p.reference ?? null,
        }));

        const inserted: SupplierPayment[] = [];
        const updatedAccounts: SupplierAccountPayable[] = [];
        let totalRestante = total;

        for (const sap of openSAPs) {
          if (cmpDecimal(totalRestante, '0') <= 0) break;
          const sapPortion =
            cmpDecimal(sap.balance, totalRestante) <= 0 ? sap.balance : totalRestante;
          if (cmpDecimal(sapPortion, '0') <= 0) continue;

          let toFill = sapPortion;
          for (const m of remaining) {
            if (cmpDecimal(m.amount, '0') <= 0) continue;
            if (cmpDecimal(toFill, '0') <= 0) break;
            const take = cmpDecimal(m.amount, toFill) <= 0 ? m.amount : toFill;
            const pm = pmMap.get(m.methodId)!;

            const row = tx
              .insert(supplierPayments)
              .values({
                accountId: sap.id,
                paymentMethodId: m.methodId,
                amount: take,
                date: now,
                reference: m.reference,
                notes: data.notes ?? null,
              })
              .returning()
              .all()[0];
            if (!row) {
              throw new ConstraintError('SUPPLIER_PAYMENT_INSERT', 'No se pudo registrar el pago');
            }
            inserted.push(row);

            if (!fromGeneral) {
              const desc = pm.isPhysicalCash
                ? `Pago a proveedor — ${supplierName}`
                : `Pago a proveedor — ${supplierName} — ${pm.name}`;
              tx
                .insert(cashMovements)
                .values({
                  cashRegisterId: data.cashRegisterId!,
                  type: 'expense',
                  description: desc,
                  amount: take,
                  date: now,
                  userId: data.userId,
                  paymentMethodId: pm.id,
                })
                .run();
            }

            m.amount = subDecimal(m.amount, take, 4);
            toFill = subDecimal(toFill, take, 4);
          }

          const newBalance = subDecimal(sap.balance, sapPortion, 4);
          const newStatus =
            cmpDecimal(newBalance, '0') === 0
              ? 'paid'
              : cmpDecimal(newBalance, sap.total) === 0
                ? 'open'
                : 'partial';
          const updated = tx
            .update(supplierAccountsPayable)
            .set({ balance: newBalance, status: newStatus })
            .where(eq(supplierAccountsPayable.id, sap.id))
            .returning()
            .all()[0];
          if (updated) updatedAccounts.push(updated);

          totalRestante = subDecimal(totalRestante, sapPortion, 4);
        }

        if (fromGeneral) {
          cashGeneralExpenseInTx(tx, {
            total,
            parts: data.payments.map((p) => ({ paymentMethodId: p.paymentMethodId, amount: p.amount })),
            pmMap,
            description: `Pago a proveedor — ${supplierName}`,
            referenceId: data.supplierId,
            userId: data.userId,
            now,
          });
        }

        return { payments: inserted, accounts: updatedAccounts, totalApplied: total };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
