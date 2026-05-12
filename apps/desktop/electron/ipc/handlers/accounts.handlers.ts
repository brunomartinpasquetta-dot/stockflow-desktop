import { AccountsReceivableService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  CustomerStatementDTO,
  ReceivePaymentInputDTO,
  ReceivePaymentResultDTO,
} from '../types';

export function buildAccountsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'accounts:receivePayment': withSession(
      deps,
      (payload: ReceivePaymentInputDTO, ctx): Promise<ReceivePaymentResultDTO> =>
        new AccountsReceivableService(ctx).receivePayment(payload),
    ),
    'accounts:getStatement': withSession(
      deps,
      (
        payload: { customerId: string; dateRange?: { from: number; to: number } },
        ctx,
      ): Promise<CustomerStatementDTO> =>
        new AccountsReceivableService(ctx).getCustomerStatement(payload.customerId, payload.dateRange),
    ),
    'accounts:getTotalReceivables': withSession(
      deps,
      async (_payload, ctx): Promise<{ total: string }> => ({
        total: await new AccountsReceivableService(ctx).getTotalReceivables(),
      }),
    ),
  };
}
