import { CreateCompanySchema, UpdateCompanySchema } from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { companies, type Company, type NewCompany } from '../schema/local';
import { BaseRepository } from './base.repository';

export class CompanyRepository extends BaseRepository<Company, NewCompany> {
  protected override readonly createSchema = CreateCompanySchema;
  protected override readonly updateSchema = UpdateCompanySchema;

  constructor(db: LocalDatabase) {
    super(db, companies, 'Empresa');
  }

  /** Devuelve la única fila de `companies`, creándola con valores por defecto si no existe. */
  async getOrCreate(): Promise<Company> {
    try {
      const existing = this.db.select().from(companies).limit(1).get();
      if (existing) return existing;
      return this.insertRow({ name: 'Mi Empresa' });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Actualiza los datos de la empresa (crea la fila si no existía). */
  async upsert(data: unknown): Promise<Company> {
    try {
      const current = await this.getOrCreate();
      return this.update(current.id, data as Partial<NewCompany>);
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
