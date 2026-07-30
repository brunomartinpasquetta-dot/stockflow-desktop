/**
 * Handlers IPC de MANTENIMIENTO — puesta a cero de datos operativos.
 *
 * Operación destructiva e irreversible: SIEMPRE crea un backup automático
 * antes de tocar la base, y solo la puede ejecutar un administrador que
 * escriba la palabra de confirmación exacta.
 */
import type { ResetOperationalResult } from '@stockflow/db';

import type { BackupEntry } from '../../hardware/types';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';

const CONFIRM_WORD = 'REINICIAR';

export interface ResetOperationalPayload {
  confirm: string;
}

export interface ResetOperationalResponse extends ResetOperationalResult {
  backup: BackupEntry | null;
}

export function buildMaintenanceHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'maintenance:resetOperationalData': withSession(
      deps,
      async (payload: ResetOperationalPayload, ctx): Promise<ResetOperationalResponse> => {
        if (ctx.currentUser?.role !== 'admin') {
          throw new Error('Solo un administrador puede reiniciar los datos operativos');
        }
        if ((payload?.confirm ?? '').trim().toUpperCase() !== CONFIRM_WORD) {
          throw new Error(`Para confirmar tenés que escribir "${CONFIRM_WORD}"`);
        }

        // 1) Backup automático (nunca reiniciar sin red de seguridad).
        let backup: BackupEntry | null = null;
        try {
          const cfg = deps.hardware.getConfig().backup;
          deps.backup.setBackupDir(cfg.destination);
          backup = await deps.backup.createBackup();
        } catch (err) {
          throw new Error(
            'No se pudo crear el backup de seguridad; se cancela el reinicio. ' +
              (err instanceof Error ? err.message : String(err)),
          );
        }

        // 2) Puesta a cero transaccional.
        const result = deps.repos.maintenance.resetOperationalData();

        // 3) Auditar la operación (el usuario ya está en sesión).
        try {
          deps.repos.audit.insert({
            userId: ctx.currentUser.id,
            username: ctx.currentUser.fullName ?? ctx.currentUser.username ?? '—',
            channel: 'maintenance:resetOperationalData',
            area: 'Mantenimiento',
            description:
              `REINICIO de datos operativos — ${result.salesDeleted} ventas y ` +
              `${result.purchasesDeleted} compras borradas, ${result.salesKept} ventas y ` +
              `${result.purchasesKept} compras conservadas (cuentas corrientes), ` +
              `stock de ${result.articlesStockReset} artículos a 0. Backup: ${backup?.filename ?? '—'}`,
          });
        } catch {
          // la auditoría no debe hacer fallar el reinicio ya aplicado
        }

        return { ...result, backup };
      },
    ),
  };
}
