/**
 * Contratos IPC compartidos entre el proceso main (handlers) y el renderer
 * (window.stockflow). Este archivo es DELIBERADAMENTE auto-contenido: no importa
 * nada de los workspace packages, para que pueda incluirse en el programa de
 * TypeScript del renderer (config estricta) sin arrastrar el grafo de
 * @stockflow/db / @stockflow/core (que usa sintaxis no "erasable").
 *
 * Los DTO replican la forma de las entidades de la base; los handlers devuelven
 * las entidades reales (estructuralmente compatibles) y el type-check del main
 * valida la correspondencia en el borde.
 */

/* ----------------------------------------------------------------------- */
/* Respuesta uniforme                                                       */
/* ----------------------------------------------------------------------- */

export type IpcErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONSTRAINT'
  | 'PERMISSION_DENIED'
  | 'BUSINESS_RULE'
  | 'UNAUTHENTICATED'
  | 'INTERNAL';

export interface IpcErr {
  ok: false;
  code: IpcErrorCode;
  message: string;
  /** ValidationError: campo que falló. */
  field?: string;
  /** ConstraintError: nombre de la restricción. */
  constraint?: string;
  /** PermissionDeniedError: acción denegada. */
  action?: string;
  /** BusinessRuleError: regla violada. */
  rule?: string;
  /** Sólo en desarrollo. */
  stack?: string;
}

export interface IpcOk<T> {
  ok: true;
  data: T;
}

export type IpcResponse<T> = IpcOk<T> | IpcErr;

/* ----------------------------------------------------------------------- */
/* DTOs de entidad (replican $inferSelect de @stockflow/db)                 */
/* ----------------------------------------------------------------------- */

export type Role = 'admin' | 'manager' | 'seller';
export type Unit = 'UN' | 'KG' | 'GR' | 'LT' | 'ML';
export type DocType = 'DNI' | 'CUIT' | 'CUIL' | 'PASS' | 'CF';
export type FiscalCategory = 'RI' | 'MT' | 'CF' | 'EX';
export type VoucherType = 'A' | 'B' | 'C' | 'X';
export type SaleStatus = 'completed' | 'voided' | 'pending';
export type PurchasePaymentType = 'cash' | 'credit';
export type CashStatus = 'open' | 'closed';
export type CashMovementType = 'income' | 'expense';
export type ArStatus = 'open' | 'paid' | 'partial';
/** Modo de precios de la empresa: 'gross' = precios con IVA incluido / 'net' = precios netos + IVA aparte. */
export type PriceMode = 'gross' | 'net';
export type PaymentMethodType =
  | 'cash'
  | 'transfer'
  | 'debit_card'
  | 'credit_card'
  | 'mp'
  | 'check'
  | 'other';

export interface UserDTO {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ArticleDTO {
  id: string;
  barcode: string;
  description: string;
  brand: string | null;
  familyId: string | null;
  supplierId: string | null;
  costPrice: string;
  listPrice1: string;
  listPrice2: string;
  listPrice3: string;
  wholesalePrice: string;
  wholesaleMinQty: string;
  vatRate: string;
  stock: string;
  minStock: string;
  idealStock: string;
  soldByWeight: boolean;
  unit: Unit;
  imagePath: string | null;
  notes: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CustomerDTO {
  id: string;
  lastName: string;
  firstName: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  mobile: string | null;
  docType: DocType | null;
  docNumber: string | null;
  category: FiscalCategory;
  priceList: number;
  creditLimit: string;
  email: string | null;
  facebook: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CustomerWithBalanceDTO extends CustomerDTO {
  balance: string;
}

export interface SupplierDTO {
  id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  cuit: string | null;
  ingBrutos: string | null;
  phone: string | null;
  mobile: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FamilyDTO {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface CardDTO {
  id: string;
  name: string;
  commissionPct: string;
  discountPct: string;
  active: boolean;
  createdAt: number;
}

export interface PaymentMethodDTO {
  id: string;
  name: string;
  type: PaymentMethodType;
  /** Sólo este afecta el arqueo físico del cajón. */
  isPhysicalCash: boolean;
  commissionPct: string;
  active: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompanyDTO {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  cuit: string | null;
  ingBrutos: string | null;
  /** 'gross' = los precios cargados ya incluyen IVA; 'net' = son netos. */
  priceMode: PriceMode;
  createdAt: number;
  updatedAt: number;
}

export interface CashRegisterDTO {
  id: string;
  number: number;
  openDate: number;
  closeDate: number | null;
  openingAmount: string;
  closingAmount: string | null;
  status: CashStatus;
  userId: string;
  notes: string | null;
  createdAt: number;
}

export interface CashMovementDTO {
  id: string;
  cashRegisterId: string;
  type: CashMovementType;
  description: string;
  amount: string;
  date: number;
  userId: string;
  relatedSaleId: string | null;
  relatedPurchaseId: string | null;
  /** Medio de pago del movimiento (null = movimiento antiguo / sin asignar). */
  paymentMethodId: string | null;
  createdAt: number;
  /** Estado de la venta relacionada (sólo presente cuando hay `relatedSaleId`). */
  relatedSaleStatus?: SaleStatus;
}

export interface SaleDTO {
  id: string;
  number: number;
  type: VoucherType;
  date: number;
  customerId: string;
  sellerId: string;
  cashRegisterId: string;
  /** true = venta a cuenta corriente (sin pagos hasta que se cobre). */
  isAccountSale: boolean;
  subtotal: string;
  discount: string;
  vatAmount: string;
  total: string;
  status: SaleStatus;
  afipCAE: string | null;
  afipExpiry: number | null;
  afipObservations: string | null;
  afipQrUrl: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SaleLineDTO {
  id: string;
  saleId: string;
  articleId: string;
  lineNumber: number;
  quantity: string;
  unitPrice: string;
  discount: string;
  vatRate: string;
  lineTotal: string;
  createdAt: number;
}

export interface SalePaymentDTO {
  id: string;
  saleId: string;
  paymentMethodId: string;
  amount: string;
  reference: string | null;
  createdAt: number;
}

export interface PurchaseDTO {
  id: string;
  number: number;
  type: VoucherType;
  supplierInvoiceNumber: string | null;
  date: number;
  supplierId: string;
  paymentType: PurchasePaymentType;
  subtotal: string;
  discount: string;
  vatAmount: string;
  total: string;
  status: SaleStatus;
  updatedPricesOnSave: boolean;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PurchaseLineDTO {
  id: string;
  purchaseId: string;
  articleId: string;
  lineNumber: number;
  quantity: string;
  costPrice: string;
  salePrice: string;
  vatRate: string;
  lineTotal: string;
  createdAt: number;
}

export interface AccountReceivableDTO {
  id: string;
  customerId: string;
  saleId: string;
  total: string;
  balance: string;
  status: ArStatus;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentDTO {
  id: string;
  accountId: string;
  amount: string;
  date: number;
  paymentMethodId: string;
  notes: string | null;
  createdAt: number;
}

export interface SupplierAccountPayableDTO {
  id: string;
  supplierId: string;
  purchaseId: string;
  total: string;
  balance: string;
  status: ArStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SupplierPaymentDTO {
  id: string;
  accountId: string;
  paymentMethodId: string;
  amount: string;
  date: number;
  reference: string | null;
  createdAt: number;
}

/** Una línea de pago (medio + monto), usada en ventas y cobranzas. */
export interface PaymentInputDTO {
  paymentMethodId: string;
  amount: string;
  reference?: string | null;
}

/* ----------------------------------------------------------------------- */
/* Resultados compuestos / reportes                                         */
/* ----------------------------------------------------------------------- */

export interface SessionPayloadDTO {
  sub: string;
  username: string;
  role: Role;
  iat: number;
  exp: number;
}

export interface LoginResultDTO {
  user: UserDTO;
  sessionToken: string;
}

export interface SaleLineDraftDTO {
  articleId: string;
  quantity: string;
  /** Si se omite, lo resuelve el servicio (lista del cliente / mayorista). */
  unitPrice?: string;
  discount?: string;
  vatRate?: string;
}

export interface CreateSaleInputDTO {
  type: VoucherType;
  customerId: string;
  /** true = venta a cuenta corriente (no lleva pagos). */
  isAccountSale?: boolean;
  /** Pagos de la venta; obligatorio (≥1) si NO es a cuenta corriente. */
  payments?: PaymentInputDTO[];
  discount?: string;
  notes?: string | null;
  lines: SaleLineDraftDTO[];
}

export interface CreateSaleResultDTO {
  sale: SaleDTO;
  lines: SaleLineDTO[];
  payments: SalePaymentDTO[];
  accountReceivable: AccountReceivableDTO | null;
}

export interface PurchaseLineDraftDTO {
  articleId: string;
  quantity: string;
  costPrice: string;
  /** Nuevo precio de venta sugerido; vacío/omitido = no cambia listPrice1. */
  salePrice?: string;
  vatRate?: string;
}

export interface CreatePurchaseInputDTO {
  type: VoucherType;
  supplierId: string;
  supplierInvoiceNumber?: string | null;
  date?: number;
  /** true = compra a cuenta del proveedor (no lleva pagos). */
  isAccountPurchase?: boolean;
  /** Pagos de la compra (contado); obligatorio (≥1) si NO es a cuenta. */
  payments?: PaymentInputDTO[];
  updatePrices?: boolean;
  discount?: string;
  notes?: string | null;
  cashRegisterId?: string | null;
  lines: PurchaseLineDraftDTO[];
}

export interface CreatePurchaseResultDTO {
  purchase: PurchaseDTO;
  lines: PurchaseLineDTO[];
  accountPayable: SupplierAccountPayableDTO | null;
}

export interface SupplierBalanceDTO {
  supplierId: string;
  supplierName: string;
  totalDebt: string;
  openInvoicesCount: number;
}

export interface PaySupplierInvoiceInputDTO {
  accountId: string;
  payments: PaymentInputDTO[];
  expectedAmount?: string;
  notes?: string | null;
  cashRegisterId?: string;
}

export interface PaySupplierInvoiceResultDTO {
  payments: SupplierPaymentDTO[];
  account: SupplierAccountPayableDTO;
}

export interface SupplierStatementEntryDTO {
  date: number;
  kind: 'purchase' | 'payment';
  reference: string;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface SupplierStatementDTO {
  supplier: SupplierDTO;
  entries: SupplierStatementEntryDTO[];
  currentBalance: string;
}

export interface PaymentMethodBreakdownDTO {
  paymentMethodId: string | null;
  name: string;
  type: PaymentMethodType | null;
  isPhysicalCash: boolean;
  incomeTotal: string;
  expenseTotal: string;
  net: string;
}

export interface CashReportDTO {
  register: CashRegisterDTO;
  openingAmount: string;
  incomeCount: number;
  incomeTotal: string;
  expenseCount: number;
  expenseTotal: string;
  salesCount: number;
  salesTotal: string;
  /** efectivo físico esperado en caja = apertura + ingresos en efectivo − egresos en efectivo */
  expectedCash: string;
  closingAmount: string | null;
  difference: string | null;
  byPaymentMethod: PaymentMethodBreakdownDTO[];
  movements: CashMovementDTO[];
}

export interface StockCheckDTO {
  articleId: string;
  available: boolean;
  current: string;
  requested: string;
}

export interface StockAdjustmentDTO {
  article: ArticleDTO;
  previousStock: string;
  newStock: string;
  delta: string;
  reason: string;
  by: string;
}

export interface LowStockEntryDTO {
  article: ArticleDTO;
  current: string;
  min: string;
  ideal: string;
  suggestedOrder: string;
}

export interface ReceivePaymentInputDTO {
  accountId: string;
  /** Una o más líneas de pago; la suma es lo cobrado. */
  payments: PaymentInputDTO[];
  /** Si se indica, la suma de los pagos debe coincidir exactamente con este monto. */
  expectedAmount?: string;
  notes?: string | null;
  cashRegisterId?: string;
}

export interface ReceivePaymentResultDTO {
  payments: PaymentDTO[];
  account: AccountReceivableDTO;
}

export interface StatementEntryDTO {
  date: number;
  kind: 'sale' | 'payment';
  reference: string;
  debit: string;
  credit: string;
  runningBalance: string;
}

export interface CustomerStatementDTO {
  customer: CustomerDTO;
  entries: StatementEntryDTO[];
  currentBalance: string;
}

export interface CustomerBalanceDTO {
  customerId: string;
  customerName: string;
  totalDebt: string;
  openInvoicesCount: number;
  lastPaymentDate: number | null;
}

export interface DateRangeDTO {
  from: number;
  to: number;
}

export interface SalesReportDTO {
  from: number;
  to: number;
  count: number;
  total: string;
  byStatus: Record<string, { count: number; total: string }>;
  byPaymentType: Record<string, { count: number; total: string }>;
  sales: SaleDTO[];
}

export interface PurchasesReportDTO {
  from: number;
  to: number;
  count: number;
  total: string;
  purchases: PurchaseDTO[];
}

export interface SellerReportRowDTO {
  sellerId: string;
  sellerName: string;
  count: number;
  total: string;
}

export interface FamilyInventoryRowDTO {
  familyId: string | null;
  familyName: string;
  articleCount: number;
  totalStock: string;
  costValue: string;
  saleValue: string;
}

export interface TopArticleRowDTO {
  articleId: string;
  description: string;
  quantity: string;
  amount: string;
}

export interface AddMovementInputDTO {
  type: CashMovementType;
  description: string;
  amount: string;
  /** Medio de pago del movimiento (default en la UI: Efectivo). */
  paymentMethodId?: string | null;
  cashRegisterId?: string;
}

export interface SystemInfoDTO {
  version: string;
  machineId: string;
  dbPath: string;
  platform: string;
}

/** Payload genérico para create/update de entidades simples (validado server-side por Zod). */
export type EntityPayload = Record<string, unknown>;
export interface IdPayload {
  id: string;
}
export interface UpdatePayload {
  id: string;
  data: EntityPayload;
}

/* ----------------------------------------------------------------------- */
/* Superficie de la API expuesta en window.stockflow                        */
/* ----------------------------------------------------------------------- */

type Res<T> = Promise<IpcResponse<T>>;

export interface ApiSurface {
  auth: {
    login(payload: { username: string; password: string }): Res<LoginResultDTO>;
    logout(): Res<{ loggedOut: true }>;
    getCurrentUser(): Res<UserDTO | null>;
  };
  articles: {
    list(): Res<ArticleDTO[]>;
    get(payload: IdPayload): Res<ArticleDTO | null>;
    create(payload: EntityPayload): Res<ArticleDTO>;
    update(payload: UpdatePayload): Res<ArticleDTO>;
    delete(payload: IdPayload): Res<{ deleted: true }>;
    findByBarcode(payload: { barcode: string }): Res<ArticleDTO | null>;
    searchByText(payload: { query: string }): Res<ArticleDTO[]>;
    findLowStock(): Res<ArticleDTO[]>;
  };
  customers: {
    list(): Res<CustomerDTO[]>;
    get(payload: IdPayload): Res<CustomerDTO | null>;
    create(payload: EntityPayload): Res<CustomerDTO>;
    update(payload: UpdatePayload): Res<CustomerDTO>;
    delete(payload: IdPayload): Res<{ deleted: true }>;
    searchByText(payload: { query: string }): Res<CustomerDTO[]>;
    findByDocNumber(payload: { docNumber: string }): Res<CustomerDTO | null>;
  };
  suppliers: {
    list(): Res<SupplierDTO[]>;
    get(payload: IdPayload): Res<SupplierDTO | null>;
    create(payload: EntityPayload): Res<SupplierDTO>;
    update(payload: UpdatePayload): Res<SupplierDTO>;
    delete(payload: IdPayload): Res<{ deleted: true }>;
  };
  families: {
    list(): Res<FamilyDTO[]>;
    get(payload: IdPayload): Res<FamilyDTO | null>;
    create(payload: EntityPayload): Res<FamilyDTO>;
    update(payload: UpdatePayload): Res<FamilyDTO>;
    delete(payload: IdPayload): Res<{ deleted: true }>;
  };
  paymentMethods: {
    list(): Res<PaymentMethodDTO[]>;
    get(payload: IdPayload): Res<PaymentMethodDTO | null>;
    create(payload: EntityPayload): Res<PaymentMethodDTO>;
    update(payload: UpdatePayload): Res<PaymentMethodDTO>;
    delete(payload: IdPayload): Res<{ deleted: true }>;
  };
  users: {
    list(): Res<UserDTO[]>;
    get(payload: IdPayload): Res<UserDTO | null>;
    create(payload: EntityPayload): Res<UserDTO>;
    update(payload: UpdatePayload): Res<UserDTO>;
    delete(payload: IdPayload): Res<{ deleted: true }>;
  };
  company: {
    get(): Res<CompanyDTO>;
    upsert(payload: EntityPayload): Res<CompanyDTO>;
  };
  sales: {
    create(payload: CreateSaleInputDTO): Res<CreateSaleResultDTO>;
    void(payload: IdPayload): Res<SaleDTO>;
    get(payload: IdPayload): Res<{ sale: SaleDTO; lines: SaleLineDTO[]; payments: SalePaymentDTO[] }>;
    listByDateRange(payload: DateRangeDTO): Res<SaleDTO[]>;
    getNextNumber(payload: { type: VoucherType }): Res<{ number: number }>;
  };
  purchases: {
    create(payload: CreatePurchaseInputDTO): Res<CreatePurchaseResultDTO>;
    void(payload: IdPayload): Res<PurchaseDTO>;
    get(payload: IdPayload): Res<{ purchase: PurchaseDTO; lines: PurchaseLineDTO[] }>;
    listByDateRange(payload: DateRangeDTO): Res<PurchaseDTO[]>;
    getNextNumber(payload: { type: VoucherType }): Res<{ number: number }>;
  };
  supplierAccounts: {
    listBalances(): Res<SupplierBalanceDTO[]>;
    payInvoice(payload: PaySupplierInvoiceInputDTO): Res<PaySupplierInvoiceResultDTO>;
    getStatement(payload: { supplierId: string; dateRange?: DateRangeDTO }): Res<SupplierStatementDTO>;
    listOpenBySupplier(payload: { supplierId: string }): Res<SupplierAccountPayableDTO[]>;
  };
  cash: {
    open(payload: { openingAmount: string }): Res<CashRegisterDTO>;
    close(payload: { registerId: string; closingAmount: string; notes?: string | null }): Res<{
      register: CashRegisterDTO;
      report: CashReportDTO;
    }>;
    getCurrent(): Res<CashRegisterDTO | null>;
    getReport(payload: { registerId: string }): Res<CashReportDTO>;
    addMovement(payload: AddMovementInputDTO): Res<CashMovementDTO>;
  };
  inventory: {
    checkStock(payload: { articleId: string; quantity: string }): Res<StockCheckDTO>;
    adjustStock(payload: { articleId: string; newStock: string; reason: string }): Res<StockAdjustmentDTO>;
    getLowStockReport(): Res<LowStockEntryDTO[]>;
  };
  accounts: {
    receivePayment(payload: ReceivePaymentInputDTO): Res<ReceivePaymentResultDTO>;
    getStatement(payload: { customerId: string; dateRange?: DateRangeDTO }): Res<CustomerStatementDTO>;
    getTotalReceivables(): Res<{ total: string }>;
    listBalances(): Res<CustomerBalanceDTO[]>;
    listOpenByCustomer(payload: { customerId: string }): Res<AccountReceivableDTO[]>;
  };
  reports: {
    salesByDateRange(payload: DateRangeDTO & { sellerId?: string; customerId?: string }): Res<SalesReportDTO>;
    purchasesByDateRange(payload: DateRangeDTO & { supplierId?: string }): Res<PurchasesReportDTO>;
    salesBySeller(payload: DateRangeDTO): Res<SellerReportRowDTO[]>;
    inventoryByFamily(): Res<FamilyInventoryRowDTO[]>;
    topArticles(payload: DateRangeDTO & { limit?: number }): Res<TopArticleRowDTO[]>;
    cashRegisterReport(payload: { registerId: string }): Res<CashReportDTO>;
  };
  system: {
    getMachineId(): Res<{ machineId: string }>;
    getVersion(): Res<{ version: string }>;
    getDbPath(): Res<{ dbPath: string }>;
    getInfo(): Res<SystemInfoDTO>;
  };
}
