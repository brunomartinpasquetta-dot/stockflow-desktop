import os from 'node:os';

import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import type { SystemInfoDTO } from '../types';

export function buildSystemHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'system:pickFile': unguarded(
      deps,
      async (payload: { filters?: { name: string; extensions: string[] }[] } | undefined): Promise<{ filePath: string | null }> => {
        try {
          const { dialog } = await import('electron');
          const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: payload?.filters ?? [
              { name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] },
            ],
          });
          if (result.canceled || result.filePaths.length === 0) return { filePath: null };
          return { filePath: result.filePaths[0]! };
        } catch (err) {
          throw new Error('No se pudo abrir el selector de archivos', { cause: err });
        }
      },
    ),
    'system:pickImage': unguarded(
      deps,
      async (): Promise<{ filePath: string | null }> => {
        try {
          const { dialog } = await import('electron');
          const result = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [
              { name: 'Imágenes', extensions: ['jpg', 'jpeg', 'png', 'webp'] },
            ],
          });
          if (result.canceled || result.filePaths.length === 0) return { filePath: null };
          return { filePath: result.filePaths[0]! };
        } catch (err) {
          throw new Error('No se pudo abrir el selector de imágenes', { cause: err });
        }
      },
    ),
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
