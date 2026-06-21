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
 *  manage_payment_methods | ✓ |   ✓    |   ✗
 *  manage_purchases  |   ✓   |    ✓    |   ✗
 *  manage_supplier_accounts | ✓ | ✓   |   ✗
 *  void_sale         |   ✓   |    ✓    |   ✗
 *  close_cash        |   ✓   |    ✓    |   ✗(*)
 *  add_cash_movement |   ✓   |    ✓    |   ✗
 *  adjust_stock      |   ✓   |    ✗    |   ✗
 *  view_reports      |   ✓   |    ✓    |   ✗
 *  create_sale       |   ✓   |    ✓    |   ✓
 *  view_articles     |   ✓   |    ✓    |   ✓
 *  open_cash         |   ✓   |    ✓    |   ✓
 *  receive_payment   |   ✓   |    ✓    |   ✓
 *  manage_customers  |   ✓   |    ✓    |   ✓(*área clientes)
 *  manage_hardware   |   ✓   |    ✗    |   ✗
 *  manage_backup     |   ✓   |    ✗    |   ✗
 *  import_data       |   ✓   |    ✗    |   ✗
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
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/* ------------------------------------------------------------------ */
/* Áreas / funciones configurables por rol                            */
/* ------------------------------------------------------------------ */

/**
 * Agrupación de acciones por ÁREA funcional. La configuración por rol
 * (`role_area_access`) habilita/deshabilita áreas completas; el motor recompone
 * los permisos efectivos como la UNIÓN de las acciones de las áreas habilitadas.
 *
 * `admin` SIEMPRE tiene todas las acciones (no se lee config para admin).
 *
 * Acciones admin-only (no pertenecen a ninguna área, sólo admin las tiene):
 *   manage_users, manage_company, manage_hardware, manage_backup.
 */
export interface PermissionArea {
  key: string;
  label: string;
  actions: PermissionAction[];
}

export const PERMISSION_AREAS: readonly PermissionArea[] = [
  {
    key: 'articulos',
    label: 'Artículos / Stock',
    actions: [
      'view_articles',
      'manage_articles',
      'adjust_stock',
      'manage_prices',
      'import_data',
      'manage_families',
    ],
  },
  {
    key: 'proveedores',
    label: 'Proveedores',
    actions: ['manage_suppliers', 'manage_supplier_accounts'],
  },
  {
    key: 'clientes',
    label: 'Clientes / Cuentas corrientes',
    actions: ['receive_payment'],
  },
  {
    // Separada de `clientes` a propósito: el vendedor cobra cuentas (área
    // `clientes`) pero NO debería poder editar clientes / su límite de crédito.
    key: 'gestion_clientes',
    label: 'Gestión de clientes (alta/edición)',
    actions: ['manage_customers'],
  },
  {
    key: 'ventas',
    label: 'Ventas',
    actions: ['create_sale', 'void_sale', 'view_articles'],
  },
  {
    key: 'compras',
    label: 'Compras',
    actions: ['manage_purchases'],
  },
  {
    key: 'caja',
    label: 'Caja',
    actions: ['open_cash', 'close_cash', 'add_cash_movement', 'manage_cash_general'],
  },
  {
    key: 'reportes',
    label: 'Reportes / Estadísticas',
    actions: ['view_reports'],
  },
  {
    key: 'contabilidad',
    label: 'Contabilidad',
    actions: ['view_accounting'],
  },
  {
    key: 'medios_pago',
    label: 'Medios de pago',
    actions: ['manage_payment_methods', 'manage_cards', 'manage_mp_qr'],
  },
] as const;

/** Mapa rápido key -> área. */
const AREA_BY_KEY = new Map<string, PermissionArea>(
  PERMISSION_AREAS.map((a) => [a.key, a]),
);

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
  'manage_hardware',
  'manage_backup',
  'import_data',
]);

/**
 * Matriz DEFAULT (hardcodeada). Sirve de fallback cuando la config de áreas no
 * está cargada o está vacía. `effectiveMatrix` se inicializa a partir de ésta.
 */
export const PERMISSION_MATRIX: Readonly<Record<UserRole, ReadonlySet<PermissionAction>>> = {
  admin: new Set(PERMISSION_ACTIONS),
  manager: new Set(PERMISSION_ACTIONS.filter((a) => !MANAGER_DENIED.has(a))),
  seller: SELLER_ACTIONS,
};

/**
 * Estado MUTABLE de permisos efectivos. Inicializado = PERMISSION_MATRIX y
 * recalculado en caliente por `applyAreaConfig`.
 *
 * `admin` SIEMPRE es el set completo de acciones (inmutable, no se lee config).
 */
const effectiveMatrix: Record<UserRole, Set<PermissionAction>> = {
  admin: new Set(PERMISSION_MATRIX.admin),
  manager: new Set(PERMISSION_MATRIX.manager),
  seller: new Set(PERMISSION_MATRIX.seller),
};

/** Fila de configuración de acceso por área (espejo de `role_area_access`). */
export interface RoleAreaAccessRow {
  role: string;
  area: string;
  allowed: boolean;
}

/**
 * Recalcula los permisos efectivos de `manager` y `seller` a partir de las
 * áreas habilitadas en `rows`. `admin` queda intacto (siempre todas).
 *
 * Cada rol configurable pasa a tener la UNIÓN de las acciones de las áreas con
 * `allowed === true`. Las áreas ausentes o `allowed === false` quedan denegadas.
 */
export function applyAreaConfig(rows: readonly RoleAreaAccessRow[]): void {
  for (const role of ['manager', 'seller'] as const) {
    const next = new Set<PermissionAction>();
    for (const row of rows) {
      if (row.role !== role || !row.allowed) continue;
      const area = AREA_BY_KEY.get(row.area);
      if (!area) continue; // área desconocida: ignorar.
      for (const action of area.actions) next.add(action);
    }
    effectiveMatrix[role] = next;
  }
  // admin: invariante — siempre todas las acciones.
  effectiveMatrix.admin = new Set(PERMISSION_ACTIONS);
}

/** Restaura `effectiveMatrix` a la matriz DEFAULT (útil para tests). */
export function resetEffectiveMatrix(): void {
  effectiveMatrix.admin = new Set(PERMISSION_MATRIX.admin);
  effectiveMatrix.manager = new Set(PERMISSION_MATRIX.manager);
  effectiveMatrix.seller = new Set(PERMISSION_MATRIX.seller);
}

/** Permisos EFECTIVOS de un rol (admin = todos). Pensado para el UserDTO. */
export function effectivePermissionsFor(role: UserRole): PermissionAction[] {
  if (role === 'admin') return [...PERMISSION_ACTIONS];
  return Array.from(effectiveMatrix[role] ?? new Set<PermissionAction>());
}

/** ¿El rol `role` puede ejecutar `action`? (lee la config efectiva). */
export function hasPermission(role: UserRole, action: PermissionAction): boolean {
  return effectiveMatrix[role]?.has(action) ?? false;
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
