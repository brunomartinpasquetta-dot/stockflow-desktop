/**
 * Handlers IPC para backups de la base de datos.
 */
import { requirePermission } from '@stockflow/core';

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
        return deps.backup.restoreBackup(payload.zipPath);
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
