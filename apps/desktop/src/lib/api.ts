/**
 * Cliente IPC tipado: envuelve `window.stockflow.*`, desempaqueta la respuesta
 * uniforme `{ ok, data } | { ok:false, code, ... }` y, en error, lanza `ApiError`.
 */
import type {
  ArticleDTO,
  CashRegisterDTO,
  CashReportDTO,
  CompanyDTO,
  CreatePurchaseInputDTO,
  CreatePurchaseResultDTO,
  CreateSaleInputDTO,
  CreateSaleResultDTO,
  CustomerDTO,
  CustomerStatementDTO,
  EntityPayload,
  FamilyDTO,
  IpcErrorCode,
  IpcResponse,
  LoginResultDTO,
  LowStockEntryDTO,
  PurchaseDTO,
  PurchaseLineDTO,
  ReceivePaymentInputDTO,
  ReceivePaymentResultDTO,
  SaleDTO,
  SaleLineDTO,
  StockAdjustmentDTO,
  StockCheckDTO,
  SupplierDTO,
  SystemInfoDTO,
  UserDTO,
  VoucherType,
} from '@/types/api'

export class ApiError extends Error {
  code: IpcErrorCode
  field?: string
  constraint?: string
  action?: string
  rule?: string

  constructor(code: IpcErrorCode, message: string, extra?: Partial<Pick<ApiError, 'field' | 'constraint' | 'action' | 'rule'>>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    if (extra?.field) this.field = extra.field
    if (extra?.constraint) this.constraint = extra.constraint
    if (extra?.action) this.action = extra.action
    if (extra?.rule) this.rule = extra.rule
  }
}

async function unwrap<T>(p: Promise<IpcResponse<T>>): Promise<T> {
  let res: IpcResponse<T>
  try {
    res = await p
  } catch (err) {
    // El bridge no debería tirar, pero por las dudas.
    throw new ApiError('INTERNAL', err instanceof Error ? err.message : 'Error de comunicación con el proceso principal')
  }
  if (res.ok) return res.data
  throw new ApiError(res.code, res.message, {
    field: res.field,
    constraint: res.constraint,
    action: res.action,
    rule: res.rule,
  })
}

const sf = () => window.stockflow

export const api = {
  auth: {
    login: (username: string, password: string): Promise<LoginResultDTO> => unwrap(sf().auth.login({ username, password })),
    logout: (): Promise<{ loggedOut: true }> => unwrap(sf().auth.logout()),
    getCurrentUser: (): Promise<UserDTO | null> => unwrap(sf().auth.getCurrentUser()),
  },
  articles: {
    list: (): Promise<ArticleDTO[]> => unwrap(sf().articles.list()),
    get: (id: string): Promise<ArticleDTO | null> => unwrap(sf().articles.get({ id })),
    create: (data: EntityPayload): Promise<ArticleDTO> => unwrap(sf().articles.create(data)),
    update: (id: string, data: EntityPayload): Promise<ArticleDTO> => unwrap(sf().articles.update({ id, data })),
    delete: (id: string): Promise<{ deleted: true }> => unwrap(sf().articles.delete({ id })),
    findByBarcode: (barcode: string): Promise<ArticleDTO | null> => unwrap(sf().articles.findByBarcode({ barcode })),
    searchByText: (query: string): Promise<ArticleDTO[]> => unwrap(sf().articles.searchByText({ query })),
    findLowStock: (): Promise<ArticleDTO[]> => unwrap(sf().articles.findLowStock()),
  },
  customers: {
    list: (): Promise<CustomerDTO[]> => unwrap(sf().customers.list()),
    get: (id: string): Promise<CustomerDTO | null> => unwrap(sf().customers.get({ id })),
    create: (data: EntityPayload): Promise<CustomerDTO> => unwrap(sf().customers.create(data)),
    update: (id: string, data: EntityPayload): Promise<CustomerDTO> => unwrap(sf().customers.update({ id, data })),
    delete: (id: string): Promise<{ deleted: true }> => unwrap(sf().customers.delete({ id })),
    searchByText: (query: string): Promise<CustomerDTO[]> => unwrap(sf().customers.searchByText({ query })),
    findByDocNumber: (docNumber: string): Promise<CustomerDTO | null> => unwrap(sf().customers.findByDocNumber({ docNumber })),
  },
  suppliers: {
    list: (): Promise<SupplierDTO[]> => unwrap(sf().suppliers.list()),
    get: (id: string): Promise<SupplierDTO | null> => unwrap(sf().suppliers.get({ id })),
    create: (data: EntityPayload): Promise<SupplierDTO> => unwrap(sf().suppliers.create(data)),
    update: (id: string, data: EntityPayload): Promise<SupplierDTO> => unwrap(sf().suppliers.update({ id, data })),
    delete: (id: string): Promise<{ deleted: true }> => unwrap(sf().suppliers.delete({ id })),
  },
  families: {
    list: (): Promise<FamilyDTO[]> => unwrap(sf().families.list()),
    get: (id: string): Promise<FamilyDTO | null> => unwrap(sf().families.get({ id })),
    create: (data: EntityPayload): Promise<FamilyDTO> => unwrap(sf().families.create(data)),
    update: (id: string, data: EntityPayload): Promise<FamilyDTO> => unwrap(sf().families.update({ id, data })),
    delete: (id: string): Promise<{ deleted: true }> => unwrap(sf().families.delete({ id })),
  },
  users: {
    list: (): Promise<UserDTO[]> => unwrap(sf().users.list()),
    get: (id: string): Promise<UserDTO | null> => unwrap(sf().users.get({ id })),
    create: (data: EntityPayload): Promise<UserDTO> => unwrap(sf().users.create(data)),
    update: (id: string, data: EntityPayload): Promise<UserDTO> => unwrap(sf().users.update({ id, data })),
    delete: (id: string): Promise<{ deleted: true }> => unwrap(sf().users.delete({ id })),
  },
  company: {
    get: (): Promise<CompanyDTO> => unwrap(sf().company.get()),
    upsert: (data: EntityPayload): Promise<CompanyDTO> => unwrap(sf().company.upsert(data)),
  },
  sales: {
    create: (input: CreateSaleInputDTO): Promise<CreateSaleResultDTO> => unwrap(sf().sales.create(input)),
    void: (id: string): Promise<SaleDTO> => unwrap(sf().sales.void({ id })),
    get: (id: string): Promise<{ sale: SaleDTO; lines: SaleLineDTO[] }> => unwrap(sf().sales.get({ id })),
    listByDateRange: (from: number, to: number): Promise<SaleDTO[]> => unwrap(sf().sales.listByDateRange({ from, to })),
    getNextNumber: (type: VoucherType): Promise<{ number: number }> => unwrap(sf().sales.getNextNumber({ type })),
  },
  purchases: {
    create: (input: CreatePurchaseInputDTO): Promise<CreatePurchaseResultDTO> => unwrap(sf().purchases.create(input)),
    get: (id: string): Promise<{ purchase: PurchaseDTO; lines: PurchaseLineDTO[] }> => unwrap(sf().purchases.get({ id })),
    listByDateRange: (from: number, to: number): Promise<PurchaseDTO[]> => unwrap(sf().purchases.listByDateRange({ from, to })),
  },
  cash: {
    open: (openingAmount: string): Promise<CashRegisterDTO> => unwrap(sf().cash.open({ openingAmount })),
    close: (registerId: string, closingAmount: string): Promise<{ register: CashRegisterDTO; report: CashReportDTO }> =>
      unwrap(sf().cash.close({ registerId, closingAmount })),
    getCurrent: (): Promise<CashRegisterDTO | null> => unwrap(sf().cash.getCurrent()),
    getReport: (registerId: string): Promise<CashReportDTO> => unwrap(sf().cash.getReport({ registerId })),
  },
  inventory: {
    checkStock: (articleId: string, quantity: string): Promise<StockCheckDTO> => unwrap(sf().inventory.checkStock({ articleId, quantity })),
    adjustStock: (articleId: string, newStock: string, reason: string): Promise<StockAdjustmentDTO> =>
      unwrap(sf().inventory.adjustStock({ articleId, newStock, reason })),
    getLowStockReport: (): Promise<LowStockEntryDTO[]> => unwrap(sf().inventory.getLowStockReport()),
  },
  accounts: {
    receivePayment: (input: ReceivePaymentInputDTO): Promise<ReceivePaymentResultDTO> => unwrap(sf().accounts.receivePayment(input)),
    getStatement: (customerId: string): Promise<CustomerStatementDTO> => unwrap(sf().accounts.getStatement({ customerId })),
    getTotalReceivables: (): Promise<{ total: string }> => unwrap(sf().accounts.getTotalReceivables()),
  },
  system: {
    getInfo: (): Promise<SystemInfoDTO> => unwrap(sf().system.getInfo()),
    getVersion: (): Promise<{ version: string }> => unwrap(sf().system.getVersion()),
    getDbPath: (): Promise<{ dbPath: string }> => unwrap(sf().system.getDbPath()),
  },
}
