/**
 * Servicio de la empresa (fila única en `companies`): lectura y actualización de
 * los datos fiscales + el "modo de precios" (gross/net).
 */
import type { Company, PriceMode } from '@stockflow/shared';

import { hasPermission, requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';

export class CompanyService {
  constructor(private readonly ctx: ServiceContext) {}

  /**
   * Datos de la empresa (crea la fila por defecto si no existe). Lectura: sin
   * permiso, porque todos los módulos la necesitan (razón social, CUIT, modo
   * de precios). La clave del catálogo web es la excepción: con ella se pisan
   * precios y stock de la tienda, así que sólo la ve quien puede cambiarla
   * (Mi Empresa, con `manage_company`); al resto le llega en null.
   */
  async get(): Promise<Company> {
    const company = await this.ctx.repos.company.getOrCreate();
    if (hasPermission(this.ctx.currentUser.role, 'manage_company')) return company;
    return { ...company, catalogoToken: null };
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
