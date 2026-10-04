import { CashService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import { cajaPorPcActiva, idDeCajaDelPedido } from '../caja-por-pc';
import { obtenerTerminalActual } from '../terminal-actual';
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
      async (
        payload: { openingAmount: string; terminalName?: string | null },
        ctx,
      ): Promise<CashRegisterDTO> => {
        // Con la caja por PC (opción del comercio o Multisucursal) cada PC
        // abre SU caja: la que hizo el pedido. Apagada, todas las PC abren con
        // el id del servidor y comparten la caja del local, como en la 1.12
        // (ver caja-por-pc.ts). Una terminal vieja que no se identifica cae en
        // el id del servidor en los dos casos.
        const porPc = cajaPorPcActiva(deps);
        const terminal = obtenerTerminalActual(deps);
        const register = await new CashService(ctx).openCashRegister(payload.openingAmount, {
          id: porPc ? terminal.id : deps.machineId,
          name: payload.terminalName ?? (porPc ? terminal.nombre : null),
        });
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
          // La retención corre también acá: sólo en el manual, un cierre por
          // día acumulaba ~10 GB al año en la carpeta del cliente.
          void deps.backup
            .createBackup()
            .then(() => deps.backup.cleanupOldBackups())
            .catch((err) => {
              console.error('[cash:close] backup automático falló:', err);
            });
        }
        return result;
      },
    ),
    'cash:getCurrent': withSession(deps, async (_payload, ctx): Promise<CashRegisterDTO | null> => {
      // La caja de la PC que pregunta (o la compartida heredada, si esa PC no
      // tiene una propia: ver migración 0042). Sin caja por PC: la del
      // servidor, que es la del local (como en la 1.12).
      const open = await ctx.repos.cashRegisters.getCurrentOpen(idDeCajaDelPedido(deps));
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
