/**
 * Hooks de TanStack Query para las entidades CRUD. Las mutaciones invalidan la
 * query de su entidad. Todo el estado servidor vive acá (no en useState).
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type {
  ArticleDTO,
  GlobalSearchResultDTO,
  InventoryReportDTO,
  LowStockReportRowDTO,
  SalesByVendorReportDTO,
  CashRegisterDTO,
  CashReportDTO,
  HistoricalCashRegisterDTO,
  HistoricalCashReportDTO,
  CompanyDTO,
  CreateSaleInputDTO,
  CreateSaleResultDTO,
  CustomerBalanceDTO,
  CustomerDTO,
  EntityPayload,
  FamilyDTO,
  PaymentMethodDTO,
  PriceUpdateBatchDTO,
  PriceUpdateBatchDetailDTO,
  PriceUpdateEntryWithBatchDTO,
  SupplierBalanceDTO,
  SupplierDTO,
  UserDTO,
} from '@/types/api'

type UpdateVars = { id: string; data: EntityPayload }

function useEntityMutations<T>(
  key: string,
  create: (data: EntityPayload) => Promise<T>,
  update: (id: string, data: EntityPayload) => Promise<T>,
  remove: (id: string) => Promise<{ deleted: true }>,
): {
  create: UseMutationResult<T, Error, EntityPayload>
  update: UseMutationResult<T, Error, UpdateVars>
  remove: UseMutationResult<{ deleted: true }, Error, string>
} {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: [key] })
  }
  return {
    create: useMutation({ mutationFn: create, onSuccess: invalidate }),
    update: useMutation({ mutationFn: ({ id, data }: UpdateVars) => update(id, data), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: remove, onSuccess: invalidate }),
  }
}

// --- Artículos ---
export function useArticles() {
  return useQuery<ArticleDTO[]>({ queryKey: ['articles'], queryFn: api.articles.list })
}
export function useArticleMutations() {
  return useEntityMutations<ArticleDTO>('articles', api.articles.create, api.articles.update, api.articles.delete)
}

// --- Clientes ---
export function useCustomers() {
  return useQuery<CustomerDTO[]>({ queryKey: ['customers'], queryFn: api.customers.list })
}
export function useCustomerMutations() {
  return useEntityMutations<CustomerDTO>('customers', api.customers.create, api.customers.update, api.customers.delete)
}

// --- Proveedores ---
export function useSuppliers() {
  return useQuery<SupplierDTO[]>({ queryKey: ['suppliers'], queryFn: api.suppliers.list })
}
export function useSupplierMutations() {
  return useEntityMutations<SupplierDTO>('suppliers', api.suppliers.create, api.suppliers.update, api.suppliers.delete)
}

// --- Familias ---
export function useFamilies() {
  return useQuery<FamilyDTO[]>({ queryKey: ['families'], queryFn: api.families.list })
}
export function useFamilyMutations() {
  return useEntityMutations<FamilyDTO>('families', api.families.create, api.families.update, api.families.delete)
}

// --- Empresa (fila única; incluye `priceMode`) ---
export function useCompany() {
  return useQuery<CompanyDTO>({ queryKey: ['company'], queryFn: api.company.get })
}

// --- Medios de pago ---
export function usePaymentMethods() {
  return useQuery<PaymentMethodDTO[]>({ queryKey: ['paymentMethods'], queryFn: api.paymentMethods.list })
}
export function usePaymentMethodMutations() {
  return useEntityMutations<PaymentMethodDTO>(
    'paymentMethods',
    api.paymentMethods.create,
    api.paymentMethods.update,
    api.paymentMethods.delete,
  )
}

// --- Usuarios ---
export function useUsers() {
  return useQuery<UserDTO[]>({ queryKey: ['users'], queryFn: api.users.list })
}
export function useUserMutations() {
  return useEntityMutations<UserDTO>('users', api.users.create, api.users.update, api.users.delete)
}

// --- Cuentas corrientes (saldos por cliente) ---
export function useCustomerBalances() {
  return useQuery<CustomerBalanceDTO[]>({ queryKey: ['customerBalances'], queryFn: api.accounts.listBalances })
}

// --- Cuentas corrientes de proveedores ---
export function useSupplierBalances() {
  return useQuery<SupplierBalanceDTO[]>({ queryKey: ['supplierBalances'], queryFn: api.supplierAccounts.listBalances })
}

// --- Caja ---
export function useCurrentCash() {
  return useQuery<CashRegisterDTO | null>({ queryKey: ['cash', 'current'], queryFn: api.cash.getCurrent })
}
export function useCashReport(registerId: string | undefined) {
  return useQuery<CashReportDTO>({
    queryKey: ['cash', 'report', registerId],
    queryFn: () => api.cash.getReport(registerId as string),
    enabled: Boolean(registerId),
    refetchInterval: 30_000,
  })
}
export function useHistoricalCashRegisters(params: { from: number; to: number; userId?: string }) {
  return useQuery<HistoricalCashRegisterDTO[]>({
    queryKey: ['cash', 'historical', params.from, params.to, params.userId ?? ''],
    queryFn: () => api.cash.listHistorical(params.from, params.to, params.userId),
  })
}
export function useHistoricalCashReport(cashRegisterId: string | undefined) {
  return useQuery<HistoricalCashReportDTO>({
    queryKey: ['cash', 'historical', 'report', cashRegisterId],
    queryFn: () => api.cash.getHistoricalReport(cashRegisterId as string),
    enabled: Boolean(cashRegisterId),
  })
}

export function useCashMutations() {
  const qc = useQueryClient()
  const invalidateCash = () => {
    void qc.invalidateQueries({ queryKey: ['cash'] })
  }
  return {
    open: useMutation({
      mutationFn: (openingAmount: string) => api.cash.open(openingAmount),
      onSuccess: invalidateCash,
    }),
    close: useMutation({
      mutationFn: ({ registerId, closingAmount, notes }: { registerId: string; closingAmount: string; notes?: string }) =>
        api.cash.close(registerId, closingAmount, notes),
      onSuccess: invalidateCash,
    }),
    addMovement: useMutation({
      mutationFn: ({
        type,
        description,
        amount,
        paymentMethodId,
      }: {
        type: 'income' | 'expense'
        description: string
        amount: string
        paymentMethodId?: string | null
      }) => api.cash.addMovement(type, description, amount, paymentMethodId ?? null),
      onSuccess: invalidateCash,
    }),
  }
}

// --- Actualización de precios ---
export function usePriceUpdateBatches(params: { from?: number; to?: number } = {}) {
  return useQuery<PriceUpdateBatchDTO[]>({
    queryKey: ['priceUpdateBatches', params.from ?? null, params.to ?? null],
    queryFn: () => api.priceUpdate.listBatches(params.from, params.to),
  })
}

export function usePriceUpdateBatchDetail(batchId: string | null | undefined) {
  return useQuery<PriceUpdateBatchDetailDTO>({
    queryKey: ['priceUpdateBatch', batchId],
    queryFn: () => api.priceUpdate.getBatchDetail(batchId as string),
    enabled: Boolean(batchId),
  })
}

export function useArticlePriceHistory(articleId: string | null | undefined, limit = 10) {
  return useQuery<PriceUpdateEntryWithBatchDTO[]>({
    queryKey: ['articlePriceHistory', articleId, limit],
    queryFn: () => api.priceUpdate.getArticleHistory(articleId as string, limit),
    enabled: Boolean(articleId),
  })
}

// --- Búsqueda global (P-BUSQUEDA) ---
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

const EMPTY_SEARCH: GlobalSearchResultDTO = {
  articles: [],
  customers: [],
  suppliers: [],
  sales: [],
  purchases: [],
}

export function useGlobalSearch(query: string, debounceMs = 200) {
  const debounced = useDebouncedValue(query.trim(), debounceMs)
  return useQuery<GlobalSearchResultDTO>({
    queryKey: ['globalSearch', debounced],
    queryFn: () => (debounced.length === 0 ? Promise.resolve(EMPTY_SEARCH) : api.search.global({ query: debounced })),
    enabled: true,
    staleTime: 10_000,
    placeholderData: (prev) => prev ?? EMPTY_SEARCH,
  })
}

// --- Reportes (P-CONSULTAS) ---
export function useLowStockReport(input: { supplierId?: string; familyId?: string; criteria?: 'min' | 'ideal' }, enabled = true) {
  return useQuery<LowStockReportRowDTO[]>({
    queryKey: ['reports', 'lowStock', input.supplierId ?? '', input.familyId ?? '', input.criteria ?? 'min'],
    queryFn: () => api.reports.getLowStock(input),
    enabled,
  })
}
export function useInventoryReport(input: { supplierId?: string; familyId?: string; includeZeroStock?: boolean }, enabled = true) {
  return useQuery<InventoryReportDTO>({
    queryKey: ['reports', 'inventory', input.supplierId ?? '', input.familyId ?? '', input.includeZeroStock ? '1' : '0'],
    queryFn: () => api.reports.getInventory(input),
    enabled,
  })
}
export function useSalesByVendorReport(input: { from: number; to: number; userId?: string }, enabled = true) {
  return useQuery<SalesByVendorReportDTO>({
    queryKey: ['reports', 'salesByVendor', input.from, input.to, input.userId ?? ''],
    queryFn: () => api.reports.getSalesByVendor(input),
    enabled,
  })
}

// --- Contabilidad (P-CONTABLE) ---
export function useFinancialSummary(input: { from: number; to: number }, enabled = true) {
  return useQuery({
    queryKey: ['accounting', 'summary', input.from, input.to],
    queryFn: () => api.accounting.getSummary(input),
    enabled,
  })
}
export function useVatBookSales(
  input: { from: number; to: number; type?: 'A' | 'B' | 'C' | 'X' | 'all' },
  enabled = true,
) {
  return useQuery({
    queryKey: ['accounting', 'vatBookSales', input.from, input.to, input.type ?? 'all'],
    queryFn: () => api.accounting.getVatBookSales(input),
    enabled,
  })
}
export function useVatBookPurchases(input: { from: number; to: number }, enabled = true) {
  return useQuery({
    queryKey: ['accounting', 'vatBookPurchases', input.from, input.to],
    queryFn: () => api.accounting.getVatBookPurchases(input),
    enabled,
  })
}

// --- Caja General (P-FIX-FASE3) ---
export function useCashGeneralBalance() {
  return useQuery<{ balance: string }>({
    queryKey: ['cashGeneral', 'balance'],
    queryFn: api.cashGeneral.getBalance,
  })
}

export function useCashGeneralMovements(
  params: import('@/types/api').ListCashGeneralMovementsInputDTO = {},
) {
  return useQuery({
    queryKey: [
      'cashGeneral',
      'movements',
      params.from ?? null,
      params.to ?? null,
      params.type ?? null,
      params.category ?? null,
      params.limit ?? null,
    ],
    queryFn: () => api.cashGeneral.listMovements(params),
  })
}

export function useCashGeneralMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['cashGeneral'] })
  }
  return {
    addIncome: useMutation({
      mutationFn: (input: import('@/types/api').AddCashGeneralMovementInputDTO) =>
        api.cashGeneral.addIncome(input),
      onSuccess: invalidate,
    }),
    addExpense: useMutation({
      mutationFn: (input: import('@/types/api').AddCashGeneralMovementInputDTO) =>
        api.cashGeneral.addExpense(input),
      onSuccess: invalidate,
    }),
    transferFromDaily: useMutation({
      mutationFn: (input: import('@/types/api').TransferFromDailyInputDTO) =>
        api.cashGeneral.transferFromDaily(input),
      onSuccess: invalidate,
    }),
  }
}

// --- Analytics (P-FIX-FASE3) ---
type DR = { from: number; to: number }

export function useTopProducts(input: DR & { limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'topProducts', input.from, input.to, input.limit ?? 10],
    queryFn: () => api.analytics.getTopSellingProducts(input),
    enabled,
  })
}
export function useBottomProducts(input: DR & { limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'bottomProducts', input.from, input.to, input.limit ?? 10],
    queryFn: () => api.analytics.getBottomSellingProducts(input),
    enabled,
  })
}
export function usePaymentMethodsRanking(input: DR, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'paymentMethodsRanking', input.from, input.to],
    queryFn: () => api.analytics.getPaymentMethodsRanking(input),
    enabled,
  })
}
export function useTopCustomers(input: DR & { limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'topCustomers', input.from, input.to, input.limit ?? 10],
    queryFn: () => api.analytics.getTopCustomers(input),
    enabled,
  })
}
export function useTopSuppliers(input: DR & { limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'topSuppliers', input.from, input.to, input.limit ?? 10],
    queryFn: () => api.analytics.getTopSuppliers(input),
    enabled,
  })
}
export function useSalesTrend(
  input: DR & { granularity: 'daily' | 'weekly' | 'monthly' },
  enabled = true,
) {
  return useQuery({
    queryKey: ['analytics', 'salesTrend', input.from, input.to, input.granularity],
    queryFn: () => api.analytics.getSalesTrend(input),
    enabled,
  })
}
export function useAverageTicket(input: DR, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'averageTicket', input.from, input.to],
    queryFn: () => api.analytics.getAverageTicket(input),
    enabled,
  })
}
export function useSalesByHour(input: DR, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'salesByHour', input.from, input.to],
    queryFn: () => api.analytics.getSalesByHour(input),
    enabled,
  })
}
export function useSalesByDayOfWeek(input: DR, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'salesByDayOfWeek', input.from, input.to],
    queryFn: () => api.analytics.getSalesByDayOfWeek(input),
    enabled,
  })
}
export function useMarginByCategory(input: DR, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'marginByCategory', input.from, input.to],
    queryFn: () => api.analytics.getMarginByCategory(input),
    enabled,
  })
}
export function useStockRotation(input: DR & { limit?: number }, enabled = true) {
  return useQuery({
    queryKey: ['analytics', 'stockRotation', input.from, input.to, input.limit ?? 20],
    queryFn: () => api.analytics.getStockRotation(input),
    enabled,
  })
}

// --- Ventas ---
export function useCreateSale(): UseMutationResult<CreateSaleResultDTO, Error, CreateSaleInputDTO> {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateSaleInputDTO) => api.sales.create(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['customerBalances'] })
    },
  })
}
