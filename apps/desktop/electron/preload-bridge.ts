/**
 * Bridge IPC desacoplado de Electron — testeable sin levantar la app.
 *
 * Construye el objeto `ApiSurface` enrutando cada canal a IPC local o a HTTP
 * según el modo LAN del proceso renderer.
 *
 * Reglas:
 *  - `mode === 'single' | 'server'` → todos los canales van por `ipcInvoke`.
 *  - `mode === 'client'` → los canales de grupos en `LAN_ROUTED_GROUPS` van por
 *    HTTP RPC hacia el servidor; los demás (system/lan/updater/hardware/license)
 *    siguen siendo locales.
 *  - `auth:login` ok devuelve `data._lanSessionToken` en modo client: se
 *    cachea y se reenvía como `Authorization: Bearer` en las siguientes
 *    requests. `auth:logout` y respuesta 401 limpian el cache.
 */
import type { ApiSurface, IpcResponse, LanConfigDTO, LoginResultDTO } from './ipc/types';

export type LanBridgeMode = 'single' | 'server' | 'client';

export interface LanClientConfig {
  serverIp: string;
  serverPort: number;
  token: string;
}

export interface BridgeListenerHandle {
  on(channel: string, listener: (payload: unknown) => void): void;
  off(channel: string, listener: (payload: unknown) => void): void;
}

export interface BridgeIO {
  invoke: (channel: string, payload?: unknown) => Promise<IpcResponse<unknown>>;
  listeners: BridgeListenerHandle;
  /** Inyección de fetch para tests; default es global fetch. */
  fetch?: typeof fetch;
  /** Inyección del timeout (ms); default 10s. */
  httpTimeoutMs?: number;
}

export const LAN_ROUTED_GROUPS = new Set([
  'articles',
  'customers',
  'suppliers',
  'families',
  'users',
  'company',
  'sales',
  'purchases',
  'cash',
  'inventory',
  'accounts',
  'supplierAccounts',
  'reports',
  'paymentMethods',
  'backup',
  'import',
  'auth',
]);

export const LOCAL_GROUPS = new Set(['system', 'lan', 'updater', 'hardware', 'license']);

interface LanState {
  sessionToken: string | null;
}

function getGroup(channel: string): string {
  const idx = channel.indexOf(':');
  return idx === -1 ? channel : channel.slice(0, idx);
}

export function shouldRouteLan(channel: string, mode: LanBridgeMode): boolean {
  if (mode !== 'client') return false;
  return LAN_ROUTED_GROUPS.has(getGroup(channel));
}

/**
 * Parsea `process.argv` buscando flags `--lan-mode=`, `--lan-server=IP:PORT`,
 * `--lan-token=PIN`. Devuelve `single` si no hay flags.
 */
export function parseLanArgs(argv: readonly string[]): { mode: LanBridgeMode; lanCfg?: LanClientConfig } {
  let mode: LanBridgeMode = 'single';
  let server: string | undefined;
  let token: string | undefined;
  for (const a of argv) {
    if (a.startsWith('--lan-mode=')) {
      const v = a.slice('--lan-mode='.length);
      if (v === 'client' || v === 'server' || v === 'single') mode = v;
    } else if (a.startsWith('--lan-server=')) {
      server = a.slice('--lan-server='.length);
    } else if (a.startsWith('--lan-token=')) {
      token = a.slice('--lan-token='.length);
    }
  }
  if (mode === 'client' && server && token) {
    const [ip, portStr] = server.split(':');
    const port = Number(portStr ?? '7777');
    return { mode, lanCfg: { serverIp: ip ?? '127.0.0.1', serverPort: Number.isFinite(port) ? port : 7777, token } };
  }
  return { mode };
}

/**
 * Crea la función "call" que enruta cada canal. Exportada para los tests del
 * bridge: usa `io.invoke` para IPC local y `io.fetch` para HTTP.
 */
export function createCaller(
  mode: LanBridgeMode,
  lanCfg: LanClientConfig | undefined,
  io: BridgeIO,
): (channel: string, payload?: unknown) => Promise<IpcResponse<unknown>> {
  const state: LanState = { sessionToken: null };
  const doFetch: typeof fetch = io.fetch ?? (globalThis.fetch as typeof fetch);
  const timeoutMs = io.httpTimeoutMs ?? 10_000;

  async function httpRpc(channel: string, payload: unknown): Promise<IpcResponse<unknown>> {
    if (!lanCfg) {
      return { ok: false, code: 'INTERNAL', message: 'Configuración LAN ausente' };
    }
    const url = `http://${lanCfg.serverIp}:${lanCfg.serverPort}/lan/rpc`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (state.sessionToken) headers['authorization'] = `Bearer ${state.sessionToken}`;
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel, payload, token: lanCfg.token }),
        signal: controller.signal,
      });
      let body: IpcResponse<unknown>;
      try {
        body = (await res.json()) as IpcResponse<unknown>;
      } catch {
        return { ok: false, code: 'INTERNAL', message: 'Respuesta inválida del servidor LAN' };
      }
      if (res.status === 401) {
        state.sessionToken = null;
        return body.ok
          ? { ok: false, code: 'UNAUTHENTICATED', message: 'Sesión expirada' }
          : body;
      }
      // Interceptar auth:login ok para guardar JWT y stripearlo del data
      if (channel === 'auth:login' && body.ok) {
        const data = body.data as LoginResultDTO & { _lanSessionToken?: string };
        if (typeof data._lanSessionToken === 'string') {
          state.sessionToken = data._lanSessionToken;
          const { _lanSessionToken: _drop, ...rest } = data;
          void _drop;
          return { ok: true, data: rest as LoginResultDTO };
        }
      }
      if (channel === 'auth:logout') {
        state.sessionToken = null;
      }
      return body;
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      return {
        ok: false,
        code: 'INTERNAL',
        message: aborted
          ? 'Sin conexión con el servidor de la caja principal (timeout)'
          : 'Sin conexión con el servidor de la caja principal',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return (channel: string, payload?: unknown): Promise<IpcResponse<unknown>> => {
    if (shouldRouteLan(channel, mode)) return httpRpc(channel, payload);
    return io.invoke(channel, payload);
  };
}

type CallFn = <T>(channel: string, payload?: unknown) => Promise<IpcResponse<T>>;

/**
 * Construye el `ApiSurface` que se expone vía `contextBridge`. Reusa exactamente
 * la misma estructura que la versión previa del preload — sólo cambia el
 * implementor por método según el modo.
 */
export function createApiBridge(
  mode: LanBridgeMode,
  lanCfg: LanClientConfig | undefined,
  io: BridgeIO,
): ApiSurface {
  const rawCall = createCaller(mode, lanCfg, io);
  const c: CallFn = <T,>(channel: string, payload?: unknown): Promise<IpcResponse<T>> =>
    rawCall(channel, payload) as Promise<IpcResponse<T>>;

  function on(channel: string, cb: (p: unknown) => void): () => void {
    const handler = (payload: unknown): void => cb(payload);
    io.listeners.on(channel, handler);
    return () => io.listeners.off(channel, handler);
  }

  return {
    auth: {
      login: (p) => c<LoginResultDTO>('auth:login', p),
      logout: () => c<{ loggedOut: true }>('auth:logout'),
      getCurrentUser: () => c<never>('auth:getCurrentUser'),
    },
    articles: {
      list: () => c<never>('articles:list'),
      get: (p) => c<never>('articles:get', p),
      create: (p) => c<never>('articles:create', p),
      update: (p) => c<never>('articles:update', p),
      delete: (p) => c<never>('articles:delete', p),
      findByBarcode: (p) => c<never>('articles:findByBarcode', p),
      searchByText: (p) => c<never>('articles:searchByText', p),
      findLowStock: () => c<never>('articles:findLowStock'),
      uploadImage: (p) => c<never>('articles:uploadImage', p),
      removeImage: (p) => c<never>('articles:removeImage', p),
      getImageDataUrl: (p) => c<never>('articles:getImageDataUrl', p),
    },
    customers: {
      list: () => c<never>('customers:list'),
      get: (p) => c<never>('customers:get', p),
      create: (p) => c<never>('customers:create', p),
      update: (p) => c<never>('customers:update', p),
      delete: (p) => c<never>('customers:delete', p),
      searchByText: (p) => c<never>('customers:searchByText', p),
      findByDocNumber: (p) => c<never>('customers:findByDocNumber', p),
    },
    suppliers: {
      list: () => c<never>('suppliers:list'),
      get: (p) => c<never>('suppliers:get', p),
      create: (p) => c<never>('suppliers:create', p),
      update: (p) => c<never>('suppliers:update', p),
      delete: (p) => c<never>('suppliers:delete', p),
    },
    families: {
      list: () => c<never>('families:list'),
      get: (p) => c<never>('families:get', p),
      create: (p) => c<never>('families:create', p),
      update: (p) => c<never>('families:update', p),
      delete: (p) => c<never>('families:delete', p),
    },
    paymentMethods: {
      list: () => c<never>('paymentMethods:list'),
      get: (p) => c<never>('paymentMethods:get', p),
      create: (p) => c<never>('paymentMethods:create', p),
      update: (p) => c<never>('paymentMethods:update', p),
      delete: (p) => c<never>('paymentMethods:delete', p),
    },
    users: {
      list: () => c<never>('users:list'),
      get: (p) => c<never>('users:get', p),
      create: (p) => c<never>('users:create', p),
      update: (p) => c<never>('users:update', p),
      delete: (p) => c<never>('users:delete', p),
    },
    company: {
      get: () => c<never>('company:get'),
      upsert: (p) => c<never>('company:upsert', p),
    },
    sales: {
      create: (p) => c<never>('sales:create', p),
      void: (p) => c<never>('sales:void', p),
      get: (p) => c<never>('sales:get', p),
      listByDateRange: (p) => c<never>('sales:listByDateRange', p),
      getNextNumber: (p) => c<never>('sales:getNextNumber', p),
    },
    purchases: {
      create: (p) => c<never>('purchases:create', p),
      void: (p) => c<never>('purchases:void', p),
      get: (p) => c<never>('purchases:get', p),
      listByDateRange: (p) => c<never>('purchases:listByDateRange', p),
      getNextNumber: (p) => c<never>('purchases:getNextNumber', p),
    },
    supplierAccounts: {
      listBalances: () => c<never>('supplierAccounts:listBalances'),
      payInvoice: (p) => c<never>('supplierAccounts:payInvoice', p),
      getStatement: (p) => c<never>('supplierAccounts:getStatement', p),
      listOpenBySupplier: (p) =>
        c<never>('supplierAccounts:listOpenBySupplier', p),
    },
    cash: {
      open: (p) => c<never>('cash:open', p),
      close: (p) => c<never>('cash:close', p),
      getCurrent: () => c<never>('cash:getCurrent'),
      getReport: (p) => c<never>('cash:getReport', p),
      addMovement: (p) => c<never>('cash:addMovement', p),
      listHistorical: (p) => c<never>('cash:listHistorical', p),
      getHistoricalReport: (p) => c<never>('cash:getHistoricalReport', p),
    },
    inventory: {
      checkStock: (p) => c<never>('inventory:checkStock', p),
      adjustStock: (p) => c<never>('inventory:adjustStock', p),
      getLowStockReport: () => c<never>('inventory:getLowStockReport'),
    },
    accounts: {
      receivePayment: (p) => c<never>('accounts:receivePayment', p),
      getStatement: (p) => c<never>('accounts:getStatement', p),
      getTotalReceivables: () => c<never>('accounts:getTotalReceivables'),
      listBalances: () => c<never>('accounts:listBalances'),
      listOpenByCustomer: (p) =>
        c<never>('accounts:listOpenByCustomer', p),
    },
    reports: {
      salesByDateRange: (p) => c<never>('reports:salesByDateRange', p),
      purchasesByDateRange: (p) =>
        c<never>('reports:purchasesByDateRange', p),
      salesBySeller: (p) => c<never>('reports:salesBySeller', p),
      inventoryByFamily: () => c<never>('reports:inventoryByFamily'),
      topArticles: (p) => c<never>('reports:topArticles', p),
      cashRegisterReport: (p) => c<never>('reports:cashRegisterReport', p),
    },
    system: {
      pickFile: (p) => c<never>('system:pickFile', p),
      pickImage: () => c<never>('system:pickImage'),
      getMachineId: () => c<never>('system:getMachineId'),
      getVersion: () => c<never>('system:getVersion'),
      getDbPath: () => c<never>('system:getDbPath'),
      getInfo: () => c<never>('system:getInfo'),
    },
    license: {
      getState: () => c<never>('license:getState'),
      activate: (p) => c<never>('license:activate', p),
      heartbeat: () => c<never>('license:heartbeat'),
    },
    hardware: {
      listUsbDevices: () => c<never>('hardware:printer:list-usb'),
      listSerialPorts: () => c<never>('hardware:printer:list-serial'),
      printer: {
        getConfig: () => c<never>('hardware:printer:get-config'),
        setConfig: (p) => c<never>('hardware:printer:set-config', p),
        test: () => c<never>('hardware:printer:test'),
        printSaleTicket: (p) =>
          c<never>('hardware:printer:print-sale-ticket', p),
        printCashClose: (p) =>
          c<never>('hardware:printer:print-cash-close', p),
      },
      cashDrawer: {
        open: () => c<never>('hardware:cash-drawer:open'),
      },
      scale: {
        getConfig: () => c<never>('hardware:scale:get-config'),
        setConfig: (p) => c<never>('hardware:scale:set-config', p),
        read: () => c<never>('hardware:scale:read'),
      },
      onScaleWeight: (cb) => on('hardware:scale:weight', (p) => cb(p as never)),
    },
    backup: {
      create: () => c<never>('backup:create'),
      list: () => c<never>('backup:list'),
      restore: (p) => c<never>('backup:restore', p),
      getConfig: () => c<never>('backup:get-config'),
      setConfig: (p) => c<never>('backup:set-config', p),
    },
    import: {
      parseFile: (p) => c<never>('import:parse-file', p),
      validate: (p) => c<never>('import:validate', p),
      execute: (p) => c<never>('import:execute', p),
      onProgress: (cb) => on('import:progress', (p) => cb(p as never)),
    },
    lan: {
      getConfig: () => c<LanConfigDTO>('lan:getConfig'),
      getLocalIp: () => c<never>('lan:getLocalIp'),
      setMode: (p) => c<never>('lan:setMode', p),
      testConnection: (p) => c<never>('lan:testConnection', p),
      scanNetwork: () => c<never>('lan:scanNetwork'),
      getConnectedClients: () => c<never>('lan:getConnectedClients'),
      applyAndRestart: () => c<never>('lan:applyAndRestart'),
    },
    updater: {
      checkNow: () => c<never>('updater:checkNow'),
      quitAndInstall: () => c<never>('updater:quitAndInstall'),
      getAutoCheck: () => c<never>('updater:getAutoCheck'),
      setAutoCheck: (p) => c<never>('updater:setAutoCheck', p),
      onAvailable: (cb) => on('updater:available', (p) => cb(p as never)),
      onDownloaded: (cb) => on('updater:downloaded', (p) => cb(p as never)),
    },
  };
}
