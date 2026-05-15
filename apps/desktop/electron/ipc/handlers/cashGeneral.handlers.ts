import { CashGeneralService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CashGeneralMovementDTO,
  ListCashGeneralMovementsInputDTO,
  AddCashGeneralMovementInputDTO,
  TransferFromDailyInputDTO,
} from '../types';

export function buildCashGeneralHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'cashGeneral:getBalance': withSession(deps, async (_payload, ctx): Promise<{ balance: string }> => {
      const balance = await new CashGeneralService(ctx).getBalance();
      return { balance };
    }),
    'cashGeneral:listMovements': withSession(
      deps,
      (payload: ListCashGeneralMovementsInputDTO, ctx): Promise<CashGeneralMovementDTO[]> =>
        new CashGeneralService(ctx).listMovements(payload),
    ),
    'cashGeneral:addIncome': withSession(
      deps,
      (payload: AddCashGeneralMovementInputDTO, ctx): Promise<CashGeneralMovementDTO> =>
        new CashGeneralService(ctx).addIncome(payload),
    ),
    'cashGeneral:addExpense': withSession(
      deps,
      (payload: AddCashGeneralMovementInputDTO, ctx): Promise<CashGeneralMovementDTO> =>
        new CashGeneralService(ctx).addExpense(payload),
    ),
    'cashGeneral:transferFromDaily': withSession(
      deps,
      (payload: TransferFromDailyInputDTO, ctx): Promise<CashGeneralMovementDTO> =>
        new CashGeneralService(ctx).transferFromDaily(payload),
    ),
  };
}
