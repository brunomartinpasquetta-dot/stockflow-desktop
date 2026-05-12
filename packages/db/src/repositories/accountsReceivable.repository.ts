import { and, eq, ne } from 'drizzle-orm';
import {
  CreateAccountReceivableSchema,
  UpdateAccountReceivableSchema,
  sumDecimals,
} from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  accountsReceivable,
  type AccountReceivable,
  type NewAccountReceivable,
} from '../schema/local';
import { BaseRepository } from './base.repository';

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
}
