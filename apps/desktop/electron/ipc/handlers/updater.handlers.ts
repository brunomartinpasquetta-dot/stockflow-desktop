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
      // Antes de instalar hay que SOLTAR todo lo que tiene archivos abiertos
      // (servidor de red, base, puertos) y esperar a que cierre de verdad. Si
      // no, el instalador empieza a reemplazar archivos en uso y falla con
      // errores de escritura, dejando la instalación a medias.
      try {
        await deps.prepareForUpdate?.();
      } catch {
        /* si algo no cierra, se intenta instalar igual */
      }
      deps.updater?.quitAndInstall();
      return { ok: true };
    }),
    'updater:getPending': unguarded(
      deps,
      async (): Promise<{ version: string } | null> => deps.updater?.getPending?.() ?? null,
    ),
    'updater:getAutoCheck': unguarded(deps, async (): Promise<{ autoCheck: boolean }> => ({
      autoCheck: deps.updater?.getAutoCheck() ?? true,
    })),
    'updater:getChannel': unguarded(deps, async (): Promise<{ channel: 'stable' | 'beta' }> => ({
      channel: deps.updater?.getChannel?.() ?? 'stable',
    })),
    'updater:setChannel': unguarded(
      deps,
      async (payload: { channel: 'stable' | 'beta' }): Promise<{ ok: true }> => {
        deps.updater?.setChannel?.(payload.channel === 'beta' ? 'beta' : 'stable');
        return { ok: true };
      },
    ),
    'updater:setAutoCheck': unguarded(
      deps,
      async (payload: { autoCheck: boolean }): Promise<{ ok: true }> => {
        deps.updater?.setAutoCheck(!!payload.autoCheck);
        return { ok: true };
      },
    ),
  };
}
