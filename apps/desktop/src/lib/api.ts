/**
 * Cliente IPC tipado: envuelve `window.stockflow.*`, desempaqueta la respuesta
 * uniforme `{ ok, data } | { ok:false, code, ... }` y, en error, lanza `ApiError`.
 */
import type {
  AccountReceivableDTO,
  ArticleDTO,
  BackupConfigDTO,
  BackupEntryDTO,
  CashCloseReportDataDTO,
  ImportExecuteResultDTO,
  ImportMappingDTO,
  ImportOptionsDTO,
  ImportValidationResultDTO,
  PrinterConfigDTO,
  SaleTicketDataDTO,
  ScaleConfigDTO,
  SerialPortInfoDTO,
  UsbDeviceInfoDTO,
  WeightReadingDTO,
  CashMovementDTO,
  CashRegisterDTO,
  CashReportDTO,
  HistoricalCashRegisterDTO,
  HistoricalCashReportDTO,
  CompanyDTO,
  CreatePurchaseInputDTO,
  CreatePurchaseResultDTO,
  CreateSaleInputDTO,
  CreateSaleResultDTO,
  CustomerBalanceDTO,
  CustomerDTO,
  CustomerStatementDTO,
  EntityPayload,
  FamilyDTO,
  IpcErrorCode,
  IpcResponse,
  LicenseStateDTO,
  LoginResultDTO,
  LowStockEntryDTO,
  PaySupplierInvoiceInputDTO,
  PaySupplierInvoiceResultDTO,
  PaymentMethodDTO,
  PriceUpdateApplyResultDTO,
  PriceUpdateBatchDTO,
  PriceUpdateBatchDetailDTO,
  PriceUpdateEntryWithBatchDTO,
  PriceUpdateFilterDTO,
  PriceUpdatePreviewResultDTO,
  PriceUpdateRuleDTO,
  PurchaseDTO,
  PurchaseLineDTO,
  ReceivePaymentInputDTO,
  ReceivePaymentResultDTO,
  SaleDTO,
  SaleLineDTO,
  SalePaymentDTO,
  StockAdjustmentDTO,
  StockCheckDTO,
  SupplierAccountPayableDTO,
  SupplierBalanceDTO,
  SupplierDTO,
  SupplierStatementDTO,
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
    uploadImage: (articleId: string, sourcePath: string): Promise<{ imagePath: string }> =>
      unwrap(sf().articles.uploadImage({ articleId, sourcePath })),
    removeImage: (articleId: string): Promise<{ ok: true }> =>
      unwrap(sf().articles.removeImage({ articleId })),
    getImageDataUrl: (articleId: string): Promise<{ dataUrl: string | null }> =>
      unwrap(sf().articles.getImageDataUrl({ articleId })),
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
  paymentMethods: {
    list: (): Promise<PaymentMethodDTO[]> => unwrap(sf().paymentMethods.list()),
    get: (id: string): Promise<PaymentMethodDTO | null> => unwrap(sf().paymentMethods.get({ id })),
    create: (data: EntityPayload): Promise<PaymentMethodDTO> => unwrap(sf().paymentMethods.create(data)),
    update: (id: string, data: EntityPayload): Promise<PaymentMethodDTO> => unwrap(sf().paymentMethods.update({ id, data })),
    delete: (id: string): Promise<{ deleted: true }> => unwrap(sf().paymentMethods.delete({ id })),
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
    get: (id: string): Promise<{ sale: SaleDTO; lines: SaleLineDTO[]; payments: SalePaymentDTO[] }> =>
      unwrap(sf().sales.get({ id })),
    listByDateRange: (from: number, to: number): Promise<SaleDTO[]> => unwrap(sf().sales.listByDateRange({ from, to })),
    getNextNumber: (type: VoucherType): Promise<{ number: number }> => unwrap(sf().sales.getNextNumber({ type })),
  },
  purchases: {
    create: (input: CreatePurchaseInputDTO): Promise<CreatePurchaseResultDTO> => unwrap(sf().purchases.create(input)),
    void: (id: string): Promise<PurchaseDTO> => unwrap(sf().purchases.void({ id })),
    get: (id: string): Promise<{ purchase: PurchaseDTO; lines: PurchaseLineDTO[] }> => unwrap(sf().purchases.get({ id })),
    listByDateRange: (from: number, to: number): Promise<PurchaseDTO[]> => unwrap(sf().purchases.listByDateRange({ from, to })),
    getNextNumber: (type: VoucherType): Promise<{ number: number }> => unwrap(sf().purchases.getNextNumber({ type })),
  },
  supplierAccounts: {
    listBalances: (): Promise<SupplierBalanceDTO[]> => unwrap(sf().supplierAccounts.listBalances()),
    payInvoice: (input: PaySupplierInvoiceInputDTO): Promise<PaySupplierInvoiceResultDTO> => unwrap(sf().supplierAccounts.payInvoice(input)),
    getStatement: (supplierId: string): Promise<SupplierStatementDTO> => unwrap(sf().supplierAccounts.getStatement({ supplierId })),
    listOpenBySupplier: (supplierId: string): Promise<SupplierAccountPayableDTO[]> => unwrap(sf().supplierAccounts.listOpenBySupplier({ supplierId })),
  },
  cash: {
    open: (openingAmount: string): Promise<CashRegisterDTO> => unwrap(sf().cash.open({ openingAmount })),
    close: (registerId: string, closingAmount: string, notes?: string): Promise<{ register: CashRegisterDTO; report: CashReportDTO }> =>
      unwrap(sf().cash.close({ registerId, closingAmount, notes: notes ?? null })),
    getCurrent: (): Promise<CashRegisterDTO | null> => unwrap(sf().cash.getCurrent()),
    getReport: (registerId: string): Promise<CashReportDTO> => unwrap(sf().cash.getReport({ registerId })),
    addMovement: (
      type: 'income' | 'expense',
      description: string,
      amount: string,
      paymentMethodId?: string | null,
    ): Promise<CashMovementDTO> =>
      unwrap(sf().cash.addMovement({ type, description, amount, paymentMethodId: paymentMethodId ?? null })),
    listHistorical: (from: number, to: number, userId?: string): Promise<HistoricalCashRegisterDTO[]> =>
      unwrap(sf().cash.listHistorical({ from, to, userId })),
    getHistoricalReport: (cashRegisterId: string): Promise<HistoricalCashReportDTO> =>
      unwrap(sf().cash.getHistoricalReport({ cashRegisterId })),
  },
  inventory: {
    checkStock: (articleId: string, quantity: string): Promise<StockCheckDTO> => unwrap(sf().inventory.checkStock({ articleId, quantity })),
    adjustStock: (articleId: string, newStock: string, reason: string): Promise<StockAdjustmentDTO> =>
      unwrap(sf().inventory.adjustStock({ articleId, newStock, reason })),
    getLowStockReport: (): Promise<LowStockEntryDTO[]> => unwrap(sf().inventory.getLowStockReport()),
  },
  priceUpdate: {
    preview: (filter: PriceUpdateFilterDTO, rule: PriceUpdateRuleDTO): Promise<PriceUpdatePreviewResultDTO> =>
      unwrap(sf().priceUpdate.preview({ filter, rule })),
    apply: (filter: PriceUpdateFilterDTO, rule: PriceUpdateRuleDTO, description: string): Promise<PriceUpdateApplyResultDTO> =>
      unwrap(sf().priceUpdate.apply({ filter, rule, description })),
    listBatches: (from?: number, to?: number): Promise<PriceUpdateBatchDTO[]> =>
      unwrap(sf().priceUpdate.listBatches({ from, to })),
    getBatchDetail: (batchId: string): Promise<PriceUpdateBatchDetailDTO> =>
      unwrap(sf().priceUpdate.getBatchDetail({ batchId })),
    rollback: (batchId: string): Promise<{ entriesReverted: number }> =>
      unwrap(sf().priceUpdate.rollback({ batchId })),
    getArticleHistory: (articleId: string, limit?: number): Promise<PriceUpdateEntryWithBatchDTO[]> =>
      unwrap(sf().priceUpdate.getArticleHistory({ articleId, limit })),
  },
  accounts: {
    receivePayment: (input: ReceivePaymentInputDTO): Promise<ReceivePaymentResultDTO> => unwrap(sf().accounts.receivePayment(input)),
    getStatement: (customerId: string): Promise<CustomerStatementDTO> => unwrap(sf().accounts.getStatement({ customerId })),
    getTotalReceivables: (): Promise<{ total: string }> => unwrap(sf().accounts.getTotalReceivables()),
    listBalances: (): Promise<CustomerBalanceDTO[]> => unwrap(sf().accounts.listBalances()),
    listOpenByCustomer: (customerId: string): Promise<AccountReceivableDTO[]> => unwrap(sf().accounts.listOpenByCustomer({ customerId })),
  },
  system: {
    pickFile: (filters?: { name: string; extensions: string[] }[]): Promise<{ filePath: string | null }> =>
      unwrap(sf().system.pickFile({ filters })),
    pickImage: (): Promise<{ filePath: string | null }> => unwrap(sf().system.pickImage()),
    getInfo: (): Promise<SystemInfoDTO> => unwrap(sf().system.getInfo()),
    getVersion: (): Promise<{ version: string }> => unwrap(sf().system.getVersion()),
    getDbPath: (): Promise<{ dbPath: string }> => unwrap(sf().system.getDbPath()),
  },
  license: {
    getState: (): Promise<LicenseStateDTO> => unwrap(sf().license.getState()),
    activate: (key: string): Promise<LicenseStateDTO> => unwrap(sf().license.activate({ licenseKey: key })),
    heartbeat: (): Promise<LicenseStateDTO> => unwrap(sf().license.heartbeat()),
  },
  hardware: {
    listUsbDevices: (): Promise<UsbDeviceInfoDTO[]> => unwrap(sf().hardware.listUsbDevices()),
    listSerialPorts: (): Promise<SerialPortInfoDTO[]> => unwrap(sf().hardware.listSerialPorts()),
    printer: {
      getConfig: (): Promise<PrinterConfigDTO | null> => unwrap(sf().hardware.printer.getConfig()),
      setConfig: (cfg: PrinterConfigDTO | null): Promise<{ ok: true }> => unwrap(sf().hardware.printer.setConfig(cfg)),
      test: (): Promise<{ ok: true }> => unwrap(sf().hardware.printer.test()),
      printSaleTicket: (data: SaleTicketDataDTO): Promise<{ ok: true }> => unwrap(sf().hardware.printer.printSaleTicket(data)),
      printCashClose: (data: CashCloseReportDataDTO): Promise<{ ok: true }> => unwrap(sf().hardware.printer.printCashClose(data)),
    },
    cashDrawer: {
      open: (): Promise<{ ok: true }> => unwrap(sf().hardware.cashDrawer.open()),
    },
    scale: {
      getConfig: (): Promise<ScaleConfigDTO | null> => unwrap(sf().hardware.scale.getConfig()),
      setConfig: (cfg: ScaleConfigDTO | null): Promise<{ ok: true }> => unwrap(sf().hardware.scale.setConfig(cfg)),
      read: (): Promise<WeightReadingDTO> => unwrap(sf().hardware.scale.read()),
    },
    onScaleWeight: (cb: (reading: WeightReadingDTO) => void): (() => void) => sf().hardware.onScaleWeight(cb),
  },
  backup: {
    create: (): Promise<BackupEntryDTO> => unwrap(sf().backup.create()),
    list: (): Promise<BackupEntryDTO[]> => unwrap(sf().backup.list()),
    restore: (zipPath: string): Promise<{ requiresRestart: true }> => unwrap(sf().backup.restore({ zipPath })),
    getConfig: (): Promise<BackupConfigDTO> => unwrap(sf().backup.getConfig()),
    setConfig: (cfg: BackupConfigDTO): Promise<{ ok: true }> => unwrap(sf().backup.setConfig(cfg)),
  },
  import: {
    parseFile: (filePath: string): Promise<{ sheets: string[]; preview: Array<Record<string, unknown>>; headers: string[]; totalRows: number }> =>
      unwrap(sf().import.parseFile({ filePath })),
    validate: (filePath: string, mapping: ImportMappingDTO): Promise<ImportValidationResultDTO> =>
      unwrap(sf().import.validate({ filePath, mapping })),
    execute: (filePath: string, mapping: ImportMappingDTO, options: ImportOptionsDTO): Promise<ImportExecuteResultDTO> =>
      unwrap(sf().import.execute({ filePath, mapping, options })),
    onProgress: (cb: (p: { done: number; total: number }) => void): (() => void) => sf().import.onProgress(cb),
  },
  lan: {
    getConfig: () => unwrap(sf().lan.getConfig()),
    getLocalIp: () => unwrap(sf().lan.getLocalIp()),
    setMode: (payload: import('@/types/api').LanSetModeInputDTO) => unwrap(sf().lan.setMode(payload)),
    testConnection: (ip: string, port: number, token?: string) =>
      unwrap(sf().lan.testConnection({ ip, port, token })),
    scanNetwork: () => unwrap(sf().lan.scanNetwork()),
    getConnectedClients: () => unwrap(sf().lan.getConnectedClients()),
    applyAndRestart: () => unwrap(sf().lan.applyAndRestart()),
    /**
     * Ping directo desde el renderer (HTTP GET /lan/ping al server LAN).
     * No usa IPC: el renderer puede hacer fetch sin CORS issues (server permite *).
     */
    pingServer: async (ip: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; latencyMs?: number }> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const start = Date.now()
      try {
        const res = await fetch(`http://${ip}:${port}/lan/ping`, { signal: controller.signal })
        if (!res.ok) return { ok: false }
        return { ok: true, latencyMs: Date.now() - start }
      } catch {
        return { ok: false }
      } finally {
        clearTimeout(timer)
      }
    },
  },
  updater: {
    checkNow: () => unwrap(sf().updater.checkNow()),
    quitAndInstall: () => unwrap(sf().updater.quitAndInstall()),
    getAutoCheck: () => unwrap(sf().updater.getAutoCheck()),
    setAutoCheck: (autoCheck: boolean) => unwrap(sf().updater.setAutoCheck({ autoCheck })),
    onAvailable: (cb: (info: { version: string }) => void) => sf().updater.onAvailable(cb),
    onDownloaded: (cb: (info: { version: string }) => void) => sf().updater.onDownloaded(cb),
  },
}
