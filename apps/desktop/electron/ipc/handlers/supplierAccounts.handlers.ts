import { SupplierAccountsService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  PaySupplierInvoiceInputDTO,
  PaySupplierInvoiceResultDTO,
  SupplierAccountPayableDTO,
  SupplierBalanceDTO,
  SupplierStatementDTO,
} from '../types';

export function buildSupplierAccountsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'supplierAccounts:listBalances': withSession(
      deps,
      (_payload, ctx): Promise<SupplierBalanceDTO[]> => new SupplierAccountsService(ctx).listSupplierBalances(),
    ),
    'supplierAccounts:payInvoice': withSession(
      deps,
      (payload: PaySupplierInvoiceInputDTO, ctx): Promise<PaySupplierInvoiceResultDTO> =>
        new SupplierAccountsService(ctx).payInvoice(payload),
    ),
    'supplierAccounts:getStatement': withSession(
      deps,
      (
        payload: { supplierId: string; dateRange?: { from: number; to: number } },
        ctx,
      ): Promise<SupplierStatementDTO> =>
        new SupplierAccountsService(ctx).getSupplierStatement(payload.supplierId, payload.dateRange),
    ),
    'supplierAccounts:listOpenBySupplier': withSession(
      deps,
      (payload: { supplierId: string }, ctx): Promise<SupplierAccountPayableDTO[]> =>
        new SupplierAccountsService(ctx).listOpenBySupplier(payload.supplierId),
    ),
  };
}
