/**
 * Errores de dominio de la capa de servicios.
 *
 * Se complementan con los errores de datos de `@stockflow/db` (re-exportados acá):
 *  - NotFoundError / ConstraintError / ValidationError / DatabaseError (capa de datos)
 *  - PermissionDeniedError / BusinessRuleError (capa de aplicación)
 *
 * Todos discriminables por `instanceof` o por la propiedad `code`.
 */

export abstract class CoreError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** El usuario actual no tiene permiso para ejecutar la acción pedida. */
export class PermissionDeniedError extends CoreError {
  readonly code = 'PERMISSION_DENIED' as const;

  constructor(
    readonly action: string,
    readonly role: string,
  ) {
    super(`El rol "${role}" no tiene permiso para la acción "${action}"`);
  }
}

/** Se violó una regla de negocio (ej. "no se puede anular una venta con pagos en cuenta"). */
export class BusinessRuleError extends CoreError {
  readonly code = 'BUSINESS_RULE' as const;

  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

// Re-export de los errores de la capa de datos.
export {
  DomainError,
  NotFoundError,
  ConstraintError,
  ValidationError,
  DatabaseError,
  rethrowDbError,
} from '@stockflow/db';
export type { DomainErrorCode } from '@stockflow/db';
