/**
 * Barrel de servicios + factory `createServices(ctx)`.
 */
import type { ServiceContext } from '../context';
import { AccountsReceivableService } from './accountsReceivable.service';
import { AuthService } from './auth.service';
import { CashService } from './cash.service';
import { CashGeneralService } from './cashGeneral.service';
import { CompanyService } from './company.service';
import { InventoryService } from './inventory.service';
import { PaymentMethodService } from './paymentMethod.service';
import { PriceUpdateService } from './priceUpdate.service';
import { PurchasesService } from './purchases.service';
import { ReportsService } from './reports.service';
import { SalesService } from './sales.service';
import { SearchService } from './search.service';
import { SupplierAccountsService } from './supplierAccounts.service';
import { MpQrService, type MpTokenStoreLike } from './mpQr.service';
import { AccountingService } from './accounting.service';
import { AnalyticsService } from './analytics.service';

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
  PriceUpdateService,
  PRICE_FIELDS,
  applyRounding,
  computeNewValue,
  type ApplyUpdateInput,
  type ApplyUpdateResult,
  type BatchDetail,
  type PreviewEntry,
  type PreviewResult,
  type PriceField,
  type PriceUpdateFilter,
  type PriceUpdateRounding,
  type PriceUpdateRule,
  type PriceUpdateRuleType,
  type RollbackResult,
} from './priceUpdate.service';
export {
  ReportsService,
  type FamilyInventoryRow,
  type PurchasesReport,
  type SalesReport,
  type SellerReportRow,
  type TopArticleRow,
} from './reports.service';
export {
  SearchService,
  type GlobalSearchCategory,
  type GlobalSearchOptions,
  type GlobalSearchResult,
} from './search.service';
export {
  MpQrService,
  type MpTokenStoreLike,
  type MpConfigStatus,
  type MpSetupInput,
  type MpCreateOrderInput,
  type MpWebhookContext,
} from './mpQr.service';
export * from '../lib/mpApi';
export {
  AccountingService,
  type FinancialSummary,
  type VatBookSaleRow,
  type VatBookPurchaseRow,
} from './accounting.service';
export {
  CashGeneralService,
  type CashGeneralMovementDTO,
  type ListCashGeneralMovementsInput,
  type AddIncomeOrExpenseInput,
  type TransferFromDailyInput,
} from './cashGeneral.service';
export {
  AnalyticsService,
  type TopProductRow,
  type PaymentMethodRankRow,
  type CustomerRankRow,
  type SupplierRankRow,
  type SalesTrendRow,
  type AverageTicketResult,
  type SalesByHourRow,
  type SalesByDayOfWeekRow,
  type MarginRow,
  type StockRotationRow,
} from './analytics.service';

export interface Services {
  auth: AuthService;
  company: CompanyService;
  sales: SalesService;
  purchases: PurchasesService;
  cash: CashService;
  cashGeneral: CashGeneralService;
  analytics: AnalyticsService;
  inventory: InventoryService;
  accountsReceivable: AccountsReceivableService;
  supplierAccounts: SupplierAccountsService;
  paymentMethods: PaymentMethodService;
  priceUpdates: PriceUpdateService;
  reports: ReportsService;
  search: SearchService;
  mpQr: MpQrService;
  accounting: AccountingService;
}

export interface CreateServicesOptions {
  /** Token store para cifrar/descifrar credenciales MercadoPago. */
  mpTokenStore?: MpTokenStoreLike;
  /** Override del baseUrl de MercadoPago (sólo para tests). */
  mpBaseUrl?: string;
}

/** Construye todos los servicios de dominio sobre un contexto dado. */
export function createServices(ctx: ServiceContext, opts: CreateServicesOptions = {}): Services {
  const mpTokenStore: MpTokenStoreLike = opts.mpTokenStore ?? {
    encrypt: (s) => `plain:${s}`,
    decrypt: (s) => (s.startsWith('plain:') ? s.slice('plain:'.length) : s),
  };
  return {
    auth: new AuthService(ctx.repos),
    company: new CompanyService(ctx),
    sales: new SalesService(ctx),
    purchases: new PurchasesService(ctx),
    cash: new CashService(ctx),
    cashGeneral: new CashGeneralService(ctx),
    analytics: new AnalyticsService(ctx),
    inventory: new InventoryService(ctx),
    accountsReceivable: new AccountsReceivableService(ctx),
    supplierAccounts: new SupplierAccountsService(ctx),
    paymentMethods: new PaymentMethodService(ctx),
    priceUpdates: new PriceUpdateService(ctx),
    reports: new ReportsService(ctx),
    search: new SearchService(ctx),
    mpQr: new MpQrService(ctx, mpTokenStore, opts.mpBaseUrl),
    accounting: new AccountingService(ctx),
  };
}
