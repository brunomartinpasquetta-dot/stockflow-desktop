import { AuthService, effectivePermissionsFor } from '@stockflow/core';
import type { SafeUser } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import type { LoginResultDTO, UserDTO } from '../types';

/** Proyecta un usuario de sesión a su DTO público con permisos EFECTIVOS. */
function toUserDTO(u: SafeUser): UserDTO {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    role: u.role,
    active: u.active,
    permissions: effectivePermissionsFor(u.role),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function buildAuthHandlers(deps: HandlerDeps): HandlerMap {
  const auth = new AuthService(deps.repos);
  return {
    'auth:login': unguarded(
      deps,
      async (payload: { username: string; password: string }): Promise<LoginResultDTO> => {
        const result = await auth.login(payload.username, payload.password);
        deps.sessionStore.setSession(result.user, result.sessionToken);
        return { user: toUserDTO(result.user), sessionToken: result.sessionToken };
      },
    ),
    'auth:logout': unguarded(deps, async (): Promise<{ loggedOut: true }> => {
      deps.sessionStore.clearSession();
      return { loggedOut: true };
    }),
    'auth:getCurrentUser': unguarded(deps, async (): Promise<UserDTO | null> => {
      const user = deps.sessionStore.getSession()?.user;
      return user ? toUserDTO(user) : null;
    }),
  };
}
