import { CompanyService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { CompanyDTO } from '../types';

export function buildCompanyHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'company:get': withSession(
      deps,
      (_payload, ctx): Promise<CompanyDTO> => new CompanyService(ctx).get(),
    ),
    'company:upsert': withSession(
      deps,
      (payload: Record<string, unknown>, ctx): Promise<CompanyDTO> =>
        new CompanyService(ctx).upsert(payload),
    ),
  };
}
