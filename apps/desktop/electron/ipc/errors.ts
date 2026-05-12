/**
 * Conversión de errores de dominio a la respuesta IPC uniforme.
 * Nunca se hace `throw` hacia el renderer: todo handler devuelve `IpcResponse`.
 */
import {
  BusinessRuleError,
  ConstraintError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@stockflow/core';

import type { IpcErr } from './types';

const isDev = process.env.NODE_ENV === 'development';

export function serializeError(err: unknown): IpcErr {
  if (err instanceof NotFoundError) {
    return { ok: false, code: 'NOT_FOUND', message: err.message };
  }
  if (err instanceof ValidationError) {
    return { ok: false, code: 'VALIDATION', message: err.message, field: err.field };
  }
  if (err instanceof ConstraintError) {
    return { ok: false, code: 'CONSTRAINT', message: err.message, constraint: err.constraint };
  }
  if (err instanceof PermissionDeniedError) {
    return { ok: false, code: 'PERMISSION_DENIED', message: err.message, action: err.action };
  }
  if (err instanceof BusinessRuleError) {
    return { ok: false, code: 'BUSINESS_RULE', message: err.message, rule: err.rule };
  }
  // DatabaseError o cualquier otra cosa inesperada → INTERNAL (se loguea completo).
  // En el proceso main, `console.error` está redirigido a electron-log (ver main.ts).
  console.error('[ipc] INTERNAL error:', err);
  const result: IpcErr = {
    ok: false,
    code: 'INTERNAL',
    message: isDev && err instanceof Error ? err.message : 'Error interno',
  };
  if (isDev && err instanceof Error && err.stack) {
    result.stack = err.stack;
  }
  return result;
}

export function unauthenticated(): IpcErr {
  return { ok: false, code: 'UNAUTHENTICATED', message: 'No hay una sesión activa' };
}
