/**
 * Barrel de servicios + factory `createServices(ctx)`.
 */
import type { ServiceContext } from '../context';
import { AccountsReceivableService } from './accountsReceivable.service';
import { AuthService } from './auth.service';
import { CashService } from './cash.service';
import { InventoryService } from './inventory.service';
import { PurchasesService } from './purchases.service';
import { ReportsService } from './reports.service';
import { SalesService } from './sales.service';

export { AuthService, type LoginResult } from './auth.service';
export {
  SalesService,
  type CreateSaleInput,
  type CreateSaleResult,
  type SaleLineDraft,
} from './sales.service';
export {
  PurchasesService,
  type CreatePurchaseInput,
  type CreatePurchaseResult,
  type PurchaseLineDraft,
} from './purchases.service';
export { CashService, type AddMovementInput, type CashReport } from './cash.service';
export {
  InventoryService,
  type LowStockEntry,
  type StockAdjustment,
  type StockCheck,
} from './inventory.service';
export {
  AccountsReceivableService,
  type CustomerStatement,
  type ReceivePaymentInput,
  type ReceivePaymentResult,
  type StatementEntry,
} from './accountsReceivable.service';
export {
  ReportsService,
  type FamilyInventoryRow,
  type PurchasesReport,
  type SalesReport,
  type SellerReportRow,
  type TopArticleRow,
} from './reports.service';

export interface Services {
  auth: AuthService;
  sales: SalesService;
  purchases: PurchasesService;
  cash: CashService;
  inventory: InventoryService;
  accountsReceivable: AccountsReceivableService;
  reports: ReportsService;
}

/** Construye todos los servicios de dominio sobre un contexto dado. */
export function createServices(ctx: ServiceContext): Services {
  return {
    auth: new AuthService(ctx.repos),
    sales: new SalesService(ctx),
    purchases: new PurchasesService(ctx),
    cash: new CashService(ctx),
    inventory: new InventoryService(ctx),
    accountsReceivable: new AccountsReceivableService(ctx),
    reports: new ReportsService(ctx),
  };
}
