import { CashService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  AddMovementInputDTO,
  CashMovementDTO,
  CashRegisterDTO,
  CashReportDTO,
  HistoricalCashRegisterDTO,
  HistoricalCashReportDTO,
} from '../types';

export function buildCashHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'cash:open': withSession(
      deps,
      async (payload: { openingAmount: string }, ctx): Promise<CashRegisterDTO> => {
        const register = await new CashService(ctx).openCashRegister(payload.openingAmount);
        deps.sessionStore.setCurrentCashRegister(register);
        return register;
      },
    ),
    'cash:close': withSession(
      deps,
      async (
        payload: { registerId: string; closingAmount: string; notes?: string | null },
        ctx,
      ): Promise<{ register: CashRegisterDTO; report: CashReportDTO }> => {
        const result = await new CashService(ctx).closeCashRegister(
          payload.registerId,
          payload.closingAmount,
          payload.notes ?? undefined,
        );
        if (deps.sessionStore.getCurrentCashRegister()?.id === payload.registerId) {
          deps.sessionStore.setCurrentCashRegister(null);
        }
        // Backup post-cierre si está habilitado (no esperar, fire-and-forget).
        if (deps.hardware.getConfig().backup.autoOnCashClose) {
          const dest = deps.hardware.getConfig().backup.destination;
          deps.backup.setBackupDir(dest);
          void deps.backup.createBackup().catch((err) => {
            console.error('[cash:close] backup automático falló:', err);
          });
        }
        return result;
      },
    ),
    'cash:getCurrent': withSession(deps, async (_payload, ctx): Promise<CashRegisterDTO | null> => {
      const open = await ctx.repos.cashRegisters.getCurrentOpen();
      deps.sessionStore.setCurrentCashRegister(open);
      return open;
    }),
    'cash:getReport': withSession(
      deps,
      (payload: { registerId: string }, ctx): Promise<CashReportDTO> =>
        new CashService(ctx).getCashReport(payload.registerId),
    ),
    'cash:addMovement': withSession(
      deps,
      (payload: AddMovementInputDTO, ctx): Promise<CashMovementDTO> =>
        new CashService(ctx).addMovement(payload),
    ),
    'cash:listHistorical': withSession(
      deps,
      (
        payload: { from: number; to: number; userId?: string },
        ctx,
      ): Promise<HistoricalCashRegisterDTO[]> =>
        new CashService(ctx).listHistoricalCashRegisters(payload),
    ),
    'cash:getHistoricalReport': withSession(
      deps,
      (payload: { cashRegisterId: string }, ctx): Promise<HistoricalCashReportDTO> =>
        new CashService(ctx).getHistoricalCashReport(payload.cashRegisterId),
    ),
  };
}
