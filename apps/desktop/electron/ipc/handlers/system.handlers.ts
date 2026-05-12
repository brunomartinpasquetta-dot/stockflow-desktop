import os from 'node:os';

import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import type { SystemInfoDTO } from '../types';

export function buildSystemHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'system:getMachineId': unguarded(deps, async (): Promise<{ machineId: string }> => ({
      machineId: deps.machineId,
    })),
    'system:getVersion': unguarded(deps, async (): Promise<{ version: string }> => ({
      version: deps.appVersion,
    })),
    'system:getDbPath': unguarded(deps, async (): Promise<{ dbPath: string }> => ({
      dbPath: deps.dbPath,
    })),
    'system:getInfo': unguarded(deps, async (): Promise<SystemInfoDTO> => ({
      version: deps.appVersion,
      machineId: deps.machineId,
      dbPath: deps.dbPath,
      platform: os.platform(),
    })),
  };
}
