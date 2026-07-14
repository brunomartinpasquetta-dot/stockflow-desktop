/**
 * Servicio de PROMOCIONES (combos).
 *
 * La promo se vende como un artículo "espejo" real (marca PROMO): este service
 * valida el input del ABM, exige el permiso `manage_promotions` en las
 * mutaciones y delega la atomicidad (espejo + promo + items + costo real) en
 * `PromotionRepository`. El movimiento de stock por componentes al vender /
 * anular vive en `SaleRepository` (no acá).
 */
import { CreatePromotionSchema, UpdatePromotionSchema } from '@stockflow/shared';
import type { PromotionDetail } from '@stockflow/db';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError } from '../errors';

export class PromotionsService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Listado con costo real calculado en vivo (para el ABM y el picker del PDV). */
  async list(): Promise<PromotionDetail[]> {
    return this.ctx.repos.promotions.listWithDetails();
  }

  async get(id: string): Promise<PromotionDetail | null> {
    return this.ctx.repos.promotions.getDetail(id);
  }

  async create(rawInput: unknown): Promise<PromotionDetail> {
    requirePermission(this.ctx.currentUser, 'manage_promotions');
    const parsed = CreatePromotionSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new BusinessRuleError('invalid_promotion', parsed.error.issues[0]?.message ?? 'Datos de la promoción inválidos');
    }
    return this.ctx.repos.promotions.createWithItems(parsed.data);
  }

  async update(id: string, rawInput: unknown): Promise<PromotionDetail> {
    requirePermission(this.ctx.currentUser, 'manage_promotions');
    const parsed = UpdatePromotionSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new BusinessRuleError('invalid_promotion', parsed.error.issues[0]?.message ?? 'Datos de la promoción inválidos');
    }
    return this.ctx.repos.promotions.updateWithItems(id, parsed.data);
  }

  /** Activa/desactiva (desactivar = deja de aparecer y venderse; historial intacto). */
  async setActive(id: string, active: boolean): Promise<PromotionDetail> {
    requirePermission(this.ctx.currentUser, 'manage_promotions');
    return this.ctx.repos.promotions.updateWithItems(id, { active });
  }

  async delete(id: string): Promise<{ deleted: true }> {
    requirePermission(this.ctx.currentUser, 'manage_promotions');
    return this.ctx.repos.promotions.deleteWithMirror(id);
  }
}
