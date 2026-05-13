/**
 * Handlers IPC del cliente de licencias. Usan `unguarded` porque están
 * disponibles antes de que haya un usuario logueado en la app (la licencia es
 * previa al login).
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import type { LicenseStateDTO } from '../types';

export function buildLicenseHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'license:getState': unguarded(deps, async (): Promise<LicenseStateDTO> =>
      deps.licenseManager.getState(),
    ),
    'license:activate': unguarded(
      deps,
      async (payload: { licenseKey: string }): Promise<LicenseStateDTO> =>
        deps.licenseManager.activate(payload.licenseKey),
    ),
    'license:heartbeat': unguarded(deps, async (): Promise<LicenseStateDTO> => {
      await deps.licenseManager.heartbeat();
      return deps.licenseManager.getState();
    }),
  };
}
