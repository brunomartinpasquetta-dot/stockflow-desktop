/**
 * @stockflow/core — capa de servicios de dominio.
 *
 * Arquitectura en capas:
 *   Repos (@stockflow/db, datos)  →  Services (@stockflow/core, negocio)  →  IPC (Electron, P05)  →  UI
 *
 * Punto de entrada:
 *  - context        : ServiceContext + createServiceContext (Dependency Injection).
 *  - services        : AuthService, SalesService, PurchasesService, CashService,
 *                      InventoryService, AccountsReceivableService, ReportsService
 *                      + createServices(ctx).
 *  - auth/permissions: matriz de permisos por rol, hasPermission/requirePermission.
 *  - auth/token      : token de sesión local (HS256).
 *  - pricing         : resolvePrice, applyDiscount, calculateVAT, calculateSaleTotals (puros).
 *  - errors          : PermissionDeniedError, BusinessRuleError + re-export de los de @stockflow/db.
 */
export * from './context';
export * from './errors';
export * from './services';
export * from './pricing';
export {
  PERMISSION_ACTIONS,
  PERMISSION_MATRIX,
  type PermissionAction,
  hasPermission,
  requirePermission,
} from './auth/permissions';
export {
  type SessionPayload,
  signSession,
  verifySession,
} from './auth/token';
