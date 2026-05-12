import { and, eq, ne, sql } from 'drizzle-orm';
import {
  CreateAccountReceivableSchema,
  UpdateAccountReceivableSchema,
  sumDecimals,
} from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  accountsReceivable,
  payments,
  type AccountReceivable,
  type NewAccountReceivable,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface CustomerBalanceRow {
  customerId: string;
  totalDebt: string;
  openInvoicesCount: number;
}

export class AccountsReceivableRepository extends BaseRepository<
  AccountReceivable,
  NewAccountReceivable
> {
  protected override readonly updateSchema = UpdateAccountReceivableSchema;

  constructor(db: LocalDatabase) {
    super(db, accountsReceivable, 'Cuenta corriente');
  }

  /** Abre una cuenta corriente a partir de una venta (balance = total, status = 'open'). */
  override async create(rawData: unknown): Promise<AccountReceivable> {
    try {
      const data = this.parseOrThrow<{ customerId: string; saleId: string; total: string }>(
        CreateAccountReceivableSchema,
        rawData,
      );
      return this.insertRow({
        customerId: data.customerId,
        saleId: data.saleId,
        total: data.total,
        balance: data.total,
        status: 'open',
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Cuentas con saldo pendiente de un cliente (status != 'paid'). */
  async findOpenByCustomer(customerId: string): Promise<AccountReceivable[]> {
    try {
      return this.db
        .select()
        .from(accountsReceivable)
        .where(
          and(
            eq(accountsReceivable.customerId, customerId),
            ne(accountsReceivable.status, 'paid'),
          ),
        )
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Saldo total adeudado por un cliente (suma de balances de todas sus cuentas). */
  async getTotalBalance(customerId: string): Promise<string> {
    try {
      const rows = this.db
        .select({ balance: accountsReceivable.balance })
        .from(accountsReceivable)
        .where(eq(accountsReceivable.customerId, customerId))
        .all();
      return sumDecimals(rows.map((r) => r.balance));
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Deuda agregada por cliente (suma de balances de cuentas no saldadas + cantidad
   * de comprobantes con saldo), ordenada por deuda descendente.
   */
  async listBalances(): Promise<CustomerBalanceRow[]> {
    try {
      const rows = this.db
        .select({
          customerId: accountsReceivable.customerId,
          total: sql<number>`COALESCE(SUM(CAST(${accountsReceivable.balance} AS REAL)), 0)`,
          cnt: sql<number>`COUNT(*)`,
        })
        .from(accountsReceivable)
        .where(ne(accountsReceivable.status, 'paid'))
        .groupBy(accountsReceivable.customerId)
        .all();
      return rows
        .map((r) => ({
          customerId: r.customerId,
          totalDebt: Number(r.total).toFixed(4),
          openInvoicesCount: Number(r.cnt),
        }))
        .sort((a, b) => Number(b.totalDebt) - Number(a.totalDebt));
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Fecha del último pago por cliente (unix ms), o ausente si nunca pagó. */
  async lastPaymentByCustomer(): Promise<Map<string, number>> {
    try {
      const rows = this.db
        .select({
          customerId: accountsReceivable.customerId,
          last: sql<number | null>`MAX(${payments.date})`,
        })
        .from(payments)
        .innerJoin(accountsReceivable, eq(payments.accountId, accountsReceivable.id))
        .groupBy(accountsReceivable.customerId)
        .all();
      const map = new Map<string, number>();
      for (const r of rows) if (r.last != null) map.set(r.customerId, Number(r.last));
      return map;
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
