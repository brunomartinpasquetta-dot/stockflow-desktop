import { eq } from 'drizzle-orm';
import { CreateSupplierSchema, UpdateSupplierSchema } from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { suppliers, type NewSupplier, type Supplier } from '../schema/local';
import { BaseRepository } from './base.repository';

export class SupplierRepository extends BaseRepository<Supplier, NewSupplier> {
  protected override readonly createSchema = CreateSupplierSchema;
  protected override readonly updateSchema = UpdateSupplierSchema;

  constructor(db: LocalDatabase) {
    super(db, suppliers, 'Proveedor');
  }

  async findByCode(code: string): Promise<Supplier | null> {
    try {
      const row = this.db.select().from(suppliers).where(eq(suppliers.code, code)).get();
      return row ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
