/**
 * Factory de repositorios. Cada repositorio recibe la conexión Drizzle por
 * inyección; el resto del sistema consume `createRepositories(db)` y no instancia
 * repositorios a mano.
 */
import type { LocalDatabase } from '../local/client';
import { AccountsReceivableRepository } from './accountsReceivable.repository';
import { ArticleRepository } from './article.repository';
import { BaseRepository } from './base.repository';
import { CashGeneralRepository } from './cashGeneral.repository';
import { CashMovementRepository } from './cashMovement.repository';
import { CashRegisterRepository } from './cashRegister.repository';
import { CompanyRepository } from './company.repository';
import { CustomerRepository } from './customer.repository';
import { FamilyRepository } from './family.repository';
import { PaymentRepository } from './payment.repository';
import { PaymentMethodRepository } from './paymentMethod.repository';
import { PriceUpdateRepository } from './priceUpdate.repository';
import { PurchaseRepository } from './purchase.repository';
import { PurchaseLineRepository } from './purchaseLine.repository';
import { RolePermissionRepository } from './rolePermission.repository';
import { PromotionRepository } from './promotion.repository';
import { ReturnRepository } from './return.repository';
import { AuditRepository } from './audit.repository';
import { ArticleSupplierCodeRepository } from './articleSupplierCode.repository';
import { ScannedInvoiceRepository } from './scannedInvoice.repository';
import { CatalogoPedidoRepository, CatalogoRepository } from './catalogo.repository';
import { MaintenanceRepository } from './maintenance.repository';
import { FiscalRepository } from './fiscal.repository';
import { QuoteRepository } from './quote.repository';
import { SaleRepository } from './sale.repository';
import { SaleLineRepository } from './saleLine.repository';
import { SalePaymentRepository } from './salePayment.repository';
import { SupplierRepository } from './supplier.repository';
import { SupplierAccountPayableRepository } from './supplierAccountPayable.repository';
import { SupplierPaymentRepository } from './supplierPayment.repository';
import { UserRepository } from './user.repository';

export { BaseRepository };
export { AccountsReceivableRepository } from './accountsReceivable.repository';
export { ArticleRepository } from './article.repository';
export {
  CashGeneralRepository,
  type AddCashGeneralMovementInput,
  type CashGeneralCategory,
  type CashGeneralMovementType,
  type ListMovementsFilter as CashGeneralListMovementsFilter,
  type TransferFromDailyRepoInput,
} from './cashGeneral.repository';
export { CashMovementRepository } from './cashMovement.repository';
export { CashRegisterRepository } from './cashRegister.repository';
export { CompanyRepository } from './company.repository';
export { CustomerRepository, type CustomerWithBalance } from './customer.repository';
export { FamilyRepository } from './family.repository';
export { PaymentRepository } from './payment.repository';
export { PaymentMethodRepository } from './paymentMethod.repository';
export {
  PriceUpdateRepository,
  type PriceUpdateBatchWithUser,
  type PriceUpdateEntryWithBatch,
} from './priceUpdate.repository';
export { PurchaseRepository, type PurchaseWithLines } from './purchase.repository';
export { PurchaseLineRepository } from './purchaseLine.repository';
export {
  RolePermissionRepository,
  type ConfigurableRole,
} from './rolePermission.repository';
export { PromotionRepository, type PromotionDetail, type PromotionItemDetail, type PromotionWriteInput } from './promotion.repository';
export { AuditRepository, type InsertAuditInput, type ListAuditInput } from './audit.repository';
export {
  CatalogoRepository,
  CatalogoPedidoRepository,
  type ArticuloParaCatalogo,
  type LineaPedidoWeb,
  type PedidoWebEntrante,
} from './catalogo.repository';
export { ArticleSupplierCodeRepository } from './articleSupplierCode.repository';
export {
  ScannedInvoiceRepository,
  type ActualizarFacturaEscaneada,
  type FacturaEscaneada,
  type ListarFacturasEscaneadas,
} from './scannedInvoice.repository';
export { MaintenanceRepository, type ResetOperationalResult } from './maintenance.repository';
export {
  FiscalRepository,
  type SaveFiscalConfigInput,
  type CreateVoucherInput,
  type ListVouchersInput,
} from './fiscal.repository';
export { ReturnRepository, type CreateSaleReturnInput, type CreatePurchaseReturnInput, type SaleReturnResult, type PurchaseReturnResult, type ReturnLineDraft, type PurchaseReturnLineDraft } from './return.repository';
export { QuoteRepository, type QuoteWithLines } from './quote.repository';
export { SaleRepository, type SaleWithLines, type FiltroFacturasEmitidas, type ItemParaDevolucion } from './sale.repository';
export { SaleLineRepository } from './saleLine.repository';
export { SalePaymentRepository, type SalePaymentInput } from './salePayment.repository';
export { SupplierRepository } from './supplier.repository';
export {
  SupplierAccountPayableRepository,
  type SupplierBalanceRow,
} from './supplierAccountPayable.repository';
export { SupplierPaymentRepository } from './supplierPayment.repository';
export { UserRepository, type SafeUser } from './user.repository';

export interface Repositories {
  articles: ArticleRepository;
  customers: CustomerRepository;
  suppliers: SupplierRepository;
  users: UserRepository;
  families: FamilyRepository;
  sales: SaleRepository;
  saleLines: SaleLineRepository;
  salePayments: SalePaymentRepository;
  promotions: PromotionRepository;
  returns: ReturnRepository;
  audit: AuditRepository;
  catalogo: CatalogoRepository;
  catalogoPedidos: CatalogoPedidoRepository;
  /** Código de cada proveedor → artículo (facturas por teléfono). */
  articleSupplierCodes: ArticleSupplierCodeRepository;
  /** Facturas de compra fotografiadas desde el teléfono. */
  scannedInvoices: ScannedInvoiceRepository;
  maintenance: MaintenanceRepository;
  fiscal: FiscalRepository;
  quotes: QuoteRepository;
  purchases: PurchaseRepository;
  purchaseLines: PurchaseLineRepository;
  cashRegisters: CashRegisterRepository;
  cashMovements: CashMovementRepository;
  cashGeneral: CashGeneralRepository;
  accountsReceivable: AccountsReceivableRepository;
  payments: PaymentRepository;
  supplierAccountsPayable: SupplierAccountPayableRepository;
  supplierPayments: SupplierPaymentRepository;
  paymentMethods: PaymentMethodRepository;
  priceUpdates: PriceUpdateRepository;
  company: CompanyRepository;
  rolePermissions: RolePermissionRepository;
}

/** Crea el conjunto completo de repositorios sobre una conexión dada. */
export function createRepositories(db: LocalDatabase): Repositories {
  return {
    articles: new ArticleRepository(db),
    customers: new CustomerRepository(db),
    suppliers: new SupplierRepository(db),
    users: new UserRepository(db),
    families: new FamilyRepository(db),
    sales: new SaleRepository(db),
    saleLines: new SaleLineRepository(db),
    salePayments: new SalePaymentRepository(db),
    promotions: new PromotionRepository(db),
    returns: new ReturnRepository(db),
    audit: new AuditRepository(db),
    catalogo: new CatalogoRepository(db),
    catalogoPedidos: new CatalogoPedidoRepository(db),
    articleSupplierCodes: new ArticleSupplierCodeRepository(db),
    scannedInvoices: new ScannedInvoiceRepository(db),
    maintenance: new MaintenanceRepository(db),
    fiscal: new FiscalRepository(db),
    quotes: new QuoteRepository(db),
    purchases: new PurchaseRepository(db),
    purchaseLines: new PurchaseLineRepository(db),
    cashRegisters: new CashRegisterRepository(db),
    cashMovements: new CashMovementRepository(db),
    cashGeneral: new CashGeneralRepository(db),
    accountsReceivable: new AccountsReceivableRepository(db),
    payments: new PaymentRepository(db),
    supplierAccountsPayable: new SupplierAccountPayableRepository(db),
    supplierPayments: new SupplierPaymentRepository(db),
    paymentMethods: new PaymentMethodRepository(db),
    priceUpdates: new PriceUpdateRepository(db),
    company: new CompanyRepository(db),
    rolePermissions: new RolePermissionRepository(db),
  };
}
