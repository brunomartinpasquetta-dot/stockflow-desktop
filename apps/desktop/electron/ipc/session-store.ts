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
}
