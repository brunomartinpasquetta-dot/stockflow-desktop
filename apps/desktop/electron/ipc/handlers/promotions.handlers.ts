/**
 * Handlers IPC de PROMOCIONES (combos).
 *
 * ABM de promos con artículo espejo (ver PromotionsService/PromotionRepository).
 * `list`/`get` no exigen permiso (el PDV necesita el picker); las mutaciones
 * exigen `manage_promotions` (lo valida el service).
 */
import { PromotionsService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { PromotionDTO } from '../types';

export function buildPromotionsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'promotions:list': withSession(
      deps,
      (_payload, ctx): Promise<PromotionDTO[]> => new PromotionsService(ctx).list(),
    ),
    'promotions:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<PromotionDTO | null> =>
        new PromotionsService(ctx).get(payload.id),
    ),
    'promotions:create': withSession(
      deps,
      (payload: unknown, ctx): Promise<PromotionDTO> => new PromotionsService(ctx).create(payload),
    ),
    'promotions:update': withSession(
      deps,
      (payload: { id: string; data: unknown }, ctx): Promise<PromotionDTO> =>
        new PromotionsService(ctx).update(payload.id, payload.data),
    ),
    'promotions:setActive': withSession(
      deps,
      (payload: { id: string; active: boolean }, ctx): Promise<PromotionDTO> =>
        new PromotionsService(ctx).setActive(payload.id, payload.active),
    ),
    'promotions:delete': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<{ deleted: true }> =>
        new PromotionsService(ctx).delete(payload.id),
    ),
  };
}
