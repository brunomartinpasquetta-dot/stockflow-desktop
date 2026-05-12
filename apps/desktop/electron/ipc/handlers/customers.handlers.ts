import { requirePermission } from '@stockflow/core';
import type { NewCustomer } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { CustomerDTO } from '../types';

export function buildCustomersHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'customers:list': withSession(
      deps,
      (_payload, ctx): Promise<CustomerDTO[]> => ctx.repos.customers.findAll(),
    ),
    'customers:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<CustomerDTO | null> =>
        ctx.repos.customers.findById(payload.id),
    ),
    'customers:create': withSession(deps, (payload: NewCustomer, ctx): Promise<CustomerDTO> => {
      requirePermission(ctx.currentUser, 'create_sale');
      return ctx.repos.customers.create(payload);
    }),
    'customers:update': withSession(
      deps,
      (payload: { id: string; data: Partial<NewCustomer> }, ctx): Promise<CustomerDTO> => {
        requirePermission(ctx.currentUser, 'create_sale');
        return ctx.repos.customers.update(payload.id, payload.data);
      },
    ),
    'customers:delete': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ deleted: true }> => {
        requirePermission(ctx.currentUser, 'manage_articles');
        await ctx.repos.customers.delete(payload.id);
        return { deleted: true };
      },
    ),
    'customers:searchByText': withSession(
      deps,
      (payload: { query: string }, ctx): Promise<CustomerDTO[]> =>
        ctx.repos.customers.searchByText(payload.query),
    ),
    'customers:findByDocNumber': withSession(
      deps,
      (payload: { docNumber: string }, ctx): Promise<CustomerDTO | null> =>
        ctx.repos.customers.findByDocNumber(payload.docNumber),
    ),
  };
}
