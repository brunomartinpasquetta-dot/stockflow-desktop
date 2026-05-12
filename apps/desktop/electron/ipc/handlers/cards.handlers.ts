import { requirePermission } from '@stockflow/core';
import type { NewCard } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { CardDTO } from '../types';

export function buildCardsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'cards:list': withSession(deps, (_payload, ctx): Promise<CardDTO[]> => ctx.repos.cards.findAll()),
    'cards:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<CardDTO | null> => ctx.repos.cards.findById(payload.id),
    ),
    'cards:create': withSession(deps, (payload: NewCard, ctx): Promise<CardDTO> => {
      requirePermission(ctx.currentUser, 'manage_cards');
      return ctx.repos.cards.create(payload);
    }),
    'cards:update': withSession(
      deps,
      (payload: { id: string; data: Partial<NewCard> }, ctx): Promise<CardDTO> => {
        requirePermission(ctx.currentUser, 'manage_cards');
        return ctx.repos.cards.update(payload.id, payload.data);
      },
    ),
    'cards:delete': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ deleted: true }> => {
        requirePermission(ctx.currentUser, 'manage_cards');
        await ctx.repos.cards.delete(payload.id);
        return { deleted: true };
      },
    ),
  };
}
