/**
 * Punto de entrada de @stockflow/db.
 *
 * Local (PDV, better-sqlite3):
 *  - schema/local  : tablas Drizzle, relaciones, tipos inferidos (Article, Sale, ...) y
 *                    el objeto agregado `localSchema`.
 *  - local/client  : createLocalDb / closeLocalDb / applyLocalPragmas.
 *  - seed          : seedLocalDb (datos iniciales obligatorios, idempotente).
 *  - init          : initLocalDb (crea + migra + seedea + devuelve la instancia).
 *  - errors        : errores de dominio tipados (NotFoundError, ConstraintError, ...).
 *  - repositories  : capa de acceso a datos (patrón Repository) + createRepositories(db).
 *
 * Flujo de datos: input crudo → schema Zod (@stockflow/shared) → Repository → DB.
 *
 * Cloud (Postgres): schema/cloud todavía es placeholder; se completa más adelante.
 */
export * from './schema/local';
export * from './local/client';
export * from './seed';
export * from './init';
export * from './errors';
export * from './repositories';

// Schema cloud (placeholder por ahora).
export * as cloudSchema from './schema/cloud';
