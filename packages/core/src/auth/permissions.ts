/**
 * Matriz de permisos: qué acciones puede ejecutar cada rol.
 *
 *  rol \ acción      | admin | manager | seller
 *  ------------------+-------+---------+--------
 *  manage_users      |   ✓   |    ✗    |   ✗
 *  manage_company    |   ✓   |    ✗    |   ✗
 *  manage_articles   |   ✓   |    ✓    |   ✗
 *  manage_suppliers  |   ✓   |    ✓    |   ✗
 *  manage_families   |   ✓   |    ✓    |   ✗
 *  manage_cards      |   ✓   |    ✓    |   ✗
 *  manage_purchases  |   ✓   |    ✓    |   ✗
 *  void_sale         |   ✓   |    ✓    |   ✗
 *  close_cash        |   ✓   |    ✓    |   ✗(*)
 *  add_cash_movement |   ✓   |    ✓    |   ✗
 *  adjust_stock      |   ✓   |    ✗    |   ✗
 *  view_reports      |   ✓   |    ✓    |   ✗
 *  create_sale       |   ✓   |    ✓    |   ✓
 *  view_articles     |   ✓   |    ✓    |   ✓
 *  open_cash         |   ✓   |    ✓    |   ✓
 *  receive_payment   |   ✓   |    ✓    |   ✓
 *
 *  (*) un seller puede cerrar SU PROPIA caja aunque no tenga `close_cash`
 *      (la excepción la maneja CashService.closeCashRegister, no esta matriz).
 */
import type { UserRole } from '@stockflow/shared';

import { PermissionDeniedError } from '../errors';

export const PERMISSION_ACTIONS = [
  'manage_users',
  'manage_company',
  'manage_articles',
  'manage_suppliers',
  'manage_families',
  'manage_cards',
  'manage_purchases',
  'void_sale',
  'close_cash',
  'add_cash_movement',
  'adjust_stock',
  'view_reports',
  'create_sale',
  'view_articles',
  'open_cash',
  'receive_payment',
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Acciones que un seller puede ejecutar (el resto le está vedado). */
const SELLER_ACTIONS: ReadonlySet<PermissionAction> = new Set([
  'create_sale',
  'view_articles',
  'open_cash',
  'receive_payment',
]);

/** Acciones que un manager NO puede ejecutar (admin sí). */
const MANAGER_DENIED: ReadonlySet<PermissionAction> = new Set([
  'manage_users',
  'manage_company',
  'adjust_stock',
]);

export const PERMISSION_MATRIX: Readonly<Record<UserRole, ReadonlySet<PermissionAction>>> = {
  admin: new Set(PERMISSION_ACTIONS),
  manager: new Set(PERMISSION_ACTIONS.filter((a) => !MANAGER_DENIED.has(a))),
  seller: SELLER_ACTIONS,
};

/** ¿El rol `role` puede ejecutar `action`? */
export function hasPermission(role: UserRole, action: PermissionAction): boolean {
  return PERMISSION_MATRIX[role]?.has(action) ?? false;
}

/** Lanza `PermissionDeniedError` si el rol no tiene el permiso. */
export function requirePermission(
  user: { role: UserRole },
  action: PermissionAction,
): void {
  if (!hasPermission(user.role, action)) {
    throw new PermissionDeniedError(action, user.role);
  }
}
