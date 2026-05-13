import { and, eq, ne, sql } from 'drizzle-orm';
import {
  CreateSupplierAccountPayableSchema,
  UpdateSupplierAccountPayableSchema,
  sumDecimals,
} from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  supplierAccountsPayable,
  type NewSupplierAccountPayable,
  type SupplierAccountPayable,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface SupplierBalanceRow {
  supplierId: string;
  totalDebt: string;
  openInvoicesCount: number;
}

export class SupplierAccountPayableRepository extends BaseRepository<
  SupplierAccountPayable,
  NewSupplierAccountPayable
> {
  protected override readonly updateSchema = UpdateSupplierAccountPayableSchema;

  constructor(db: LocalDatabase) {
    super(db, supplierAccountsPayable, 'Cuenta de proveedor');
  }

  /** Abre una cuenta a partir de una compra a crédito (balance = total, status = 'open'). */
  override async create(rawData: unknown): Promise<SupplierAccountPayable> {
    try {
      const data = this.parseOrThrow<{ supplierId: string; purchaseId: string; total: string }>(
        CreateSupplierAccountPayableSchema,
        rawData,
      );
      return this.insertRow({
        supplierId: data.supplierId,
        purchaseId: data.purchaseId,
        total: data.total,
        balance: data.total,
        status: 'open',
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findOpenBySupplier(supplierId: string): Promise<SupplierAccountPayable[]> {
    try {
      return this.db
        .select()
        .from(supplierAccountsPayable)
        .where(
          and(
            eq(supplierAccountsPayable.supplierId, supplierId),
            ne(supplierAccountsPayable.status, 'paid'),
          ),
        )
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async getTotalBalance(supplierId: string): Promise<string> {
    try {
      const rows = this.db
        .select({ balance: supplierAccountsPayable.balance })
        .from(supplierAccountsPayable)
        .where(eq(supplierAccountsPayable.supplierId, supplierId))
        .all();
      return sumDecimals(rows.map((r) => r.balance));
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Deuda agregada por proveedor (cuentas no saldadas), ordenada por deuda desc. */
  async listBalances(): Promise<SupplierBalanceRow[]> {
    try {
      const rows = this.db
        .select({
          supplierId: supplierAccountsPayable.supplierId,
          total: sql<number>`COALESCE(SUM(CAST(${supplierAccountsPayable.balance} AS REAL)), 0)`,
          cnt: sql<number>`COUNT(*)`,
        })
        .from(supplierAccountsPayable)
        .where(ne(supplierAccountsPayable.status, 'paid'))
        .groupBy(supplierAccountsPayable.supplierId)
        .all();
      return rows
        .map((r) => ({
          supplierId: r.supplierId,
          totalDebt: Number(r.total).toFixed(4),
          openInvoicesCount: Number(r.cnt),
        }))
        .sort((a, b) => Number(b.totalDebt) - Number(a.totalDebt));
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
