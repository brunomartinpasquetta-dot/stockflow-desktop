import { eq, like, or, sql } from 'drizzle-orm';
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

  /**
   * Proveedor por CUIT comparando SÓLO los dígitos: el CUIT se carga a mano
   * ("30-12345678-9", "30 12345678 9", "30123456789") y el del QR fiscal de
   * una factura llega sin separadores. Sin dígitos no busca (null).
   */
  async findByCuit(cuit: string): Promise<Supplier | null> {
    try {
      const digitos = String(cuit ?? '').replace(/\D/g, '');
      if (!digitos) return null;
      const soloDigitos = sql`replace(replace(replace(replace(${suppliers.cuit}, '-', ''), ' ', ''), '.', ''), '/', '')`;
      const row = this.db
        .select()
        .from(suppliers)
        .where(sql`${soloDigitos} = ${digitos}`)
        .orderBy(suppliers.createdAt)
        .get();
      return row ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Búsqueda multi-campo (razón social, código o CUIT) para P-BUSQUEDA. */
  async findByText(query: string, limit = 8): Promise<Supplier[]> {
    try {
      const term = `%${query.trim()}%`;
      return this.db
        .select()
        .from(suppliers)
        .where(
          or(
            like(suppliers.name, term),
            like(suppliers.code, term),
            like(suppliers.cuit, term),
          ),
        )
        .limit(limit)
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
