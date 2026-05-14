/**
 * Matriz de permisos por rol (réplica del lado UI de la de @stockflow/core, para
 * no arrastrar el grafo de los packages al renderer). El backend re-chequea todo.
 */
import type { Role } from '@/types/api'

export type PermissionAction =
  | 'manage_users'
  | 'manage_company'
  | 'manage_articles'
  | 'manage_suppliers'
  | 'manage_families'
  | 'manage_cards'
  | 'manage_payment_methods'
  | 'manage_purchases'
  | 'manage_supplier_accounts'
  | 'void_sale'
  | 'close_cash'
  | 'add_cash_movement'
  | 'adjust_stock'
  | 'view_reports'
  | 'create_sale'
  | 'view_articles'
  | 'open_cash'
  | 'receive_payment'
  | 'manage_hardware'
  | 'manage_backup'
  | 'import_data'
  | 'manage_prices'

const ALL_ACTIONS: readonly PermissionAction[] = [
  'manage_users',
  'manage_company',
  'manage_articles',
  'manage_suppliers',
  'manage_families',
  'manage_cards',
  'manage_payment_methods',
  'manage_purchases',
  'manage_supplier_accounts',
  'void_sale',
  'close_cash',
  'add_cash_movement',
  'adjust_stock',
  'view_reports',
  'create_sale',
  'view_articles',
  'open_cash',
  'receive_payment',
  'manage_hardware',
  'manage_backup',
  'import_data',
  'manage_prices',
]

const MANAGER_DENIED = new Set<PermissionAction>(['manage_users', 'manage_company', 'adjust_stock'])
const SELLER_ALLOWED = new Set<PermissionAction>(['create_sale', 'view_articles', 'open_cash', 'receive_payment'])

const MATRIX: Record<Role, ReadonlySet<PermissionAction>> = {
  admin: new Set(ALL_ACTIONS),
  manager: new Set(ALL_ACTIONS.filter((a) => !MANAGER_DENIED.has(a))),
  seller: SELLER_ALLOWED,
}

export function hasPermission(role: Role | null | undefined, action: PermissionAction): boolean {
  if (!role) return false
  return MATRIX[role]?.has(action) ?? false
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  manager: 'Encargado',
  seller: 'Vendedor',
}
