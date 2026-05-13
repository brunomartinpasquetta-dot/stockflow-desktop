/**
 * Handlers IPC del auto-updater. El controller real se inyecta desde main.ts;
 * en modo dev o sin updater disponible, devuelve `disabled`.
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';

export function buildUpdaterHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'updater:checkNow': unguarded(deps, async (): Promise<{ status: string; version?: string }> => {
      if (!deps.updater) return { status: 'disabled' };
      return deps.updater.checkNow();
    }),
    'updater:quitAndInstall': unguarded(deps, async (): Promise<{ ok: true }> => {
      deps.updater?.quitAndInstall();
      return { ok: true };
    }),
    'updater:getAutoCheck': unguarded(deps, async (): Promise<{ autoCheck: boolean }> => ({
      autoCheck: deps.updater?.getAutoCheck() ?? true,
    })),
    'updater:setAutoCheck': unguarded(
      deps,
      async (payload: { autoCheck: boolean }): Promise<{ ok: true }> => {
        deps.updater?.setAutoCheck(!!payload.autoCheck);
        return { ok: true };
      },
    ),
  };
}
