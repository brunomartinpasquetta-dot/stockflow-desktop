/**
 * Factory de repositorios. Cada repositorio recibe la conexión Drizzle por
 * inyección; el resto del sistema consume `createRepositories(db)` y no instancia
 * repositorios a mano.
 */
import type { LocalDatabase } from '../local/client';
import { AccountsReceivableRepository } from './accountsReceivable.repository';
import { ArticleRepository } from './article.repository';
import { BaseRepository } from './base.repository';
import { CardRepository } from './card.repository';
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
export { CardRepository } from './card.repository';
export {
  CashGeneralRepository,
  type AddCashGeneralMovementInput,
  type CashGeneralCategory,
  type CashGeneralMovementType,
  type ListMovementsFilter as CashGeneralListMovementsFilter,
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
export { SaleRepository, type SaleWithLines } from './sale.repository';
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
  /** Tabla `cards` heredada: queda en DB sin uso activo desde P07.2. */
  cards: CardRepository;
  company: CompanyRepository;
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
    cards: new CardRepository(db),
    company: new CompanyRepository(db),
  };
}
