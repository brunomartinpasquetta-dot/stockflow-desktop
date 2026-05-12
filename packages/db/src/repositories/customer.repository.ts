import { eq, like, or, sql } from 'drizzle-orm';
import { CreateCustomerSchema, UpdateCustomerSchema, sumDecimals } from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  accountsReceivable,
  customers,
  type Customer,
  type NewCustomer,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export interface CustomerWithBalance extends Customer {
  balance: string;
}

export class CustomerRepository extends BaseRepository<Customer, NewCustomer> {
  protected override readonly createSchema = CreateCustomerSchema;
  protected override readonly updateSchema = UpdateCustomerSchema;

  constructor(db: LocalDatabase) {
    super(db, customers, 'Cliente');
  }

  async searchByText(query: string): Promise<Customer[]> {
    try {
      const term = `%${query.trim()}%`;
      return this.db
        .select()
        .from(customers)
        .where(
          or(
            like(customers.lastName, term),
            like(customers.firstName, term),
            like(customers.docNumber, term),
          ),
        )
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByDocNumber(docNumber: string): Promise<Customer | null> {
    try {
      const row = this.db
        .select()
        .from(customers)
        .where(eq(customers.docNumber, docNumber))
        .get();
      return row ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Devuelve el cliente con el saldo acumulado de sus cuentas corrientes abiertas. */
  async findWithBalance(id: string): Promise<CustomerWithBalance | null> {
    try {
      const customer = this.db.select().from(customers).where(eq(customers.id, id)).get();
      if (!customer) return null;
      const rows = this.db
        .select({ balance: accountsReceivable.balance })
        .from(accountsReceivable)
        .where(eq(accountsReceivable.customerId, id))
        .all();
      const balance = sumDecimals(rows.map((r) => r.balance));
      return { ...customer, balance };
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
