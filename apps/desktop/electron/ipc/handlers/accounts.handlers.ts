import { AccountsReceivableService, requirePermission } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  AccountReceivableDTO,
  CustomerBalanceDTO,
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
      ): Promise<CustomerStatementDTO> => {
        requirePermission(ctx.currentUser, 'receive_payment');
        return new AccountsReceivableService(ctx).getCustomerStatement(payload.customerId, payload.dateRange);
      },
    ),
    'accounts:getTotalReceivables': withSession(
      deps,
      async (_payload, ctx): Promise<{ total: string }> => {
        requirePermission(ctx.currentUser, 'receive_payment');
        return { total: await new AccountsReceivableService(ctx).getTotalReceivables() };
      },
    ),
    'accounts:listBalances': withSession(
      deps,
      (_payload, ctx): Promise<CustomerBalanceDTO[]> => {
        requirePermission(ctx.currentUser, 'receive_payment');
        return new AccountsReceivableService(ctx).listCustomerBalances();
      },
    ),
    'accounts:listOpenByCustomer': withSession(
      deps,
      (payload: { customerId: string }, ctx): Promise<AccountReceivableDTO[]> => {
        requirePermission(ctx.currentUser, 'receive_payment');
        return ctx.repos.accountsReceivable.findOpenByCustomer(payload.customerId);
      },
    ),
  };
}
