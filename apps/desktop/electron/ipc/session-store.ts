/**
 * Estado de sesión en memoria del proceso main (no hay estado global mutable
 * fuera de este módulo: es el "store" explícito que se le pasa a los handlers).
 *
 *  - sesión actual: usuario autenticado + token emitido por AuthService
 *  - caja actualmente activa para esa sesión (si la hay)
 */
import type { CashRegister, SafeUser } from '@stockflow/db';

export interface Session {
  user: SafeUser;
  token: string;
}

export class SessionStore {
  private session: Session | null = null;
  private cashRegister: CashRegister | null = null;

  setSession(user: SafeUser, token: string): void {
    this.session = { user, token };
  }

  getSession(): Session | null {
    return this.session;
  }

  clearSession(): void {
    this.session = null;
    this.cashRegister = null;
  }

  setCurrentCashRegister(register: CashRegister | null): void {
    this.cashRegister = register;
  }

  getCurrentCashRegister(): CashRegister | null {
    return this.cashRegister;
  }

  /**
   * Ejecuta `fn` con una sesión temporal (caso LAN: el server impersonar al
   * usuario del JWT por la duración de un único RPC). SQLite + handlers son
   * single-threaded en JS, así que es seguro siempre que `fn` no sea spawn
   * paralelo de otros handlers. Restaura la sesión previa al terminar.
   */
  async runWith<T>(user: SafeUser, token: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.session;
    const prevCash = this.cashRegister;
    this.session = { user, token };
    try {
      return await fn();
    } finally {
      this.session = prev;
      this.cashRegister = prevCash;
    }
  }
}
