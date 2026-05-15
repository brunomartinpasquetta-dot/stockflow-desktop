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
import { buildBackupHandlers } from './handlers/backup.handlers';
import { buildCashHandlers } from './handlers/cash.handlers';
import { buildCashGeneralHandlers } from './handlers/cashGeneral.handlers';
import { buildAnalyticsHandlers } from './handlers/analytics.handlers';
import { buildHardwareHandlers } from './handlers/hardware.handlers';
import { buildImportHandlers } from './handlers/import.handlers';
import { buildCompanyHandlers } from './handlers/company.handlers';
import { buildCustomersHandlers } from './handlers/customers.handlers';
import { buildFamiliesHandlers } from './handlers/families.handlers';
import { buildInventoryHandlers } from './handlers/inventory.handlers';
import { buildLanHandlers } from './handlers/lan.handlers';
import { buildMpQrHandlers } from './handlers/mpQr.handlers';
import { buildAccountingHandlers } from './handlers/accounting.handlers';
import { buildLicenseHandlers } from './handlers/license.handlers';
import { buildPaymentMethodsHandlers } from './handlers/paymentMethods.handlers';
import { buildPriceUpdateHandlers } from './handlers/priceUpdate.handlers';
import { buildUpdaterHandlers } from './handlers/updater.handlers';
import { buildPurchasesHandlers } from './handlers/purchases.handlers';
import { buildReportsHandlers } from './handlers/reports.handlers';
import { buildSalesHandlers } from './handlers/sales.handlers';
import { buildSearchHandlers } from './handlers/search.handlers';
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
  buildCashGeneralHandlers,
  buildAnalyticsHandlers,
  buildInventoryHandlers,
  buildPriceUpdateHandlers,
  buildAccountsHandlers,
  buildReportsHandlers,
  buildSearchHandlers,
  buildSystemHandlers,
  buildLicenseHandlers,
  buildHardwareHandlers,
  buildBackupHandlers,
  buildImportHandlers,
  buildLanHandlers,
  buildUpdaterHandlers,
  buildMpQrHandlers,
  buildAccountingHandlers,
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
