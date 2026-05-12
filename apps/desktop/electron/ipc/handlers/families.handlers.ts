import { requirePermission } from '@stockflow/core';
import type { NewFamily } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { FamilyDTO } from '../types';

export function buildFamiliesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'families:list': withSession(
      deps,
      (_payload, ctx): Promise<FamilyDTO[]> => ctx.repos.families.findAll(),
    ),
    'families:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<FamilyDTO | null> => ctx.repos.families.findById(payload.id),
    ),
    'families:create': withSession(deps, (payload: NewFamily, ctx): Promise<FamilyDTO> => {
      requirePermission(ctx.currentUser, 'manage_families');
      return ctx.repos.families.create(payload);
    }),
    'families:update': withSession(
      deps,
      (payload: { id: string; data: Partial<NewFamily> }, ctx): Promise<FamilyDTO> => {
        requirePermission(ctx.currentUser, 'manage_families');
        return ctx.repos.families.update(payload.id, payload.data);
      },
    ),
    'families:delete': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ deleted: true }> => {
        requirePermission(ctx.currentUser, 'manage_families');
        await ctx.repos.families.delete(payload.id);
        return { deleted: true };
      },
    ),
  };
}
