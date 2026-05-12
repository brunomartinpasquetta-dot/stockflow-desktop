/**
 * Servicio de la empresa (fila única en `companies`): lectura y actualización de
 * los datos fiscales + el "modo de precios" (gross/net).
 */
import type { Company, PriceMode } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';

export class CompanyService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Datos de la empresa (crea la fila por defecto si no existe). Lectura: sin permiso. */
  async get(): Promise<Company> {
    return this.ctx.repos.company.getOrCreate();
  }

  async upsert(data: Record<string, unknown>): Promise<Company> {
    requirePermission(this.ctx.currentUser, 'manage_company');
    return this.ctx.repos.company.upsert(data);
  }

  /** Modo de precios vigente: 'gross' (precios con IVA incluido) | 'net' (precios netos). */
  async getPriceMode(): Promise<PriceMode> {
    const c = await this.ctx.repos.company.getOrCreate();
    return c.priceMode === 'net' ? 'net' : 'gross';
  }

  async setPriceMode(mode: PriceMode): Promise<Company> {
    requirePermission(this.ctx.currentUser, 'manage_company');
    return this.ctx.repos.company.upsert({ priceMode: mode });
  }
}
