import { requirePermission } from '@stockflow/core';
import type { NewSupplier } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { SupplierDTO } from '../types';

export function buildSuppliersHandlers(deps: HandlerDeps): HandlerMap {
  return {
    /**
     * Por defecto SIN los dados de baja: si siguieran apareciendo para elegir
     * en Compras, darlos de baja no serviría de nada. Con `incluirBaja` se ven
     * todos, para poder reactivarlos.
     */
    'suppliers:list': withSession(
      deps,
      async (payload: { incluirBaja?: boolean } | undefined, ctx): Promise<SupplierDTO[]> => {
        const todos = await ctx.repos.suppliers.findAll();
        return payload?.incluirBaja ? todos : todos.filter((p) => p.active !== false);
      },
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
      async (payload: { id: string }, ctx): Promise<{ deleted: boolean; dadoDeBaja: boolean }> => {
        requirePermission(ctx.currentUser, 'manage_suppliers');
        const r = await ctx.repos.suppliers.borrarODarDeBaja(payload.id);
        return { deleted: r === 'borrado', dadoDeBaja: r === 'dado_de_baja' };
      },
    ),
  };
}
