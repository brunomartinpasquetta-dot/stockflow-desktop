/**
 * Registro de handlers IPC.
 *  - `buildAllHandlers(deps)`: arma el mapa `canal -> handler` (sin tocar Electron;
 *    usado también por los tests de integración).
 *  - `registerIpcHandlers(ipcMain, deps)`: registra cada handler en `ipcMain.handle`
 *    (recibe `ipcMain` por inyección para no acoplar este módulo a Electron).
 */
import type { IpcMain } from 'electron';

import { buildAccountsHandlers } from './handlers/accounts.handlers';
import { buildArticlesHandlers } from './handlers/articles.handlers';
import { buildAuthHandlers } from './handlers/auth.handlers';
import { buildCashHandlers } from './handlers/cash.handlers';
import { buildCompanyHandlers } from './handlers/company.handlers';
import { buildCustomersHandlers } from './handlers/customers.handlers';
import { buildFamiliesHandlers } from './handlers/families.handlers';
import { buildInventoryHandlers } from './handlers/inventory.handlers';
import { buildPaymentMethodsHandlers } from './handlers/paymentMethods.handlers';
import { buildPurchasesHandlers } from './handlers/purchases.handlers';
import { buildReportsHandlers } from './handlers/reports.handlers';
import { buildSalesHandlers } from './handlers/sales.handlers';
import { buildSupplierAccountsHandlers } from './handlers/supplierAccounts.handlers';
import { buildSuppliersHandlers } from './handlers/suppliers.handlers';
import { buildSystemHandlers } from './handlers/system.handlers';
import { buildUsersHandlers } from './handlers/users.handlers';
import type { HandlerBuilder, HandlerDeps, HandlerMap } from './handler-context';

const BUILDERS: HandlerBuilder[] = [
  buildAuthHandlers,
  buildArticlesHandlers,
  buildCustomersHandlers,
  buildSuppliersHandlers,
  buildFamiliesHandlers,
  buildPaymentMethodsHandlers,
  buildUsersHandlers,
  buildCompanyHandlers,
  buildSalesHandlers,
  buildPurchasesHandlers,
  buildSupplierAccountsHandlers,
  buildCashHandlers,
  buildInventoryHandlers,
  buildAccountsHandlers,
  buildReportsHandlers,
  buildSystemHandlers,
];

export function buildAllHandlers(deps: HandlerDeps): HandlerMap {
  const map: HandlerMap = {};
  for (const build of BUILDERS) {
    for (const [channel, handler] of Object.entries(build(deps))) {
      if (channel in map) {
        throw new Error(`Canal IPC duplicado: ${channel}`);
      }
      map[channel] = handler;
    }
  }
  return map;
}

export function registerIpcHandlers(ipcMain: IpcMain, deps: HandlerDeps): string[] {
  const handlers = buildAllHandlers(deps);
  const channels = Object.keys(handlers);
  for (const channel of channels) {
    const handler = handlers[channel]!;
    ipcMain.handle(channel, (_event, payload: unknown) => handler(payload));
  }
  return channels;
}
