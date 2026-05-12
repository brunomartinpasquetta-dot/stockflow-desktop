import { AuthService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import type { LoginResultDTO, UserDTO } from '../types';

export function buildAuthHandlers(deps: HandlerDeps): HandlerMap {
  const auth = new AuthService(deps.repos);
  return {
    'auth:login': unguarded(
      deps,
      async (payload: { username: string; password: string }): Promise<LoginResultDTO> => {
        const result = await auth.login(payload.username, payload.password);
        deps.sessionStore.setSession(result.user, result.sessionToken);
        return result;
      },
    ),
    'auth:logout': unguarded(deps, async (): Promise<{ loggedOut: true }> => {
      deps.sessionStore.clearSession();
      return { loggedOut: true };
    }),
    'auth:getCurrentUser': unguarded(deps, async (): Promise<UserDTO | null> => {
      return deps.sessionStore.getSession()?.user ?? null;
    }),
  };
}
