/**
 * AUDITORÍA IPC — envuelve todos los handlers de escritura y registra cada
 * operación exitosa en `audit_log` (quién, cuándo, qué).
 *
 * Reglas:
 *  - Sólo se auditan canales de ESCRITURA (verbos mutantes). Los de lectura
 *    (get/list/find/search/preview...) no generan ruido.
 *  - La inserción del registro NUNCA hace fallar la operación original.
 *  - Cubre desktop y modo LAN (el server LAN usa el mismo buildAllHandlers).
 */
import type { HandlerDeps, HandlerFn } from './handler-context';

/** Verbos de método que marcan una operación de escritura auditable. */
const MUTATING_VERBS =
  /^(create|update|delete|void|add|receive|pay|transfer|open|close|apply|rollback|convert|import|adjust|activate|deactivate|toggle|restore|change|set(?!tings)|register|send|reset)/i;

/** Canales que, aunque matcheen un verbo, NO se auditan (ruido de UI/hardware). */
const IGNORED_CHANNELS = new Set([
  'auth:logout',
  'assistant:send',
  'whatsapp:send',
  'whatsapp:open',
  'print:setConfig',
  'hardware:openDrawer',
  'updater:setAutoCheck',
]);

/** Prefijos de grupo que nunca se auditan (ventanas, sistema, impresión). */
const IGNORED_GROUPS = new Set([
  'windows', 'desktopWindow', 'system', 'print', 'hardware', 'assistant',
  'whatsapp', 'updater', 'lan', 'search', 'audit', 'analytics', 'reports', 'accounting',
]);

const AREA_BY_GROUP: Record<string, string> = {
  auth: 'Sesión',
  sales: 'Ventas',
  returns: 'Devoluciones',
  quotes: 'Presupuestos',
  purchases: 'Compras',
  articles: 'Artículos',
  inventory: 'Artículos',
  customers: 'Clientes',
  suppliers: 'Proveedores',
  families: 'Artículos',
  promotions: 'Promociones',
  cash: 'Caja',
  cashGeneral: 'Caja General',
  accounts: 'Cuentas Corrientes',
  supplierAccounts: 'CC Proveedores',
  paymentMethods: 'Configuración',
  priceUpdates: 'Precios',
  users: 'Usuarios',
  company: 'Configuración',
  license: 'Licencia',
  backup: 'Backup',
  import: 'Importación',
  mpQr: 'MercadoPago',
  accounting: 'Contabilidad',
};

type Describe = (payload: unknown, result: unknown) => string;
const g = (o: unknown, k: string): unknown => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
const s = (v: unknown): string => (v == null ? '' : String(v));

/** Descripciones en español para los canales más importantes. */
const DESCRIBE: Record<string, Describe> = {
  'auth:login': (_p, r) => `Inicio de sesión de ${s(g(g(r, 'user'), 'fullName') || g(g(r, 'user'), 'username'))}`,
  'sales:create': (_p, r) => {
    const sale = g(r, 'sale');
    return `Venta ${s(g(sale, 'type'))} #${s(g(sale, 'number'))} por $${s(g(sale, 'total'))}`;
  },
  'sales:void': (_p, r) => `Anulación de venta ${s(g(r, 'type'))} #${s(g(r, 'number'))} por $${s(g(r, 'total'))}`,
  'returns:createForSale': (_p, r) => {
    const ret = g(r, 'ret');
    return `Devolución de venta DEV #${s(g(ret, 'number'))} por $${s(g(ret, 'total'))} (${s(g(ret, 'refundMethod')) === 'cash' ? 'efectivo' : 'crédito en cuenta'})`;
  },
  'returns:createForPurchase': (_p, r) => {
    const ret = g(r, 'ret');
    return `Devolución a proveedor DPC #${s(g(ret, 'number'))} por $${s(g(ret, 'total'))}`;
  },
  'purchases:create': (p, r) => {
    const purchase = g(r, 'purchase');
    const type = s(g(purchase, 'type') || g(p, 'type'));
    const origen = s(g(p, 'fundingSource')) === 'general' ? ' (desde Caja General)' : '';
    return `Compra ${type} #${s(g(purchase, 'number'))} por $${s(g(purchase, 'total'))}${origen}`;
  },
  'purchases:void': (_p, r) => `Anulación de compra ${s(g(r, 'type'))} #${s(g(r, 'number'))}`,
  'quotes:create': (_p, r) => {
    const q = g(r, 'quote') ?? r;
    return `Presupuesto P-${s(g(q, 'number')).padStart(4, '0')} por $${s(g(q, 'total'))}`;
  },
  'quotes:convertToSale': (_p, r) => {
    const sale = g(r, 'sale');
    return `Presupuesto convertido en venta #${s(g(sale, 'number'))} por $${s(g(sale, 'total'))}`;
  },
  'quotes:delete': (p) => `Presupuesto eliminado (${s(g(p, 'id'))})`,
  'articles:create': (_p, r) => `Artículo creado: ${s(g(r, 'code'))} — ${s(g(r, 'description'))}`,
  'articles:update': (_p, r) => `Artículo modificado: ${s(g(r, 'code'))} — ${s(g(r, 'description'))}`,
  'articles:delete': (p) => `Artículo eliminado (${s(g(p, 'id'))})`,
  'customers:create': (_p, r) => `Cliente creado: ${s(g(r, 'lastName'))} ${s(g(r, 'firstName') ?? '')}`.trim(),
  'customers:update': (_p, r) => `Cliente modificado: ${s(g(r, 'lastName'))} ${s(g(r, 'firstName') ?? '')}`.trim(),
  'customers:delete': (p) => `Cliente eliminado (${s(g(p, 'id'))})`,
  'suppliers:create': (_p, r) => `Proveedor creado: ${s(g(r, 'name'))}`,
  'suppliers:update': (_p, r) => `Proveedor modificado: ${s(g(r, 'name'))}`,
  'suppliers:delete': (p) => `Proveedor eliminado (${s(g(p, 'id'))})`,
  'promotions:create': (_p, r) => `Promoción creada: ${s(g(g(r, 'promotion'), 'name') ?? g(r, 'name'))}`,
  'promotions:update': (_p, r) => `Promoción modificada: ${s(g(g(r, 'promotion'), 'name') ?? g(r, 'name'))}`,
  'promotions:delete': (p) => `Promoción eliminada (${s(g(p, 'id'))})`,
  'cash:open': (_p, r) => `Apertura de caja #${s(g(r, 'number'))} con $${s(g(r, 'openingAmount'))}`,
  'cash:close': (_p, r) => {
    const reg = g(r, 'register');
    return `Cierre de caja #${s(g(reg, 'number'))} — contado $${s(g(reg, 'closingAmount'))}, diferencia $${s(g(g(r, 'report'), 'difference'))}`;
  },
  'cash:addMovement': (p) =>
    `Movimiento de caja: ${s(g(p, 'type')) === 'income' ? 'ingreso' : 'egreso'} $${s(g(p, 'amount'))} — ${s(g(p, 'description'))}`,
  'cashGeneral:addIncome': (p) => `Caja General: ingreso $${s(g(p, 'amount'))} — ${s(g(p, 'description'))}`,
  'cashGeneral:addExpense': (p) => `Caja General: egreso $${s(g(p, 'amount'))} — ${s(g(p, 'description'))}`,
  'cashGeneral:transferFromDaily': (p) => `Caja General: transferencia desde caja diaria $${s(g(p, 'amount'))}`,
  'cashGeneral:transferFromClosed': (p) => `Caja General: depósito de cierre $${s(g(p, 'amount'))}`,
  'accounts:receivePayment': (_p, r) => `Cobranza en cuenta corriente por $${s(g(r, 'totalApplied') ?? g(r, 'amount'))}`,
  'accounts:receivePaymentToCustomer': (_p, r) => `Cobranza a la cuenta del cliente por $${s(g(r, 'totalApplied'))}`,
  'supplierAccounts:payInvoice': (_p, r) => `Pago a proveedor por $${s(g(r, 'totalApplied') ?? g(r, 'amount'))}`,
  'supplierAccounts:payToSupplier': (_p, r) => `Pago a la cuenta del proveedor por $${s(g(r, 'totalApplied'))}`,
  'priceUpdates:apply': (_p, r) => `Actualización masiva de precios (${s(g(r, 'updatedCount') ?? g(r, 'count'))} artículos)`,
  'priceUpdates:rollback': (p) => `Reversión de lote de precios (${s(g(p, 'batchId'))})`,
  'inventory:adjustStock': (p) => `Ajuste de stock: artículo ${s(g(p, 'articleId'))} → ${s(g(p, 'newStock') ?? g(p, 'quantity'))}`,
  'users:create': (_p, r) => `Usuario creado: ${s(g(r, 'username'))} (${s(g(r, 'role'))})`,
  'users:update': (_p, r) => `Usuario modificado: ${s(g(r, 'username'))}`,
  'company:update': () => 'Datos de la empresa modificados',
  'backup:restore': () => 'Backup RESTAURADO',
  'backup:create': () => 'Backup manual creado',
};

function fallbackDescription(channel: string): string {
  return `Operación ${channel}`;
}

export function isAuditable(channel: string): boolean {
  const [group, method] = channel.split(':');
  if (!group || !method) return false;
  if (IGNORED_GROUPS.has(group)) return false;
  if (IGNORED_CHANNELS.has(channel)) return false;
  if (channel === 'auth:login') return true;
  return MUTATING_VERBS.test(method);
}

/** Envuelve un handler auditable: registra en audit_log tras el éxito. */
export function withAudit(channel: string, handler: HandlerFn, deps: HandlerDeps): HandlerFn {
  const group = channel.split(':')[0]!;
  const area = AREA_BY_GROUP[group] ?? group;
  const describe = DESCRIBE[channel];
  return async (payload, event) => {
    const res = await handler(payload, event);
    if (res.ok) {
      try {
        const session = deps.sessionStore.getSession();
        const user = session?.user ?? (channel === 'auth:login' ? (res.data as { user?: { id: string; fullName?: string; username?: string } })?.user : null);
        deps.repos.audit.insert({
          userId: user?.id ?? null,
          username: (user && ('fullName' in user ? user.fullName : undefined)) || user?.username || '—',
          channel,
          area,
          description: describe ? describe(payload, res.data) : fallbackDescription(channel),
        });
      } catch {
        // la auditoría nunca rompe la operación original
      }
    }
    return res;
  };
}
