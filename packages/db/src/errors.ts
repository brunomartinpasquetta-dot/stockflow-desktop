/**
 * Errores tipados del dominio de datos. Las capas superiores (servicios, IPC, API)
 * pueden discriminar por `instanceof` o por la propiedad `code`.
 */

export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'CONSTRAINT'
  | 'VALIDATION'
  | 'DATABASE';

/** Base abstracta de todos los errores de dominio. */
export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    // Mantiene el stack trace correcto en V8.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** La entidad pedida no existe. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND' as const;

  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} no encontrado (id: ${id})`);
  }
}

/** Violación de una restricción de integridad (UNIQUE, FK, CHECK, NOT NULL, ...). */
export class ConstraintError extends DomainError {
  readonly code = 'CONSTRAINT' as const;

  constructor(
    readonly constraint: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Los datos de entrada no pasaron la validación (Zod u otra regla de negocio). */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION' as const;

  constructor(
    readonly field: string,
    message: string,
    /** Lista completa de problemas (cuando vienen de Zod). */
    readonly issues: ReadonlyArray<{ path: string; message: string }> = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** Construye un ValidationError a partir de un error de Zod (`error.issues`). */
  static fromZod(error: {
    issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
  }): ValidationError {
    const issues = error.issues.map((i) => ({
      path: i.path.map(String).join('.') || '(root)',
      message: i.message,
    }));
    const first = issues[0];
    return new ValidationError(
      first?.path ?? '(root)',
      first ? `${first.path}: ${first.message}` : 'Datos inválidos',
      issues,
      { cause: error },
    );
  }
}

/** Error genérico/inesperado de la base de datos. */
export class DatabaseError extends DomainError {
  readonly code = 'DATABASE' as const;

  constructor(cause: unknown, message = 'Error de base de datos') {
    super(message, { cause });
  }
}

/**
 * Normaliza cualquier excepción atrapada en la capa de datos:
 *  - si ya es un `DomainError`, la re-lanza tal cual;
 *  - si es un error de constraint de SQLite (`SQLITE_CONSTRAINT*`), lo mapea a `ConstraintError`;
 *  - en cualquier otro caso, lo envuelve en `DatabaseError`.
 *
 * Siempre lanza (tipo de retorno `never`).
 */
export function rethrowDbError(err: unknown): never {
  if (err instanceof DomainError) throw err;

  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  ) {
    const code = (err as { code: string }).code;
    const message = err instanceof Error ? err.message : code;
    throw new ConstraintError(code, message, { cause: err });
  }

  throw new DatabaseError(err);
}
