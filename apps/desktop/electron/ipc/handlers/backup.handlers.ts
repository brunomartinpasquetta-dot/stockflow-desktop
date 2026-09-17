/**
 * Handlers IPC para backups de la base de datos.
 */
import { existsSync } from 'node:fs';

import { requirePermission, ValidationError } from '@stockflow/core';

import type { BackupConfig, BackupEntry } from '../../hardware/types';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';

export function buildBackupHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'backup:create': withSession(deps, async (_payload, ctx): Promise<BackupEntry> => {
      requirePermission(ctx.currentUser, 'manage_backup');
      const cfg = deps.hardware.getConfig().backup;
      deps.backup.setBackupDir(cfg.destination);
      const entry = await deps.backup.createBackup();
      void deps.backup.cleanupOldBackups();
      return entry;
    }),
    'backup:list': withSession(deps, async (_payload, ctx): Promise<BackupEntry[]> => {
      requirePermission(ctx.currentUser, 'manage_backup');
      const cfg = deps.hardware.getConfig().backup;
      deps.backup.setBackupDir(cfg.destination);
      return deps.backup.listBackups();
    }),
    'backup:restore': withSession(
      deps,
      async (payload: { zipPath: string }, ctx): Promise<{ requiresRestart: true }> => {
        requirePermission(ctx.currentUser, 'manage_backup');
        // Lo que se pueda comprobar, ANTES de cerrar nada: después de cerrar
        // la base la app ya no puede seguir trabajando.
        if (!payload?.zipPath || !existsSync(payload.zipPath)) {
          throw new ValidationError('zipPath', 'El archivo de backup no existe');
        }
        // La base se reemplaza con la app CERRADA por dentro: en Windows no se
        // puede pisar un archivo que otro proceso tiene abierto (la propia
        // base, abierta por better-sqlite3) y la restauración fallaba con
        // "resource busy". En Mac/Linux el rename pasaba, pero la app seguía
        // escribiendo en el archivo viejo hasta reiniciar y esas ventas se
        // perdían. Mismo gancho que usa el updater antes de instalar.
        await deps.prepareForUpdate?.();
        try {
          return await deps.backup.restoreBackup(payload.zipPath);
        } finally {
          // Se relanza SIEMPRE, salga bien o mal: con la base cerrada no hay
          // app que valga, y si la restauración falló el archivo original quedó
          // intacto (se reemplaza recién al final, de un solo movimiento).
          // Import dinámico: este módulo también corre bajo tsx (tests) sin Electron.
          const { app } = await import('electron');
          setTimeout(() => {
            app.relaunch();
            app.exit(0);
          }, 500);
        }
      },
    ),
    'backup:get-config': withSession(deps, async (): Promise<BackupConfig> => {
      return deps.hardware.getConfig().backup;
    }),
    'backup:set-config': withSession(
      deps,
      async (payload: BackupConfig, ctx): Promise<{ ok: true }> => {
        requirePermission(ctx.currentUser, 'manage_backup');
        deps.hardware.setBackupConfig(payload);
        return { ok: true };
      },
    ),
  };
}
