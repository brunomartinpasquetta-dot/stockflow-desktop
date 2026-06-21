import { requirePermission, SupplierAccountsService } from '@stockflow/core';

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
      (_payload, ctx): Promise<SupplierBalanceDTO[]> => {
        requirePermission(ctx.currentUser, 'manage_supplier_accounts');
        return new SupplierAccountsService(ctx).listSupplierBalances();
      },
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
      ): Promise<SupplierStatementDTO> => {
        requirePermission(ctx.currentUser, 'manage_supplier_accounts');
        return new SupplierAccountsService(ctx).getSupplierStatement(payload.supplierId, payload.dateRange);
      },
    ),
    'supplierAccounts:listOpenBySupplier': withSession(
      deps,
      (payload: { supplierId: string }, ctx): Promise<SupplierAccountPayableDTO[]> => {
        requirePermission(ctx.currentUser, 'manage_supplier_accounts');
        return new SupplierAccountsService(ctx).listOpenBySupplier(payload.supplierId);
      },
    ),
  };
}
