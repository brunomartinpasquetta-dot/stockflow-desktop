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
  /**
   * PC (terminal) desde la que llegó el pedido: su machineId, o el id propio
   * de un navegador. Con esto cada puesto de una instalación en red usa SU
   * caja. Ausente o null = comportamiento previo (la última caja abierta), que
   * es lo que usan los tests y los procesos sin terminal.
   */
  readonly terminalId?: string | null;
}

/**
 * La caja abierta con la que opera ESTE pedido.
 *
 * Primero la caja de la sesión (la tiene sólo la sesión local que la abrió o
 * consultó); si no, la abierta de la terminal que hizo el pedido, y si esa PC
 * no tiene una propia, la compartida heredada (ver `getCurrentOpen`). Antes
 * todas las operaciones caían en `getCurrentOpen()` sin terminal, que devuelve
 * la última abierta de CUALQUIER PC: con varias PC en red, la venta de un
 * puesto podía cobrarse en el cajón de otro.
 */
export async function cajaAbiertaDeTerminal(ctx: ServiceContext): Promise<CashRegister | null> {
  const c = ctx.currentCashRegister;
  if (c && c.status === 'open') return c;
  return ctx.repos.cashRegisters.getCurrentOpen(ctx.terminalId ?? null);
}

/** Construye un `ServiceContext` armando los repositorios sobre la conexión dada. */
export function createServiceContext(
  db: LocalDatabase,
  currentUser: SafeUser,
  currentCashRegister: CashRegister | null = null,
  terminalId: string | null = null,
): ServiceContext {
  return {
    db,
    repos: createRepositories(db),
    currentUser,
    currentCashRegister,
    terminalId,
  };
}
