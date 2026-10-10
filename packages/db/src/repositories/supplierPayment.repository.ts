import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
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
  cashRegisters,
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
import { exigirCajaAbiertaEnTx } from './cajaAbierta';

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
    /** Pago que originó el egreso: permite corregir después su origen. */
    supplierPaymentId?: string | null;
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
      supplierPaymentId: opts.supplierPaymentId ?? null,
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
        if (!fromGeneral && data.cashRegisterId) exigirCajaAbiertaEnTx(tx, data.cashRegisterId, 'el pago al proveedor');

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
              fundingSource: data.fundingSource,
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
              // Enlace al pago (migración 0042): sin esto no se sabe qué
              // movimiento corresponde a qué pago y el origen no se puede
              // corregir.
              supplierPaymentId: row.id,
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
            supplierPaymentId: inserted[0]?.id ?? null,
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
        if (!fromGeneral && data.cashRegisterId) exigirCajaAbiertaEnTx(tx, data.cashRegisterId, 'el pago al proveedor');

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
                fundingSource: data.fundingSource,
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
                  supplierPaymentId: row.id,
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
            // Un pago FIFO se reparte entre varias facturas: se enlaza el
            // primero, que alcanza para encontrar el grupo por fecha.
            supplierPaymentId: inserted[0]?.id ?? null,
          });
        }

        return { payments: inserted, accounts: updatedAccounts, totalApplied: total };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * CORREGIR DE DÓNDE SALIÓ LA PLATA de un pago a proveedor.
   *
   * El caso real (cliente, 8-oct-2026): pagaron una factura eligiendo «caja
   * diaria» cuando el dinero salió de Caja General. La deuda estaba bien —la
   * factura está pagada— pero el egreso quedó en la caja equivocada, y no
   * había forma de arreglarlo salvo movimientos a mano.
   *
   * Esto NO anula el pago ni toca el saldo del proveedor: sólo mueve el
   * egreso de una caja a la otra.
   *
   * Reglas (las mismas que ya usa la anulación de ventas):
   *  - La devolución del efectivo a una caja diaria CERRADA no puede entrar
   *    ahí (su arqueo ya está hecho y dejaría de cuadrar): va a la caja
   *    abierta de hoy. Lo electrónico sí vuelve a la caja original, porque no
   *    toca el arqueo del efectivo.
   *  - Pasar el egreso A Caja General exige que tenga saldo.
   */
  async corregirOrigen(data: {
    supplierPaymentId: string;
    nuevoOrigen: 'daily' | 'general';
    /** Caja diaria destino cuando el nuevo origen es la caja diaria. */
    cashRegisterId?: string | null;
    userId: string;
  }): Promise<{ movidos: number; destino: 'daily' | 'general'; cajaUsada: string | null }> {
    try {
      return this.db.transaction((tx) => {
        const pago = tx
          .select()
          .from(supplierPayments)
          .where(eq(supplierPayments.id, data.supplierPaymentId))
          .get();
        if (!pago) throw new NotFoundError('Pago a proveedor', data.supplierPaymentId);

        // Todos los pagos registrados en el MISMO acto (misma cuenta, mismo
        // instante): un pago mixto son varias filas y se corrigen juntas.
        const hermanos = tx
          .select()
          .from(supplierPayments)
          .where(and(eq(supplierPayments.accountId, pago.accountId), eq(supplierPayments.date, pago.date)))
          .all();
        const ids = hermanos.map((h) => h.id);
        const total = sumDecimals(hermanos.map((h) => h.amount));
        const now = Date.now();

        const pmRows = tx
          .select()
          .from(paymentMethods)
          .where(inArray(paymentMethods.id, [...new Set(hermanos.map((h) => h.paymentMethodId))]))
          .all();
        const pmMap = new Map(pmRows.map((r) => [r.id, r]));

        const enDiaria: (typeof cashMovements.$inferSelect)[] = tx
          .select()
          .from(cashMovements)
          .where(inArray(cashMovements.supplierPaymentId, ids))
          .all();
        const enGeneral: (typeof cashGeneralMovements.$inferSelect)[] = tx
          .select()
          .from(cashGeneralMovements)
          .where(inArray(cashGeneralMovements.supplierPaymentId, ids))
          .all();

        /**
         * El origen lo dice el PAGO, no los movimientos: después de una
         * corrección quedan movimientos en las dos cajas (el egreso y su
         * devolución) y mirarlos daba siempre el origen viejo. Para los pagos
         * anteriores a la migración 0042, que no lo tienen guardado, se
         * deduce de dónde está el egreso.
         */
        /**
         * PAGOS VIEJOS (anteriores a la migración 0042): no tienen el enlace.
         * Se los reconoce por lo que sí es inequívoco —mismo instante, mismo
         * importe, mismo medio— y se los adopta. Sin esto la corrección no
         * servía para el único caso que la originó, que es justamente un pago
         * ya hecho (Bruno, 10-oct-2026).
         */
        if (enDiaria.length === 0 && enGeneral.length === 0) {
          for (const h of hermanos) {
            const candidatos = tx
              .select()
              .from(cashMovements)
              .where(
                and(
                  eq(cashMovements.type, 'expense'),
                  eq(cashMovements.date, h.date),
                  eq(cashMovements.amount, h.amount),
                  eq(cashMovements.paymentMethodId, h.paymentMethodId),
                  isNull(cashMovements.supplierPaymentId),
                ),
              )
              .all()
              .filter((m) => m.description.startsWith('Pago a proveedor'));
            // Si hay más de uno idéntico no se adivina: se deja que el aviso
            // lo diga, antes que mover la plata equivocada.
            if (candidatos.length === 1) {
              const m = candidatos[0]!;
              tx.update(cashMovements)
                .set({ supplierPaymentId: h.id })
                .where(eq(cashMovements.id, m.id))
                .run();
              enDiaria.push({ ...m, supplierPaymentId: h.id });
            }
          }
          if (enDiaria.length === 0) {
            const cgCands = tx
              .select()
              .from(cashGeneralMovements)
              .where(
                and(
                  eq(cashGeneralMovements.type, 'expense'),
                  eq(cashGeneralMovements.amount, total),
                  eq(cashGeneralMovements.referenceId, pago.accountId),
                  isNull(cashGeneralMovements.supplierPaymentId),
                ),
              )
              .all();
            if (cgCands.length === 1) {
              const m = cgCands[0]!;
              tx.update(cashGeneralMovements)
                .set({ supplierPaymentId: pago.id })
                .where(eq(cashGeneralMovements.id, m.id))
                .run();
              enGeneral.push({ ...m, supplierPaymentId: pago.id });
            }
          }
        }

        const origenActual: 'daily' | 'general' =
          pago.fundingSource === 'general' || pago.fundingSource === 'daily'
            ? pago.fundingSource
            : enDiaria.length > 0
              ? 'daily'
              : 'general';
        if (enDiaria.length === 0 && enGeneral.length === 0) {
          throw new ConstraintError(
            'PAYMENT_WITHOUT_MOVEMENT',
            'Este pago es anterior a la versión que guarda de dónde salió el dinero, así que no se puede corregir solo. Hay que ajustarlo a mano.',
          );
        }
        if (origenActual === data.nuevoOrigen) {
          throw new ConstraintError(
            'SAME_FUNDING_SOURCE',
            data.nuevoOrigen === 'daily'
              ? 'El pago ya figura como salido de la caja diaria.'
              : 'El pago ya figura como salido de Caja General.',
          );
        }

        if (data.nuevoOrigen === 'general') {
          // Devolver a la caja diaria lo que no salió de ahí…
          const aDevolver = enDiaria.filter((m) => m.type === 'expense');
          for (const mv of aDevolver) {
            const pm = mv.paymentMethodId ? pmMap.get(mv.paymentMethodId) : undefined;
            const esEfectivo = pm == null || pm.isPhysicalCash === true;
            let destinoCaja = mv.cashRegisterId;
            if (esEfectivo) {
              const reg = tx
                .select({ status: cashRegisters.status })
                .from(cashRegisters)
                .where(eq(cashRegisters.id, mv.cashRegisterId))
                .get();
              if (reg?.status !== 'open') {
                const abierta = tx
                  .select({ id: cashRegisters.id })
                  .from(cashRegisters)
                  .where(eq(cashRegisters.status, 'open'))
                  .limit(1)
                  .get();
                if (!abierta) {
                  throw new ConstraintError(
                    'NO_OPEN_REGISTER',
                    'La caja de ese pago está cerrada y no hay ninguna abierta: abra la caja para devolverle el efectivo.',
                  );
                }
                destinoCaja = abierta.id;
              }
            }
            tx.insert(cashMovements)
              .values({
                cashRegisterId: destinoCaja,
                type: 'income',
                description: `Corrección: el pago a proveedor salió de Caja General`,
                amount: mv.amount,
                date: now,
                userId: data.userId,
                paymentMethodId: mv.paymentMethodId,
                supplierPaymentId: mv.supplierPaymentId,
              })
              .run();
          }
          // …y descontarlo de Caja General, que es de donde salió de verdad.
          cashGeneralExpenseInTx(tx, {
            total,
            parts: hermanos.map((h) => ({ paymentMethodId: h.paymentMethodId, amount: h.amount })),
            pmMap,
            description: 'Pago a proveedor (corrección de origen)',
            referenceId: pago.accountId,
            userId: data.userId,
            now,
            supplierPaymentId: pago.id,
          });
          tx.update(supplierPayments).set({ fundingSource: 'general' }).where(inArray(supplierPayments.id, ids)).run();
          return { movidos: aDevolver.length, destino: 'general' as const, cajaUsada: null };
        }

        // general → daily: se devuelve a Caja General y sale de la caja diaria.
        const caja =
          data.cashRegisterId ??
          tx.select({ id: cashRegisters.id }).from(cashRegisters).where(eq(cashRegisters.status, 'open')).limit(1).get()
            ?.id;
        if (!caja) {
          throw new ConstraintError(
            'NO_OPEN_REGISTER',
            'No hay una caja diaria abierta para registrar el egreso.',
          );
        }
        exigirCajaAbiertaEnTx(tx, caja, 'la corrección del pago');
        const cgCur = tx.select().from(cashGeneral).where(eq(cashGeneral.id, 'singleton')).get();
        let cashPart = '0';
        let elecPart = '0';
        for (const h of hermanos) {
          const pm = pmMap.get(h.paymentMethodId);
          if (pm?.isPhysicalCash === false) elecPart = addDecimal(elecPart, h.amount, 2);
          else cashPart = addDecimal(cashPart, h.amount, 2);
        }
        const balanceAfter = addDecimal(cgCur?.currentBalance ?? '0', total, 2);
        const balanceAfterCash = addDecimal(cgCur?.cashBalance ?? '0', cashPart, 2);
        const balanceAfterElec = addDecimal(cgCur?.electronicBalance ?? '0', elecPart, 2);
        tx.insert(cashGeneralMovements)
          .values({
            id: uuidv7(),
            type: 'income',
            amount: total,
            description: 'Corrección: el pago a proveedor salió de la caja diaria',
            category: 'other',
            createdBy: data.userId,
            referenceId: pago.accountId,
            supplierPaymentId: pago.id,
            balanceAfter,
            isCash: Number(cashPart) >= Number(elecPart),
            balanceAfterCash,
            balanceAfterElectronic: balanceAfterElec,
            cashAmount: cashPart,
            electronicAmount: elecPart,
            createdAt: now,
          })
          .run();
        if (cgCur) {
          tx.update(cashGeneral)
            .set({
              currentBalance: balanceAfter,
              cashBalance: balanceAfterCash,
              electronicBalance: balanceAfterElec,
              lastUpdate: now,
            })
            .where(eq(cashGeneral.id, 'singleton'))
            .run();
        }
        for (const h of hermanos) {
          const pm = pmMap.get(h.paymentMethodId);
          tx.insert(cashMovements)
            .values({
              cashRegisterId: caja,
              type: 'expense',
              description: pm?.isPhysicalCash === false ? `Pago a proveedor — ${pm.name}` : 'Pago a proveedor',
              amount: h.amount,
              date: now,
              userId: data.userId,
              paymentMethodId: h.paymentMethodId,
              supplierPaymentId: h.id,
            })
            .run();
        }
        tx.update(supplierPayments).set({ fundingSource: 'daily' }).where(inArray(supplierPayments.id, ids)).run();
        return { movidos: hermanos.length, destino: 'daily' as const, cajaUsada: caja };
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
