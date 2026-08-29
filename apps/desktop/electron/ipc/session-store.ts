/**
 * Estado de sesión en memoria del proceso main (no hay estado global mutable
 * fuera de este módulo: es el "store" explícito que se le pasa a los handlers).
 *
 *  - sesión actual: usuario autenticado + token emitido por AuthService
 *  - caja actualmente activa para esa sesión (si la hay)
 *
 * AISLAMIENTO POR INVOCACIÓN (LAN server):
 *  El `LanServer` comparte este MISMO singleton con la caja servidor local. Como
 *  los handlers son `async` (ceden el event loop en cada `await`), dos RPCs LAN
 *  concurrentes —o un RPC LAN intercalado con una acción del usuario local— NO
 *  pueden mutar `this.session` el uno al otro: eso sería elevación de privilegios
 *  / atribución incorrecta de ventas. Para evitarlo usamos `AsyncLocalStorage`:
 *  `runWith` corre `fn` dentro de un contexto ALS con su propia sesión+caja, y
 *  los getters leen primero del contexto ALS si existe. El IPC local single/server
 *  (que corre FUERA de cualquier contexto ALS) sigue usando el singleton intacto.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { CashRegister, SafeUser } from '@stockflow/db';

export interface Session {
  user: SafeUser;
  token: string;
}

/**
 * Estado efectivo de UNA invocación aislada (un RPC LAN). El `cashRegister` es
 * mutable (`cash:*` puede setearlo) pero vive sólo dentro del contexto ALS, así
 * que no se filtra a otra invocación ni al singleton.
 */
interface InvocationState {
  session: Session | null;
  cashRegister: CashRegister | null;
}

export class SessionStore {
  private session: Session | null = null;
  private cashRegister: CashRegister | null = null;
  /** Contexto por-invocación. Vacío en el path IPC local. */
  private readonly als = new AsyncLocalStorage<InvocationState>();

  setSession(user: SafeUser, token: string): void {
    // ALS-aware, IGUAL que los getters. Sin esto, un auth:login llegado por
    // LAN escribía el singleton y PISABA la sesión del usuario del escritorio:
    // el administrador del servidor pasaba a ser, para el main, el vendedor de
    // la terminal — "acceso denegado" en módulos al azar hasta reiniciar
    // (reporte de Leo Citzia, ago-2026).
    const scoped = this.als.getStore();
    if (scoped) {
      scoped.session = { user, token };
      return;
    }
    this.session = { user, token };
  }

  getSession(): Session | null {
    const scoped = this.als.getStore();
    if (scoped) return scoped.session;
    return this.session;
  }

  clearSession(): void {
    // Mismo criterio: un logout de una terminal no puede desloguear al
    // escritorio ni hacerle perder la caja abierta.
    const scoped = this.als.getStore();
    if (scoped) {
      scoped.session = null;
      scoped.cashRegister = null;
      return;
    }
    this.session = null;
    this.cashRegister = null;
  }

  setCurrentCashRegister(register: CashRegister | null): void {
    const scoped = this.als.getStore();
    if (scoped) {
      scoped.cashRegister = register;
      return;
    }
    this.cashRegister = register;
  }

  getCurrentCashRegister(): CashRegister | null {
    const scoped = this.als.getStore();
    if (scoped) return scoped.cashRegister;
    return this.cashRegister;
  }

  /**
   * Ejecuta `fn` con una sesión AISLADA por invocación (caso LAN: el server
   * impersona al usuario del JWT por la duración de un único RPC). La sesión y la
   * caja viven en un contexto `AsyncLocalStorage`, de modo que RPCs concurrentes
   * NO comparten `currentUser`: cada uno ve sólo el suyo a través de los getters.
   * No toca el singleton, así que la sesión local del proceso queda intacta.
   */
  runWith<T>(user: SafeUser, token: string, fn: () => Promise<T>): Promise<T> {
    const state: InvocationState = { session: { user, token }, cashRegister: null };
    return this.als.run(state, fn);
  }

  /**
   * Ejecuta `fn` en un contexto SIN sesión, aislado del singleton. Es para los
   * canales LAN que corren sin JWT (auth:login / auth:logout): lo que esos
   * handlers escriban en la sesión muere con la invocación y el escritorio ni
   * se entera.
   */
  runDetached<T>(fn: () => Promise<T>): Promise<T> {
    const state: InvocationState = { session: null, cashRegister: null };
    return this.als.run(state, fn);
  }
}
