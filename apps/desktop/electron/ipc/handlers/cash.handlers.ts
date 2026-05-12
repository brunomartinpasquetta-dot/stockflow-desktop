import { CashService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { AddMovementInputDTO, CashMovementDTO, CashRegisterDTO, CashReportDTO } from '../types';

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
  };
}
