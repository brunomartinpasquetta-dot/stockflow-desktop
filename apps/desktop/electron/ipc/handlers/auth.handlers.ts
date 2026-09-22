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
      const yaHay = deps.sessionStore.getSession()?.user;
      if (yaHay) return toUserDTO(yaHay);
      // INSTALACIÓN MAESTRA (la del dueño del sistema): entra sola con el
      // administrador, sin pasar por la pantalla de ingreso. Es la máquina de
      // desarrollo, donde la aplicación se abre y se cierra decenas de veces
      // por día. Ningún comercio tiene la licencia maestra, así que a ellos no
      // les cambia nada: siguen ingresando con su usuario y su contraseña.
      if (!deps.licenseManager.esInstalacionMaestra()) return null;
      const admin = await deps.repos.users.findOne({ role: 'admin', active: true });
      if (!admin) return null;
      const { passwordHash: _omit, ...safe } = admin as typeof admin & { passwordHash?: string };
      void _omit;
      const token = auth.issueSessionToken(safe);
      deps.sessionStore.setSession(safe, token);
      console.info(`[auth] instalación maestra: sesión automática como ${safe.username}`);
      return toUserDTO(safe);
    }),
  };
}
