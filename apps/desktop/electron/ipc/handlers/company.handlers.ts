import { requirePermission } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { CompanyDTO } from '../types';

export function buildCompanyHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'company:get': withSession(
      deps,
      (_payload, ctx): Promise<CompanyDTO> => ctx.repos.company.getOrCreate(),
    ),
    'company:upsert': withSession(
      deps,
      (payload: Record<string, unknown>, ctx): Promise<CompanyDTO> => {
        requirePermission(ctx.currentUser, 'manage_company');
        return ctx.repos.company.upsert(payload);
      },
    ),
  };
}
