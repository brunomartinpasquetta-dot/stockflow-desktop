/**
 * Contexto de ejecución de los servicios (Dependency Injection explícita).
 *
 * Cada llamada a un servicio recibe (directa o indirectamente) un `ServiceContext`
 * con la conexión, los repositorios, el usuario actual y, opcionalmente, la caja
 * activa. No hay estado mutable global ni singletons.
 */
import {
  type LocalDatabase,
  type Repositories,
  type SafeUser,
  createRepositories,
} from '@stockflow/db';
import type { CashRegister } from '@stockflow/shared';

export interface ServiceContext {
  readonly db: LocalDatabase;
  readonly repos: Repositories;
  /** Usuario autenticado en cuyo nombre se ejecutan las operaciones. */
  readonly currentUser: SafeUser;
  /** Caja abierta asociada a la sesión (si la hay). */
  readonly currentCashRegister: CashRegister | null;
}

/** Construye un `ServiceContext` armando los repositorios sobre la conexión dada. */
export function createServiceContext(
  db: LocalDatabase,
  currentUser: SafeUser,
  currentCashRegister: CashRegister | null = null,
): ServiceContext {
  return {
    db,
    repos: createRepositories(db),
    currentUser,
    currentCashRegister,
  };
}

/** Devuelve una copia del contexto con otra caja activa. */
export function withCashRegister(
  ctx: ServiceContext,
  cashRegister: CashRegister | null,
): ServiceContext {
  return { ...ctx, currentCashRegister: cashRegister };
}
