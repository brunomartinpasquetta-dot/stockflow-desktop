/**
 * Barrel de servicios + factory `createServices(ctx)`.
 */
import type { ServiceContext } from '../context';
import { AccountsReceivableService } from './accountsReceivable.service';
import { AuthService } from './auth.service';
import { CashService } from './cash.service';
import { CompanyService } from './company.service';
import { InventoryService } from './inventory.service';
import { PaymentMethodService } from './paymentMethod.service';
import { PurchasesService } from './purchases.service';
import { ReportsService } from './reports.service';
import { SalesService } from './sales.service';
import { SupplierAccountsService } from './supplierAccounts.service';

export { AuthService, type LoginResult } from './auth.service';
export { CompanyService } from './company.service';
export {
  SalesService,
  type CreateSaleInput,
  type CreateSaleResult,
  type SaleLineDraft,
  type SalePaymentDraft,
} from './sales.service';
export {
  PurchasesService,
  type CreatePurchaseInput,
  type CreatePurchaseResult,
  type PurchaseLineDraft,
  type PurchasePaymentDraft,
} from './purchases.service';
export {
  CashService,
  type AddMovementInput,
  type CashReport,
  type CashMovementWithStatus,
  type PaymentMethodBreakdown,
} from './cash.service';
export { PaymentMethodService } from './paymentMethod.service';
export {
  InventoryService,
  type LowStockEntry,
  type StockAdjustment,
  type StockCheck,
} from './inventory.service';
export {
  AccountsReceivableService,
  type CustomerStatement,
  type PaymentDraft,
  type ReceivePaymentInput,
  type ReceivePaymentResult,
  type StatementEntry,
} from './accountsReceivable.service';
export {
  SupplierAccountsService,
  type PaySupplierInvoiceInput,
  type PaySupplierInvoiceResult,
  type SupplierBalance,
  type SupplierPaymentDraft,
  type SupplierStatement,
  type SupplierStatementEntry,
} from './supplierAccounts.service';
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
  company: CompanyService;
  sales: SalesService;
  purchases: PurchasesService;
  cash: CashService;
  inventory: InventoryService;
  accountsReceivable: AccountsReceivableService;
  supplierAccounts: SupplierAccountsService;
  paymentMethods: PaymentMethodService;
  reports: ReportsService;
}

/** Construye todos los servicios de dominio sobre un contexto dado. */
export function createServices(ctx: ServiceContext): Services {
  return {
    auth: new AuthService(ctx.repos),
    company: new CompanyService(ctx),
    sales: new SalesService(ctx),
    purchases: new PurchasesService(ctx),
    cash: new CashService(ctx),
    inventory: new InventoryService(ctx),
    accountsReceivable: new AccountsReceivableService(ctx),
    supplierAccounts: new SupplierAccountsService(ctx),
    paymentMethods: new PaymentMethodService(ctx),
    reports: new ReportsService(ctx),
  };
}
