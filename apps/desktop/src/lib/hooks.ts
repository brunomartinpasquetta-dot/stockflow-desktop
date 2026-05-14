/**
 * Hooks de TanStack Query para las entidades CRUD. Las mutaciones invalidan la
 * query de su entidad. Todo el estado servidor vive acá (no en useState).
 */
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type {
  ArticleDTO,
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
