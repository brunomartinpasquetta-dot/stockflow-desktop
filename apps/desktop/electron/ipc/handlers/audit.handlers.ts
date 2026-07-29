/**
 * Handlers IPC de AUDITORÍA (solo lectura; el registro lo hace withAudit).
 * Acceso restringido a administradores.
 */
import type { ServiceContext } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { AuditEntryDTO, ListAuditPayloadDTO } from '../types';

function requireAdmin(ctx: ServiceContext): void {
  if (ctx.currentUser?.role !== 'admin') {
    throw new Error('La auditoría es solo para administradores');
  }
}

export function buildAuditHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'audit:list': withSession(deps, (payload: ListAuditPayloadDTO, ctx): Promise<AuditEntryDTO[]> => {
      requireAdmin(ctx);
      return Promise.resolve(ctx.repos.audit.list(payload ?? {}));
    }),
    'audit:listAreas': withSession(deps, (_payload: void, ctx): Promise<string[]> => {
      requireAdmin(ctx);
      return Promise.resolve(ctx.repos.audit.listAreas());
    }),
  };
}
