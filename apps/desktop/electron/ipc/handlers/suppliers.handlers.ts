import { requirePermission } from '@stockflow/core';
import type { NewSupplier } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { SupplierDTO } from '../types';

export function buildSuppliersHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'suppliers:list': withSession(
      deps,
      (_payload, ctx): Promise<SupplierDTO[]> => ctx.repos.suppliers.findAll(),
    ),
    'suppliers:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<SupplierDTO | null> =>
        ctx.repos.suppliers.findById(payload.id),
    ),
    'suppliers:create': withSession(deps, (payload: NewSupplier, ctx): Promise<SupplierDTO> => {
      requirePermission(ctx.currentUser, 'manage_suppliers');
      return ctx.repos.suppliers.create(payload);
    }),
    'suppliers:update': withSession(
      deps,
      (payload: { id: string; data: Partial<NewSupplier> }, ctx): Promise<SupplierDTO> => {
        requirePermission(ctx.currentUser, 'manage_suppliers');
        return ctx.repos.suppliers.update(payload.id, payload.data);
      },
    ),
    'suppliers:delete': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ deleted: true }> => {
        requirePermission(ctx.currentUser, 'manage_suppliers');
        await ctx.repos.suppliers.delete(payload.id);
        return { deleted: true };
      },
    ),
  };
}
