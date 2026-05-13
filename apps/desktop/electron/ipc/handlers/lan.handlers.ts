/**
 * Handlers IPC del modo multi-caja LAN.
 *
 * - `lan:getConfig`  : devuelve la configuración persistida.
 * - `lan:setMode`    : cambia el modo (single/server/client); genera PIN si server.
 *                       Requiere admin. Devuelve `requiresRestart: true`.
 * - `lan:getLocalIp` : primera IPv4 no-loopback de la máquina.
 *
 * El switch de modo NO arranca/detiene el server en caliente — exige reinicio
 * para tomar la nueva config. Es la forma más segura.
 */
import { requirePermission } from '@stockflow/core';

import { LanManager } from '../../lan/LanManager';
import type { LanConfig, LanMode } from '../../lan/types';
import { DEFAULT_LAN_PORT } from '../../lan/types';
import { type HandlerDeps, type HandlerMap, unguarded, withSession } from '../handler-context';

export interface LanSetModeInput {
  mode: LanMode;
  /** Sólo modo client: */
  serverIp?: string;
  serverPort?: number;
  /** Sólo modo client: PIN del servidor. */
  token?: string;
  /** Sólo modo server: puerto (default 7777). */
  port?: number;
}

function getManager(deps: HandlerDeps): LanManager {
  return new LanManager(deps.userDataDir);
}

export function buildLanHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'lan:getConfig': unguarded(deps, async (): Promise<LanConfig> => {
      return getManager(deps).getConfig();
    }),
    'lan:getLocalIp': unguarded(deps, async (): Promise<{ ip: string | null }> => {
      return { ip: LanManager.getLocalIp() };
    }),
    'lan:setMode': withSession(
      deps,
      async (payload: LanSetModeInput, ctx): Promise<{ requiresRestart: true; config: LanConfig }> => {
        requirePermission(ctx.currentUser, 'manage_hardware');
        const mgr = getManager(deps);
        const current = mgr.getConfig();

        let next: LanConfig;
        if (payload.mode === 'server') {
          const token = current.mode === 'server' && current.token ? current.token : LanManager.generatePin();
          next = {
            mode: 'server',
            port: payload.port ?? current.port ?? DEFAULT_LAN_PORT,
            token,
          };
        } else if (payload.mode === 'client') {
          if (!payload.serverIp || !payload.token) {
            throw new Error('Para modo cliente se requieren serverIp y token (PIN)');
          }
          next = {
            mode: 'client',
            serverIp: payload.serverIp,
            serverPort: payload.serverPort ?? DEFAULT_LAN_PORT,
            token: payload.token,
          };
        } else {
          next = { mode: 'single' };
        }
        const saved = mgr.setConfig(next);
        return { requiresRestart: true, config: saved };
      },
    ),
  };
}
