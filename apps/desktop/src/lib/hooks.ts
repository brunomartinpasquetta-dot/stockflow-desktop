/**
 * Hooks de TanStack Query para las entidades CRUD. Las mutaciones invalidan la
 * query de su entidad. Todo el estado servidor vive acá (no en useState).
 */
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type {
  ArticleDTO,
  CustomerDTO,
  EntityPayload,
  FamilyDTO,
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

// --- Usuarios ---
export function useUsers() {
  return useQuery<UserDTO[]>({ queryKey: ['users'], queryFn: api.users.list })
}
export function useUserMutations() {
  return useEntityMutations<UserDTO>('users', api.users.create, api.users.update, api.users.delete)
}
