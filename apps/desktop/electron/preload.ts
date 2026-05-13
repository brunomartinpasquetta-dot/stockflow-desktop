/**
 * Bridge tipado entre el renderer y el proceso main (contextBridge).
 * Cada método reenvía a `ipcRenderer.invoke(<canal>, payload)` y devuelve la
 * respuesta uniforme `{ ok: true, data } | { ok: false, code, ... }`.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type { ApiSurface, IpcResponse } from './ipc/types';

function call<T>(channel: string, payload?: unknown): Promise<IpcResponse<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<T>>;
}

const api: ApiSurface = {
  auth: {
    login: (p) => call('auth:login', p),
    logout: () => call('auth:logout'),
    getCurrentUser: () => call('auth:getCurrentUser'),
  },
  articles: {
    list: () => call('articles:list'),
    get: (p) => call('articles:get', p),
    create: (p) => call('articles:create', p),
    update: (p) => call('articles:update', p),
    delete: (p) => call('articles:delete', p),
    findByBarcode: (p) => call('articles:findByBarcode', p),
    searchByText: (p) => call('articles:searchByText', p),
    findLowStock: () => call('articles:findLowStock'),
  },
  customers: {
    list: () => call('customers:list'),
    get: (p) => call('customers:get', p),
    create: (p) => call('customers:create', p),
    update: (p) => call('customers:update', p),
    delete: (p) => call('customers:delete', p),
    searchByText: (p) => call('customers:searchByText', p),
    findByDocNumber: (p) => call('customers:findByDocNumber', p),
  },
  suppliers: {
    list: () => call('suppliers:list'),
    get: (p) => call('suppliers:get', p),
    create: (p) => call('suppliers:create', p),
    update: (p) => call('suppliers:update', p),
    delete: (p) => call('suppliers:delete', p),
  },
  families: {
    list: () => call('families:list'),
    get: (p) => call('families:get', p),
    create: (p) => call('families:create', p),
    update: (p) => call('families:update', p),
    delete: (p) => call('families:delete', p),
  },
  paymentMethods: {
    list: () => call('paymentMethods:list'),
    get: (p) => call('paymentMethods:get', p),
    create: (p) => call('paymentMethods:create', p),
    update: (p) => call('paymentMethods:update', p),
    delete: (p) => call('paymentMethods:delete', p),
  },
  users: {
    list: () => call('users:list'),
    get: (p) => call('users:get', p),
    create: (p) => call('users:create', p),
    update: (p) => call('users:update', p),
    delete: (p) => call('users:delete', p),
  },
  company: {
    get: () => call('company:get'),
    upsert: (p) => call('company:upsert', p),
  },
  sales: {
    create: (p) => call('sales:create', p),
    void: (p) => call('sales:void', p),
    get: (p) => call('sales:get', p),
    listByDateRange: (p) => call('sales:listByDateRange', p),
    getNextNumber: (p) => call('sales:getNextNumber', p),
  },
  purchases: {
    create: (p) => call('purchases:create', p),
    void: (p) => call('purchases:void', p),
    get: (p) => call('purchases:get', p),
    listByDateRange: (p) => call('purchases:listByDateRange', p),
    getNextNumber: (p) => call('purchases:getNextNumber', p),
  },
  supplierAccounts: {
    listBalances: () => call('supplierAccounts:listBalances'),
    payInvoice: (p) => call('supplierAccounts:payInvoice', p),
    getStatement: (p) => call('supplierAccounts:getStatement', p),
    listOpenBySupplier: (p) => call('supplierAccounts:listOpenBySupplier', p),
  },
  cash: {
    open: (p) => call('cash:open', p),
    close: (p) => call('cash:close', p),
    getCurrent: () => call('cash:getCurrent'),
    getReport: (p) => call('cash:getReport', p),
    addMovement: (p) => call('cash:addMovement', p),
  },
  inventory: {
    checkStock: (p) => call('inventory:checkStock', p),
    adjustStock: (p) => call('inventory:adjustStock', p),
    getLowStockReport: () => call('inventory:getLowStockReport'),
  },
  accounts: {
    receivePayment: (p) => call('accounts:receivePayment', p),
    getStatement: (p) => call('accounts:getStatement', p),
    getTotalReceivables: () => call('accounts:getTotalReceivables'),
    listBalances: () => call('accounts:listBalances'),
    listOpenByCustomer: (p) => call('accounts:listOpenByCustomer', p),
  },
  reports: {
    salesByDateRange: (p) => call('reports:salesByDateRange', p),
    purchasesByDateRange: (p) => call('reports:purchasesByDateRange', p),
    salesBySeller: (p) => call('reports:salesBySeller', p),
    inventoryByFamily: () => call('reports:inventoryByFamily'),
    topArticles: (p) => call('reports:topArticles', p),
    cashRegisterReport: (p) => call('reports:cashRegisterReport', p),
  },
  system: {
    pickFile: (p) => call('system:pickFile', p),
    getMachineId: () => call('system:getMachineId'),
    getVersion: () => call('system:getVersion'),
    getDbPath: () => call('system:getDbPath'),
    getInfo: () => call('system:getInfo'),
  },
  license: {
    getState: () => call('license:getState'),
    activate: (p) => call('license:activate', p),
    heartbeat: () => call('license:heartbeat'),
  },
  hardware: {
    listUsbDevices: () => call('hardware:printer:list-usb'),
    listSerialPorts: () => call('hardware:printer:list-serial'),
    printer: {
      getConfig: () => call('hardware:printer:get-config'),
      setConfig: (p) => call('hardware:printer:set-config', p),
      test: () => call('hardware:printer:test'),
      printSaleTicket: (p) => call('hardware:printer:print-sale-ticket', p),
      printCashClose: (p) => call('hardware:printer:print-cash-close', p),
    },
    cashDrawer: {
      open: () => call('hardware:cash-drawer:open'),
    },
    scale: {
      getConfig: () => call('hardware:scale:get-config'),
      setConfig: (p) => call('hardware:scale:set-config', p),
      read: () => call('hardware:scale:read'),
    },
    onScaleWeight: (cb) => {
      const listener = (_event: unknown, payload: unknown): void => cb(payload as never);
      ipcRenderer.on('hardware:scale:weight', listener);
      return () => ipcRenderer.removeListener('hardware:scale:weight', listener);
    },
  },
  backup: {
    create: () => call('backup:create'),
    list: () => call('backup:list'),
    restore: (p) => call('backup:restore', p),
    getConfig: () => call('backup:get-config'),
    setConfig: (p) => call('backup:set-config', p),
  },
  import: {
    parseFile: (p) => call('import:parse-file', p),
    validate: (p) => call('import:validate', p),
    execute: (p) => call('import:execute', p),
    onProgress: (cb) => {
      const listener = (_event: unknown, payload: unknown): void => cb(payload as never);
      ipcRenderer.on('import:progress', listener);
      return () => ipcRenderer.removeListener('import:progress', listener);
    },
  },
  lan: {
    getConfig: () => call('lan:getConfig'),
    getLocalIp: () => call('lan:getLocalIp'),
    setMode: (p) => call('lan:setMode', p),
  },
  updater: {
    checkNow: () => call('updater:checkNow'),
    quitAndInstall: () => call('updater:quitAndInstall'),
    getAutoCheck: () => call('updater:getAutoCheck'),
    setAutoCheck: (p) => call('updater:setAutoCheck', p),
    onAvailable: (cb) => {
      const listener = (_event: unknown, payload: unknown): void => cb(payload as never);
      ipcRenderer.on('updater:available', listener);
      return () => ipcRenderer.removeListener('updater:available', listener);
    },
    onDownloaded: (cb) => {
      const listener = (_event: unknown, payload: unknown): void => cb(payload as never);
      ipcRenderer.on('updater:downloaded', listener);
      return () => ipcRenderer.removeListener('updater:downloaded', listener);
    },
  },
};

contextBridge.exposeInMainWorld('stockflow', api);
