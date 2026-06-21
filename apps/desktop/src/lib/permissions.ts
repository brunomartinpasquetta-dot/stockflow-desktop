/**
 * Tipos y labels de permisos para el renderer.
 *
 * El check de permisos NO replica la matriz por rol: se hace contra la lista de
 * acciones EFECTIVAS que el backend resuelve y envía en `UserDTO.permissions`
 * (ver `hasPermissionFor`). El backend re-chequea todo de todos modos.
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
  | 'manage_mp_qr'
  | 'view_accounting'
  | 'manage_cash_general'
  | 'manage_customers'

export const ALL_ACTIONS: readonly PermissionAction[] = [
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
  'manage_mp_qr',
  'view_accounting',
  'manage_cash_general',
  'manage_customers',
]

/**
 * Check de permiso contra la lista de acciones EFECTIVAS del usuario logueado
 * (`UserDTO.permissions`, resuelta por el backend). Es la única fuente de verdad
 * del lado UI. Durante la carga inicial `permissions` es undefined → devuelve false.
 */
export function hasPermissionFor(
  permissions: readonly string[] | undefined,
  action: PermissionAction,
): boolean {
  return !!permissions?.includes(action)
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  manager: 'Encargado',
  seller: 'Vendedor',
}
