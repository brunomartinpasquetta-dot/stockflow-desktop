/**
 * Cliente IPC tipado: envuelve `window.stockflow.*`, desempaqueta la respuesta
 * uniforme `{ ok, data } | { ok:false, code, ... }` y, en error, lanza `ApiError`.
 */
import type {
  AssistantAskResultDTO,
  AssistantMessageDTO,
  AuditEntryDTO,
  ListAuditPayloadDTO,
  ResetOperationalResultDTO,
  FiscalConfigDTO,
  SaveFiscalConfigDTO,
  SalePointDTO,
  FiscalVoucherDTO,
  IssuedVoucherDTO,
  AccountReceivableDetailDTO,
  AccountReceivableDTO,
  ArticleDTO,
  BackupConfigDTO,
  BackupEntryDTO,
  CashCloseReportDataDTO,
  ImportExecuteResultDTO,
  ImportMappingDTO,
  ImportOptionsDTO,
  ImportValidationResultDTO,
  PaymentReceiptDataDTO,
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
  CreateQuoteInputDTO,
  QuoteDTO,
  QuoteWithLinesDTO,
  QuoteConvertPreviewDTO,
  ConvertQuoteToSaleInputDTO,
  CustomerBalanceDTO,
  CustomerDTO,
  CustomerStatementDTO,
  EntityPayload,
  FamilyDTO,
  PromotionDTO,
  PromotionWritePayload,
  SaleReturnDraftDTO,
  SaleReturnResultDTO,
  PurchaseReturnDraftDTO,
  PurchaseReturnResultDTO,
  IpcErrorCode,
  IpcResponse,
  LicenseStateDTO,
  LoginResultDTO,
  LowStockEntryDTO,
  PaySupplierInvoiceInputDTO,
  PaySupplierInvoiceResultDTO,
  PayToSupplierInputDTO,
  PayToSupplierResultDTO,
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
  ReceivePaymentToCustomerInputDTO,
  ReceivePaymentToCustomerResultDTO,
  RolesConfigDTO,
  RolesSetConfigPayload,
  GlobalSearchCategoryDTO,
  GlobalSearchResultDTO,
  SaleDTO,
  SaleLineDTO,
  SalePaymentDTO,
  StockAdjustmentDTO,
  StockCheckDTO,
  SupplierAccountPayableDetailDTO,
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
  whatsapp: {
    openChat: (phone: string): Promise<{ ok: true }> => unwrap(sf().whatsapp.openChat({ phone })),
    onNavigate: (cb: (phone: string) => void): (() => void) => sf().whatsapp.onNavigate(cb),
  },
  assistant: {
    ask: (messages: AssistantMessageDTO[], conversationId?: string, screen?: string): Promise<AssistantAskResultDTO> =>
      unwrap(sf().assistant.ask({ messages, conversationId, screen })),
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
  roles: {
    getConfig: (): Promise<RolesConfigDTO> => unwrap(sf().roles.getConfig()),
    setConfig: (payload: RolesSetConfigPayload): Promise<RolesConfigDTO> => unwrap(sf().roles.setConfig(payload)),
  },
  company: {
    get: (): Promise<CompanyDTO> => unwrap(sf().company.get()),
    upsert: (data: EntityPayload): Promise<CompanyDTO> => unwrap(sf().company.upsert(data)),
  },
  sales: {
    create: (input: CreateSaleInputDTO): Promise<CreateSaleResultDTO> => unwrap(sf().sales.create(input)),
    void: (id: string): Promise<SaleDTO> => unwrap(sf().sales.void({ id })),
    voidRange: (
      from: number,
      to: number,
    ): Promise<{ anuladas: number; conCAE: number; omitidas: { number: number; motivo: string }[] }> =>
      unwrap(sf().sales.voidRange({ from, to })),
    get: (id: string): Promise<{ sale: SaleDTO; lines: SaleLineDTO[]; payments: SalePaymentDTO[] }> =>
      unwrap(sf().sales.get({ id })),
    listByDateRange: (from: number, to: number): Promise<SaleDTO[]> => unwrap(sf().sales.listByDateRange({ from, to })),
    getNextNumber: (type: VoucherType): Promise<{ number: number }> => unwrap(sf().sales.getNextNumber({ type })),
  },
  fiscal: {
    getConfig: (): Promise<FiscalConfigDTO | null> => unwrap(sf().fiscal.getConfig()),
    getConfigPublic: (): Promise<{
      enabled: boolean
      environment: 'homologacion' | 'produccion'
      vatCondition: 'RI' | 'MT'
    } | null> => unwrap(sf().fiscal.getConfigPublic()),
    saveConfig: (payload: SaveFiscalConfigDTO): Promise<FiscalConfigDTO> =>
      unwrap(sf().fiscal.saveConfig(payload)),
    testConnection: (): Promise<{ ok: boolean; message: string; servers?: string }> =>
      unwrap(sf().fiscal.testConnection()),
    listSalePoints: (): Promise<SalePointDTO[]> => unwrap(sf().fiscal.listSalePoints()),
    fetchSalePointsFromArca: (): Promise<{ number: number; type: string; blocked: boolean }[]> =>
      unwrap(sf().fiscal.fetchSalePointsFromArca()),
    saveSalePoint: (payload: {
      number: number
      description: string
      terminalId?: string | null
      active?: boolean
    }): Promise<SalePointDTO> => unwrap(sf().fiscal.saveSalePoint(payload)),
    deleteSalePoint: (id: string): Promise<{ ok: true }> =>
      unwrap(sf().fiscal.deleteSalePoint({ id })),
    issueInvoice: (payload: {
      saleId: string
      salePoint: number
      letter?: 'A' | 'B' | 'C'
    }): Promise<IssuedVoucherDTO> => unwrap(sf().fiscal.issueInvoice(payload)),
    issueNote: (payload: {
      relatedVoucherId: string
      kind: 'credit_note' | 'debit_note'
      total?: string
      reason?: string
    }): Promise<IssuedVoucherDTO> => unwrap(sf().fiscal.issueNote(payload)),
    getVoucherForSale: (saleId: string): Promise<FiscalVoucherDTO | null> =>
      unwrap(sf().fiscal.getVoucherForSale({ saleId })),
    listVouchers: (payload: { from?: number; to?: number; limit?: number } = {}): Promise<FiscalVoucherDTO[]> =>
      unwrap(sf().fiscal.listVouchers(payload)),
    archivarPendientes: (): Promise<{ archivadas: number; total: number }> =>
      unwrap(sf().fiscal.archivarPendientes()),
    getPdfFolder: (): Promise<{ folder: string }> => unwrap(sf().fiscal.getPdfFolder()),
    openPdfFolder: (): Promise<{ ok: true }> => unwrap(sf().fiscal.openPdfFolder()),
  },
  maintenance: {
    resetOperationalData: (payload: { password: string }): Promise<ResetOperationalResultDTO> =>
      unwrap(sf().maintenance.resetOperationalData(payload)),
  },
  audit: {
    list: (payload: ListAuditPayloadDTO): Promise<AuditEntryDTO[]> => unwrap(sf().audit.list(payload)),
    listAreas: (): Promise<string[]> => unwrap(sf().audit.listAreas()),
  },
  returns: {
    createForSale: (input: SaleReturnDraftDTO): Promise<SaleReturnResultDTO> =>
      unwrap(sf().returns.createForSale(input)),
    listBySale: (saleId: string): Promise<SaleReturnResultDTO[]> =>
      unwrap(sf().returns.listBySale({ saleId })),
    createForPurchase: (input: PurchaseReturnDraftDTO): Promise<PurchaseReturnResultDTO> =>
      unwrap(sf().returns.createForPurchase(input)),
    listByPurchase: (purchaseId: string): Promise<PurchaseReturnResultDTO[]> =>
      unwrap(sf().returns.listByPurchase({ purchaseId })),
  },
  promotions: {
    list: (): Promise<PromotionDTO[]> => unwrap(sf().promotions.list()),
    get: (id: string): Promise<PromotionDTO | null> => unwrap(sf().promotions.get({ id })),
    create: (data: PromotionWritePayload): Promise<PromotionDTO> => unwrap(sf().promotions.create(data)),
    update: (id: string, data: PromotionWritePayload): Promise<PromotionDTO> =>
      unwrap(sf().promotions.update({ id, data })),
    setActive: (id: string, active: boolean): Promise<PromotionDTO> =>
      unwrap(sf().promotions.setActive({ id, active })),
    delete: (id: string): Promise<{ deleted: true }> => unwrap(sf().promotions.delete({ id })),
  },
  quotes: {
    create: (input: CreateQuoteInputDTO): Promise<QuoteWithLinesDTO> => unwrap(sf().quotes.create(input)),
    get: (id: string): Promise<QuoteWithLinesDTO> => unwrap(sf().quotes.get({ id })),
    listByDateRange: (from: number, to: number): Promise<QuoteDTO[]> => unwrap(sf().quotes.listByDateRange({ from, to })),
    delete: (id: string): Promise<{ ok: true }> => unwrap(sf().quotes.delete({ id })),
    previewConvert: (quoteId: string, refreshPrices: boolean): Promise<QuoteConvertPreviewDTO> =>
      unwrap(sf().quotes.previewConvert({ quoteId, refreshPrices })),
    convertToSale: (input: ConvertQuoteToSaleInputDTO): Promise<{ sale: SaleDTO; quoteId: string }> =>
      unwrap(sf().quotes.convertToSale(input)),
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
    payToSupplier: (input: PayToSupplierInputDTO): Promise<PayToSupplierResultDTO> => unwrap(sf().supplierAccounts.payToSupplier(input)),
    getStatement: (supplierId: string): Promise<SupplierStatementDTO> => unwrap(sf().supplierAccounts.getStatement({ supplierId })),
    listOpenBySupplier: (supplierId: string): Promise<SupplierAccountPayableDTO[]> => unwrap(sf().supplierAccounts.listOpenBySupplier({ supplierId })),
    getAccountDetail: (accountId: string): Promise<SupplierAccountPayableDetailDTO> => unwrap(sf().supplierAccounts.getAccountDetail({ accountId })),
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
    receivePaymentToCustomer: (input: ReceivePaymentToCustomerInputDTO): Promise<ReceivePaymentToCustomerResultDTO> =>
      unwrap(sf().accounts.receivePaymentToCustomer(input)),
    getStatement: (customerId: string): Promise<CustomerStatementDTO> => unwrap(sf().accounts.getStatement({ customerId })),
    getTotalReceivables: (): Promise<{ total: string }> => unwrap(sf().accounts.getTotalReceivables()),
    listBalances: (): Promise<CustomerBalanceDTO[]> => unwrap(sf().accounts.listBalances()),
    listOpenByCustomer: (customerId: string): Promise<AccountReceivableDTO[]> => unwrap(sf().accounts.listOpenByCustomer({ customerId })),
    getAccountDetail: (accountId: string): Promise<AccountReceivableDetailDTO> => unwrap(sf().accounts.getAccountDetail({ accountId })),
  },
  search: {
    global: (payload: { query: string; limitPerCategory?: number; categories?: GlobalSearchCategoryDTO[] }): Promise<GlobalSearchResultDTO> =>
      unwrap(sf().search.global(payload)),
  },
  reports: {
    getLowStock: (input: { supplierId?: string; familyId?: string; criteria?: 'min' | 'ideal' }) =>
      unwrap(sf().reports.getLowStock(input)),
    getInventory: (input: { supplierId?: string; familyId?: string; brand?: string; includeZeroStock?: boolean }) =>
      unwrap(sf().reports.getInventory(input)),
    getSalesByVendor: (input: { from: number; to: number; userId?: string }) =>
      unwrap(sf().reports.getSalesByVendor(input)),
  },
  accounting: {
    getSummary: (input: { from: number; to: number }) => unwrap(sf().accounting.getSummary(input)),
    getVatBookSales: (input: { from: number; to: number; type?: 'A' | 'B' | 'C' | 'X' | 'all' }) =>
      unwrap(sf().accounting.getVatBookSales(input)),
    getVatBookPurchases: (input: { from: number; to: number }) =>
      unwrap(sf().accounting.getVatBookPurchases(input)),
  },
  cashGeneral: {
    getBalance: () => unwrap(sf().cashGeneral.getBalance()),
    getBalanceBreakdown: () => unwrap(sf().cashGeneral.getBalanceBreakdown()),
    adjustBreakdown: (cashAmount: string) => unwrap(sf().cashGeneral.adjustBreakdown({ cashAmount })),
    listMovements: (input: import('@/types/api').ListCashGeneralMovementsInputDTO = {}) =>
      unwrap(sf().cashGeneral.listMovements(input)),
    addIncome: (input: import('@/types/api').AddCashGeneralMovementInputDTO) =>
      unwrap(sf().cashGeneral.addIncome(input)),
    addExpense: (input: import('@/types/api').AddCashGeneralMovementInputDTO) =>
      unwrap(sf().cashGeneral.addExpense(input)),
    transferFromDaily: (input: import('@/types/api').TransferFromDailyInputDTO) =>
      unwrap(sf().cashGeneral.transferFromDaily(input)),
    transferFromClosed: (input: import('@/types/api').TransferFromDailyInputDTO) =>
      unwrap(sf().cashGeneral.transferFromClosed(input)),
  },
  analytics: {
    getTopSellingProducts: (input: { from: number; to: number; limit?: number }) =>
      unwrap(sf().analytics.getTopSellingProducts(input)),
    getBottomSellingProducts: (input: { from: number; to: number; limit?: number }) =>
      unwrap(sf().analytics.getBottomSellingProducts(input)),
    getPaymentMethodsRanking: (input: { from: number; to: number }) =>
      unwrap(sf().analytics.getPaymentMethodsRanking(input)),
    ventasPorFormaPago: (input: { from: number; to: number }) =>
      unwrap(sf().analytics.ventasPorFormaPago(input)),
    ventasPorFormaPagoEnTiempo: (
      input: { from: number; to: number; granularity: 'daily' | 'weekly' | 'monthly' },
    ) => unwrap(sf().analytics.ventasPorFormaPagoEnTiempo(input)),
    getTopCustomers: (input: { from: number; to: number; limit?: number }) =>
      unwrap(sf().analytics.getTopCustomers(input)),
    getTopSuppliers: (input: { from: number; to: number; limit?: number }) =>
      unwrap(sf().analytics.getTopSuppliers(input)),
    getSalesTrend: (
      input: { from: number; to: number; granularity: 'daily' | 'weekly' | 'monthly' },
    ) => unwrap(sf().analytics.getSalesTrend(input)),
    getAverageTicket: (input: { from: number; to: number }) =>
      unwrap(sf().analytics.getAverageTicket(input)),
    getSalesByHour: (input: { from: number; to: number }) =>
      unwrap(sf().analytics.getSalesByHour(input)),
    getSalesByDayOfWeek: (input: { from: number; to: number }) =>
      unwrap(sf().analytics.getSalesByDayOfWeek(input)),
    getMarginByCategory: (input: { from: number; to: number }) =>
      unwrap(sf().analytics.getMarginByCategory(input)),
    getStockRotation: (input: { from: number; to: number; limit?: number }) =>
      unwrap(sf().analytics.getStockRotation(input)),
  },
  system: {
    onDataChanged: (cb: (info: { channel: string; group: string }) => void): (() => void) =>
      sf().system.onDataChanged(cb),
    pickFile: (filters?: { name: string; extensions: string[] }[]): Promise<{ filePath: string | null }> =>
      unwrap(sf().system.pickFile({ filters })),
    pickImage: (): Promise<{ filePath: string | null }> => unwrap(sf().system.pickImage()),
    getInfo: (): Promise<SystemInfoDTO> => unwrap(sf().system.getInfo()),
    getVersion: (): Promise<{ version: string }> => unwrap(sf().system.getVersion()),
    getDbPath: (): Promise<{ dbPath: string }> => unwrap(sf().system.getDbPath()),
    showInFolder: (path: string): Promise<{ ok: true }> => unwrap(sf().system.showInFolder({ path })),
    openExternal: (url: string): Promise<{ ok: true }> => unwrap(sf().system.openExternal({ url })),
  },
  print: {
    diagnose: (payload: { deviceName?: string }): Promise<{ report: string }> =>
      unwrap(sf().print.diagnose(payload)),
    listElectron: (): Promise<import('@/types/api').SystemPrinterDTO[]> =>
      unwrap(sf().print.listElectron()),
    silentCurrent: (deviceName: string): Promise<{ printed: boolean }> =>
      unwrap(sf().print.silentCurrent({ deviceName })),
  },
  desktopWindow: {
    open: (
      payload: import('@/types/api').DesktopWindowOpenDTO,
    ): Promise<{ windowKey: string; created: boolean }> =>
      unwrap(sf().desktopWindow.open(payload)),
    close: (windowKey: string): Promise<{ closed: boolean }> =>
      unwrap(sf().desktopWindow.close({ windowKey })),
    focus: (windowKey: string): Promise<{ focused: boolean }> =>
      unwrap(sf().desktopWindow.focus({ windowKey })),
    list: (): Promise<{ windows: import('@/types/api').DesktopWindowInfoDTO[] }> =>
      unwrap(sf().desktopWindow.list()),
    closeSelf: (): Promise<{ closed: boolean }> => unwrap(sf().desktopWindow.closeSelf()),
    minimizeSelf: (): Promise<{ minimized: boolean }> => unwrap(sf().desktopWindow.minimizeSelf()),
    focusMain: (): Promise<{ ok: true }> => unwrap(sf().desktopWindow.focusMain()),
    openManual: (): Promise<{ created: boolean }> => unwrap(sf().desktopWindow.openManual()),
  },
  license: {
    getState: (): Promise<LicenseStateDTO> => unwrap(sf().license.getState()),
    activate: (key: string): Promise<LicenseStateDTO> => unwrap(sf().license.activate({ licenseKey: key })),
    activateTrial: (input: { fullName: string; companyName: string; phone: string }): Promise<LicenseStateDTO> =>
      unwrap(sf().license.activateTrial(input)),
    heartbeat: (): Promise<LicenseStateDTO> => unwrap(sf().license.heartbeat()),
    deactivate: (): Promise<LicenseStateDTO> => unwrap(sf().license.deactivate()),
    onChanged: (cb: () => void): (() => void) => sf().license.onChanged(cb),
  },
  hardware: {
    listUsbDevices: (): Promise<UsbDeviceInfoDTO[]> => unwrap(sf().hardware.listUsbDevices()),
    listSerialPorts: (): Promise<SerialPortInfoDTO[]> => unwrap(sf().hardware.listSerialPorts()),
    printer: {
      getConfig: (): Promise<PrinterConfigDTO | null> => unwrap(sf().hardware.printer.getConfig()),
      setConfig: (cfg: PrinterConfigDTO | null): Promise<{ ok: true }> => unwrap(sf().hardware.printer.setConfig(cfg)),
      test: (): Promise<{ ok: true }> => unwrap(sf().hardware.printer.test()),
      printSaleTicket: (data: SaleTicketDataDTO): Promise<{ ok: true }> => unwrap(sf().hardware.printer.printSaleTicket(data)),
      printPaymentReceipt: (data: PaymentReceiptDataDTO): Promise<{ ok: true }> => unwrap(sf().hardware.printer.printPaymentReceipt(data)),
      printCashClose: (data: CashCloseReportDataDTO): Promise<{ ok: true }> => unwrap(sf().hardware.printer.printCashClose(data)),
      listSystem: (): Promise<import('@/types/api').SystemPrinterDTO[]> => unwrap(sf().hardware.printer.listSystem()),
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
    openFirewall: () => unwrap(sf().lan.openFirewall()),
    diagnose: () => unwrap(sf().lan.diagnose()),
    getConnectedClients: () => unwrap(sf().lan.getConnectedClients()),
    applyAndRestart: () => unwrap(sf().lan.applyAndRestart()),
    /**
     * Ping directo desde el renderer (HTTP GET /lan/ping al server LAN).
     * No usa IPC: el renderer puede hacer fetch sin CORS issues (server permite *).
     */
    pingServer: async (ip: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; latencyMs?: number; license?: string }> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const start = Date.now()
      try {
        const res = await fetch(`http://${ip}:${port}/lan/ping`, { signal: controller.signal })
        if (!res.ok) return { ok: false }
        // El servidor informa su licencia: el puesto no tiene una propia y
        // trabaja amparado por ella (una licencia por comercio).
        const body = (await res.json().catch(() => ({}))) as { license?: string }
        return { ok: true, latencyMs: Date.now() - start, license: body.license }
      } catch {
        return { ok: false }
      } finally {
        clearTimeout(timer)
      }
    },
  },
  mpQr: {
    getConfig: () => unwrap(sf().mpQr.getConfig()),
    setupCompany: (payload: import('@/types/api').MpSetupInputDTO) => unwrap(sf().mpQr.setupCompany(payload)),
    testConnection: () => unwrap(sf().mpQr.testConnection()),
    listPosDevices: () => unwrap(sf().mpQr.listPosDevices()),
    createPosDevice: (cashRegisterId: string) => unwrap(sf().mpQr.createPosDevice({ cashRegisterId })),
    getQrForCashRegister: (cashRegisterId: string) => unwrap(sf().mpQr.getQrForCashRegister({ cashRegisterId })),
    createOrder: (payload: import('@/types/api').MpCreateOrderInputDTO) => unwrap(sf().mpQr.createOrder(payload)),
    cancelOrder: (orderId: string) => unwrap(sf().mpQr.cancelOrder({ orderId })),
    verifyPayment: (orderId: string) => unwrap(sf().mpQr.verifyPayment({ orderId })),
    getActiveOrder: (cashRegisterId: string) => unwrap(sf().mpQr.getActiveOrder({ cashRegisterId })),
    listOrders: (from: number, to: number) => unwrap(sf().mpQr.listOrders({ from, to })),
    linkOrderToSale: (orderId: string, saleId: string) => unwrap(sf().mpQr.linkOrderToSale({ orderId, saleId })),
  },
  updater: {
    checkNow: () => unwrap(sf().updater.checkNow()),
    quitAndInstall: () => unwrap(sf().updater.quitAndInstall()),
    getPending: () => unwrap(sf().updater.getPending()),
    getAutoCheck: () => unwrap(sf().updater.getAutoCheck()),
    setAutoCheck: (autoCheck: boolean) => unwrap(sf().updater.setAutoCheck({ autoCheck })),
    getChannel: () => unwrap(sf().updater.getChannel()),
    setChannel: (channel: 'stable' | 'beta') => unwrap(sf().updater.setChannel({ channel })),
    onAvailable: (cb: (info: { version: string }) => void) => sf().updater.onAvailable(cb),
    onDownloaded: (cb: (info: { version: string }) => void) => sf().updater.onDownloaded(cb),
    onOutdated: (
      cb: (info: { currentVersion: string; latestVersion: string; downloadUrl: string }) => void,
    ) => sf().updater.onOutdated(cb),
  },
}
