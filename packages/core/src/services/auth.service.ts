/**
 * Servicio de autenticación y autorización.
 *  - login: valida credenciales y emite un token de sesión.
 *  - checkPermission / requirePermission: matriz de permisos por rol.
 */
import type { Repositories, SafeUser } from '@stockflow/db';

import { ValidationError } from '../errors';
import {
  type PermissionAction,
  hasPermission,
  requirePermission as requirePermissionFn,
} from '../auth/permissions';
import { type SessionPayload, signSession, verifySession } from '../auth/token';

export interface LoginResult {
  user: SafeUser;
  sessionToken: string;
}

export class AuthService {
  constructor(private readonly repos: Repositories) {}

  /** Valida usuario + contraseña; devuelve el usuario (sin hash) y un token de sesión. */
  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.repos.users.verifyPassword(username, password);
    if (!user) {
      throw new ValidationError('credentials', 'Usuario o contraseña incorrectos');
    }
    const sessionToken = signSession({ sub: user.id, username: user.username, role: user.role });
    return { user, sessionToken };
  }

  /** Verifica un token de sesión; devuelve el payload o `null`. */
  verifySession(token: string): SessionPayload | null {
    return verifySession(token);
  }

  /** ¿El usuario puede ejecutar la acción? */
  checkPermission(user: Pick<SafeUser, 'role'>, action: PermissionAction): boolean {
    return hasPermission(user.role, action);
  }

  /** Lanza `PermissionDeniedError` si el usuario no puede ejecutar la acción. */
  requirePermission(user: Pick<SafeUser, 'role'>, action: PermissionAction): void {
    requirePermissionFn(user, action);
  }
}
