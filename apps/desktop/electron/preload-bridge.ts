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
import type {
  ApiSurface,
  AssistantAskResultDTO,
  AssistantSeguirResultDTO,
  EstadoIADTO,
  EstadoInstalacionOllamaDTO,
  EstadoFacturasDTO,
  FacturaEscaneadaDetalleDTO,
  FacturaEscaneadaResumenDTO,
  FacturasSeguimientoDTO,
  FacturasVincularDTO,
  DemoStatusDTO,
  CatalogoEstadisticasDTO,
  CatalogoSyncEstadoDTO,
  CatalogoSugerenciaVinculacionDTO,
  CatalogoVincularLoteResultadoDTO,
  CatalogoPlanCargaTotalDTO,
  CatalogoResultadoCargaTotalDTO,
  PedidoWebDTO,
  CatalogoSyncResultadoDTO,
  GuiaEstadoDTO,
  NovedadesPendientesDTO,
  OnboardingStatusDTO,
  DesktopWindowInfoDTO,
  DesktopWindowOpenDTO,
  IpcResponse,
  LanConfigDTO,
  LoginResultDTO,
  RolesConfigDTO,
} from './ipc/types';

export type LanBridgeMode = 'single' | 'server' | 'client';

export interface LanClientConfig {
  serverIp: string;
  serverPort: number;
  token: string;
  /**
   * Dirección COMPLETA del servidor cuando no se puede armar como
   * `http://ip:puerto`: la terminal por navegador la toma de la página que el
   * propio servidor le sirvió (`window.location.origin`). Hace falta para el
   * acceso remoto: entrando por `https://…` sin puerto, armar la URL a mano
   * daba `http://<host>:7777` y el navegador bloqueaba todo por contenido
   * mixto. En la red local sigue sin usarse.
   */
  serverBaseUrl?: string;
  /**
   * App instalada conectada por dirección web (PC de sucursal): los errores
   * hablan de "la casa central" (es como la pantalla la llama). Las terminales
   * de red local y las de navegador siguen con los mensajes de siempre.
   */
  esSucursal?: boolean;
}

/** La PC de sucursal no llega a la casa central (Cloudflare 502/530 o respuesta que no es de StockFlow). */
export const MENSAJE_CENTRAL_NO_RESPONDE =
  'La casa central no responde: la PC puede estar apagada, con StockFlow cerrado o sin internet. Avise a la casa central y vuelva a intentar.';
/** La PC de sucursal no tiene conexión (error de red o se agotó la espera). */
export const MENSAJE_SIN_CONEXION_CENTRAL =
  'Sin conexión con la casa central. Revise que esta PC tenga internet y vuelva a intentar.';

/** Base contra la que se arman las llamadas al servidor. */
export function baseDelServidor(cfg: LanClientConfig): string {
  return (cfg.serverBaseUrl ?? `http://${cfg.serverIp}:${cfg.serverPort}`).replace(/\/$/, '');
}

/* ------------------------------------------------------------------------ */
/* Terminal por dirección web (multisucursal)                               */
/* ------------------------------------------------------------------------ */

/**
 * ¿Ese nombre de host es de la red local? Es la única situación en la que se
 * acepta `http://` sin cifrar: por internet viajarían en claro la contraseña,
 * la sesión y el token de la PC. Mismos rangos que `isLanRemote` del servidor
 * (privadas, link-local, CGNAT de routers 4G/Tailscale, loopback, `.local`).
 *
 * Los rangos IPv6 (fc00::/7 y fe80::/10) se miran SÓLO en direcciones IPv6
 * escritas como tales (llevan ':'). Antes se miraba si el texto empezaba con
 * "fc"/"fd", y un NOMBRE como `fcia-del-centro.mistockflow.com` contaba como
 * red local: la PC de sucursal se conectaba por http:// sin cifrar a través
 * de internet.
 */
export function esHostDeRedLocal(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (!h.includes(':')) return false;
  // Primer grupo de 4 dígitos: fc00–fdff (ULA) o fe80–febf (link-local).
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/**
 * Normaliza la dirección que el usuario pega para conectar una terminal:
 * `https://comercio.mistockflow.com`, `comercio.mistockflow.com` (se asume
 * https), `192.168.1.10:7777` o `http://192.168.1.10:7777` (red local).
 * Devuelve sólo el ORIGEN (esquema + host + puerto), sin barra final, o un
 * mensaje de error para mostrar tal cual.
 */
export function normalizarUrlServidor(entrada: string): { ok: true; url: string } | { ok: false; error: string } {
  const texto = (entrada ?? '').trim();
  if (!texto) return { ok: false, error: 'Ingrese la dirección del servidor' };
  if (texto.length > 300) return { ok: false, error: 'La dirección es demasiado larga' };
  let conEsquema = texto;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(texto)) {
    // Sin esquema: una IP (con o sin puerto) es la red local; un nombre, internet.
    const host = texto.split(/[/:]/)[0] ?? '';
    conEsquema = `${esHostDeRedLocal(host) ? 'http' : 'https'}://${texto}`;
  }
  let u: URL;
  try {
    u = new URL(conEsquema);
  } catch {
    return { ok: false, error: 'La dirección no es válida' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'La dirección debe empezar con https://' };
  }
  if (u.username || u.password) return { ok: false, error: 'La dirección no puede llevar usuario ni contraseña' };
  if (!u.hostname) return { ok: false, error: 'La dirección no es válida' };
  if (u.protocol === 'http:' && !esHostDeRedLocal(u.hostname)) {
    return {
      ok: false,
      error: 'Por internet la dirección debe ser segura (https://). http:// sólo se admite dentro de la red del local.',
    };
  }
  return { ok: true, url: u.origin };
}

/* ------------------------------------------------------------------------ */
/* Identidad de la terminal                                                 */
/* ------------------------------------------------------------------------ */

/** Encabezados con que cada pedido dice desde qué PC sale. */
export const HDR_TERMINAL = 'x-stockflow-terminal';
export const HDR_TERMINAL_NOMBRE = 'x-stockflow-terminal-nombre';
/** Token de la PC de sucursal emparejada (ver electron/lan/dispositivos.ts). */
export const HDR_DISPOSITIVO = 'x-stockflow-dispositivo';

export interface IdentidadTerminal {
  /** machineId de la PC (hash SHA-256 estable) o, en el navegador, un id propio de esa PC. */
  terminalId: string;
  /** Nombre de la PC (hostname) para mostrar en el servidor. */
  terminalNombre: string;
  /** Token de dispositivo si la PC fue emparejada como sucursal. */
  dispositivoToken?: string | null;
  /**
   * PC de sucursal: ¿se comprobó que en la dirección guardada está SU casa
   * central? (ver conexion-central.ts → `verificarCentral`). `rechazada` = no
   * se manda NADA a esa dirección (ni el token ni una contraseña) y el pedido
   * vuelve con `motivoCentral`. Ausente = no aplica (red local, navegador) o
   * el main es de una versión que no lo hace.
   */
  central?: 'verificada' | 'rechazada';
  motivoCentral?: string;
}

/* ------------------------------------------------------------------------ */
/* Tiempos de espera por canal                                              */
/* ------------------------------------------------------------------------ */

/** Tiempo de espera común de un pedido al servidor. */
export const TIMEOUT_RPC_MS = 10_000;
/**
 * Pedidos que esperan a ARCA del lado del servidor: el web service tarda 20 a
 * 30 s en un día malo. Con 10 s la terminal daba "sin conexión" mientras la
 * factura se emitía igual en el servidor, y el cajero la reintentaba.
 */
export const TIMEOUT_RPC_LARGO_MS = 45_000;

/** ¿Este pedido puede quedar esperando a ARCA en el servidor? */
export function esPedidoLargo(channel: string, payload?: unknown): boolean {
  if (channel.startsWith('fiscal:')) return true;
  if (channel === 'sales:create') {
    const tipo = (payload as { type?: unknown } | null | undefined)?.type;
    return tipo === 'A' || tipo === 'B' || tipo === 'C';
  }
  return false;
}

/** Tiempo de espera de un pedido según el canal (nunca menos que el común). */
export function timeoutDeCanal(channel: string, payload: unknown, baseMs: number, largoMs = TIMEOUT_RPC_LARGO_MS): number {
  return esPedidoLargo(channel, payload) ? Math.max(baseMs, largoMs) : baseMs;
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
  /** Timeout de los pedidos que esperan a ARCA (ms); default 45 s. */
  httpTimeoutLargoMs?: number;
  /**
   * Quién es esta PC. Se pide en la primera llamada al servidor, se recuerda
   * `revisarCentralMs` y viaja en cada pedido, por la red local y por el
   * túnel. Antes de iniciar sesión se pide con `verificarCentral: true`: la PC
   * de sucursal vuelve a comprobar a su casa central antes de mandar la
   * contraseña. Ausente o null = no se mandan los encabezados (el servidor
   * trata la llamada como hoy).
   */
  identidad?: (
    opciones?: { verificarCentral?: boolean },
  ) => IdentidadTerminal | null | Promise<IdentidadTerminal | null>;
  /** Cada cuánto se vuelve a pedir la identidad (y a comprobar a la central). Default 5 min; tests. */
  revisarCentralMs?: number;
  /**
   * Antes de mandar los encabezados de identidad, preguntar al servidor si los
   * admite (`GET /lan/ping`, un pedido simple que no dispara la consulta previa
   * de CORS; los servidores nuevos contestan `identidad: true`).
   *
   * Lo usa la terminal INSTALADA: habla desde file:// (otro origen), así que
   * cada pedido con encabezados propios pasa por la consulta previa, y un
   * servidor de la 1.12 sólo admite `content-type,authorization`: Chromium
   * bloquearía TODOS los pedidos y la terminal actualizada antes que el
   * servidor quedaría sin poder iniciar sesión ni vender. El navegador servido
   * por el propio servidor (mismo origen) no lo necesita.
   */
  sondearIdentidad?: boolean;
  /** Cada cuánto se vuelve a preguntar si el servidor dijo que NO (default 60 s; tests). */
  revisarIdentidadMs?: number;
  /**
   * Guardado del token de sesión. En Electron alcanza con tenerlo en memoria
   * porque todas las ventanas comparten el proceso; en el navegador cada
   * pestaña es un mundo aparte, así que hay que persistirlo o cada módulo
   * abriría pidiendo login de nuevo.
   */
  session?: {
    load: () => string | null;
    save: (token: string | null) => void;
  };
}

/**
 * Grupos de canales que un puesto manda al servidor por /lan/rpc. Lo que no
 * está acá se resuelve en CADA máquina (system, lan, updater, hardware,
 * license, print, desktopWindow; también novedades y guia: la versión
 * instalada, el "ya lo vi" y los primeros pasos son de cada puesto, porque
 * cada máquina se actualiza por separado).
 */
export const LAN_ROUTED_GROUPS = new Set([
  'articles',
  'customers',
  'suppliers',
  'families',
  'promotions',
  'returns',
  'users',
  'roles',
  'company',
  // Multisucursal: la edición de la licencia y las sucursales son del
  // comercio, o sea del SERVIDOR (la terminal no tiene licencia propia).
  'funciones',
  'branches',
  'sales',
  'quotes',
  'purchases',
  'cash',
  'inventory',
  'accounts',
  'supplierAccounts',
  'reports',
  'search',
  'paymentMethods',
  'priceUpdate',
  'backup',
  'import',
  'auth',
  'mpQr',
  'accounting',
  'cashGeneral',
  'analytics',
  // Catálogo web: la config vive en la base (companies) del servidor.
  'catalogo',
  'audit',
  'maintenance',
  'fiscal',
  // Flowy VA AL SERVIDOR. Estaba como local porque su clave de API vivía en el
  // main, pero hace rato que funciona 100% offline y, sobre todo, sus
  // respuestas con datos del negocio ("¿cuánto vendí hoy?") necesitan LA BASE,
  // que sólo tiene el servidor. En los puestos quedaba sin contestar nada.
  'assistant',
  // Modo demo y primeros pasos (E5): el estado del negocio vive en el servidor.
  'demo',
  'onboarding',
  // Facturas por teléfono: las fotos, la cola de lectura y la base están en el servidor.
  'facturas',
]);

/**
 * Lo que el servidor rechaza por /lan/rpc con 403 aunque el grupo viaje por
 * LAN. Son operaciones sobre la MÁQUINA servidor (pisar su base con un
 * restore, borrar la operativa, cargar o sacar la demo) o sobre quién puede
 * entrar y con qué permisos (usuarios y roles): se hacen sentado en el
 * servidor, nunca desde un puesto. Las lecturas de esos grupos sí pasan, para
 * que las pantallas abran. Los grupos que no están en LAN_ROUTED_GROUPS
 * (license, updater, lan, system, hardware...) tampoco pasan: un puesto no
 * puede desactivar la licencia, reiniciar el servidor ni elegir archivos en
 * su disco. Vive acá, junto a la lista de ruteo, para que haya UNA sola
 * definición de qué cruza la red.
 */
export const LAN_SERVER_DENIED_CHANNELS = new Set([
  'backup:restore',
  'users:create',
  'users:update',
  'users:delete',
  'roles:setConfig',
  'demo:load',
  'demo:remove',
  'demo:restart',
  // IA de Flowy (Ollama): se instala, descarga y configura sentado en la PC
  // servidor, que es la que responde las preguntas. Desde un puesto sólo se ve el estado.
  'assistant:iaConfigurar',
  'assistant:iaDescargar',
  'assistant:iaInstalarOllama',
  'assistant:iaProbar',
  // Facturas por teléfono: activar la opción (abre una escucha en la red) y
  // descargar el lector se hacen sentado en la PC servidor.
  'facturas:configurar',
  'facturas:descargarLector',
  // Interruptor "Edición Multisucursal (versión de prueba)": es de la PC que
  // tiene la base y se maneja sentado ahí. Una terminal nunca lo necesita.
  'funciones:edicionPrueba',
  'funciones:setEdicionPrueba',
]);
export const LAN_SERVER_DENIED_GROUPS = new Set(['maintenance']);

/**
 * Lo que NO se hace desde INTERNET, aunque sí se pueda desde la red local.
 *
 * Criterio: desde afuera el dueño mira, vende y cobra; lo que toca la
 * configuración del comercio, su facturación ante ARCA o sus datos en bloque
 * se hace sentado en el local. Es lo que limita el daño si alguien consigue
 * una contraseña: no puede emitir facturas a nombre del comercio, cambiar la
 * ficha fiscal, exportar el padrón de clientes ni reiniciar la operativa.
 */
export const REMOTO_DENIED_GROUPS = new Set(['fiscal', 'import', 'maintenance', 'demo', 'mpQr']);
export const REMOTO_DENIED_CHANNELS = new Set([
  'company:upsert',
  'priceUpdate:apply',
  'priceUpdate:rollback',
  'sales:voidRange',
  'catalogo:syncConfigurar',
  'catalogo:vincularLote',
  // Crea y vincula en bloque TODO el padrón en el catálogo: se hace en el local.
  'catalogo:aplicarCargaTotal',
  'paymentMethods:delete',
  'customers:delete',
  'suppliers:delete',
  'articles:delete',
  // Toca la utilidad de TODO el padrón de una vez: se hace sentado en el local.
  'articles:recalcularMargenes',
  // IA de Flowy: instalar/descargar/configurar se hace en el local.
  'assistant:iaConfigurar',
  'assistant:iaDescargar',
  'assistant:iaInstalarOllama',
  'assistant:iaProbar',
  // Facturas por teléfono: activar y descargar el lector se hace en el local.
  'facturas:configurar',
  'facturas:descargarLector',
  // Multisucursal: la configuración de sucursales se hace en el local.
  'branches:renombrar',
  // El interruptor de la edición de prueba, también (ver LAN_SERVER_DENIED_CHANNELS).
  'funciones:edicionPrueba',
  'funciones:setEdicionPrueba',
]);

/** ¿El servidor atiende este canal cuando la visita entra por el acceso remoto? */
export function remotoAccepts(channel: string): boolean {
  if (!lanServerAccepts(channel)) return false;
  if (REMOTO_DENIED_GROUPS.has(getGroup(channel))) return false;
  return !REMOTO_DENIED_CHANNELS.has(channel);
}

/**
 * Lo que una PC de sucursal EMPAREJADA suma, por internet, a la lista corta
 * del acceso remoto: exactamente lo que motivó el emparejamiento.
 *
 * - Facturar ante ARCA (emitir factura y nota, y las lecturas que usan Ventas,
 *   el detalle de venta y las devoluciones).
 * - Cobrar con Mercado Pago QR (crear, verificar, cancelar y vincular la orden).
 *
 * NO suma la configuración fiscal (certificado, puntos de venta), la cuenta de
 * Mercado Pago (`mpQr:setupCompany` cambiaría a dónde van los cobros), la
 * ficha del comercio, la anulación en bloque, la importación ni los borrados:
 * eso sigue haciéndose sentado en el local. Si la PC de la sucursal se
 * compromete (o alguien se lleva su token con una contraseña de
 * administrador), el daño queda acotado a vender y cobrar, como en el local.
 */
export const DISPOSITIVO_EXTRA_CHANNELS = new Set([
  'fiscal:getConfigPublic',
  'fiscal:listSalePoints',
  'fiscal:getVoucherForSale',
  'fiscal:listVouchers',
  'fiscal:issueInvoice',
  'fiscal:issueNote',
  'mpQr:getConfig',
  'mpQr:listPosDevices',
  'mpQr:listOrders',
  'mpQr:getQrForCashRegister',
  'mpQr:createOrder',
  'mpQr:verifyPayment',
  'mpQr:cancelOrder',
  'mpQr:getActiveOrder',
  'mpQr:linkOrderToSale',
]);

/** ¿El servidor atiende este canal por el túnel cuando lo pide una PC de sucursal emparejada? */
export function dispositivoAccepts(channel: string): boolean {
  if (remotoAccepts(channel)) return true;
  return lanServerAccepts(channel) && DISPOSITIVO_EXTRA_CHANNELS.has(channel);
}

/** ¿El servidor atiende este canal si llega por /lan/rpc? */
export function lanServerAccepts(channel: string): boolean {
  const group = getGroup(channel);
  if (!LAN_ROUTED_GROUPS.has(group) || LAN_SERVER_DENIED_GROUPS.has(group)) return false;
  return !LAN_SERVER_DENIED_CHANNELS.has(channel);
}

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
 * `--lan-server-url=https://…` y `--lan-token=PIN`. Devuelve `single` si no
 * hay flags. Con dirección web el PIN es opcional: por el túnel no se pide.
 */
export function parseLanArgs(argv: readonly string[]): { mode: LanBridgeMode; lanCfg?: LanClientConfig } {
  let mode: LanBridgeMode = 'single';
  let server: string | undefined;
  let serverUrl: string | undefined;
  let token: string | undefined;
  for (const a of argv) {
    if (a.startsWith('--lan-mode=')) {
      const v = a.slice('--lan-mode='.length);
      if (v === 'client' || v === 'server' || v === 'single') mode = v;
    } else if (a.startsWith('--lan-server-url=')) {
      serverUrl = a.slice('--lan-server-url='.length);
    } else if (a.startsWith('--lan-server=')) {
      server = a.slice('--lan-server='.length);
    } else if (a.startsWith('--lan-token=')) {
      token = a.slice('--lan-token='.length);
    }
  }
  if (mode === 'client' && serverUrl) {
    const n = normalizarUrlServidor(serverUrl);
    if (n.ok) {
      const u = new URL(n.url);
      return {
        mode,
        lanCfg: {
          serverIp: u.hostname,
          serverPort: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
          token: token ?? '',
          serverBaseUrl: n.url,
          esSucursal: true,
        },
      };
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
  const state: LanState = { sessionToken: io.session?.load() ?? null };
  const setToken = (t: string | null): void => {
    state.sessionToken = t;
    io.session?.save(t);
  };
  const doFetch: typeof fetch = io.fetch ?? (globalThis.fetch as typeof fetch);
  const timeoutMs = io.httpTimeoutMs ?? TIMEOUT_RPC_MS;
  const timeoutLargoMs = io.httpTimeoutLargoMs ?? TIMEOUT_RPC_LARGO_MS;

  // IDENTIDAD DE ESTA PC. Se recuerda la PROMESA: dos pedidos simultáneos al
  // abrir la app no la preguntan dos veces. Se vuelve a pedir cada
  // `revisarCentralMs` y siempre antes de iniciar sesión: en una PC de sucursal
  // el main comprueba ahí que del otro lado esté SU casa central. Si la
  // comprobación falla, NO se manda nada (ni el token ni la contraseña) y la
  // próxima llamada vuelve a preguntar.
  interface IdentidadResuelta {
    h: Record<string, string>;
    /** El main comprobó que la dirección es la casa central de esta PC. */
    verificada: boolean;
    /** Motivo para no mandar nada a esa dirección (central no verificada). */
    bloqueo: string | null;
  }
  const SIN_IDENTIDAD: IdentidadResuelta = { h: {}, verificada: false, bloqueo: null };
  const revisarCentralMs = io.revisarCentralMs ?? 5 * 60_000;
  let identidadCache: (IdentidadResuelta & { en: number }) | null = null;
  let identidadP: Promise<IdentidadResuelta> | null = null;
  const obtenerIdentidad = (verificarAhora: boolean): Promise<IdentidadResuelta> => {
    if (!io.identidad) return Promise.resolve(SIN_IDENTIDAD);
    const cache = identidadCache;
    if (!verificarAhora && cache && !cache.bloqueo && Date.now() - cache.en < revisarCentralMs) {
      return Promise.resolve(cache);
    }
    if (!verificarAhora && identidadP) return identidadP;
    const p = (async (): Promise<IdentidadResuelta> => {
      try {
        const id = await io.identidad?.(verificarAhora ? { verificarCentral: true } : undefined);
        if (!id) return SIN_IDENTIDAD;
        if (id.central === 'rechazada') {
          return { h: {}, verificada: false, bloqueo: id.motivoCentral || 'No se pudo comprobar que esa dirección sea la casa central de esta PC.' };
        }
        if (typeof id.terminalId !== 'string' || !id.terminalId) return SIN_IDENTIDAD;
        const h: Record<string, string> = { [HDR_TERMINAL]: id.terminalId.slice(0, 128) };
        // El nombre puede traer acentos o eñes: los encabezados HTTP sólo
        // admiten ASCII, así que viaja codificado.
        if (id.terminalNombre) h[HDR_TERMINAL_NOMBRE] = encodeURIComponent(id.terminalNombre.slice(0, 64));
        if (id.dispositivoToken) h[HDR_DISPOSITIVO] = id.dispositivoToken;
        return { h, verificada: id.central === 'verificada', bloqueo: null };
      } catch {
        return SIN_IDENTIDAD;
      }
    })();
    identidadP = p;
    void p
      .then((r) => {
        identidadCache = { ...r, en: Date.now() };
      })
      .finally(() => {
        if (identidadP === p) identidadP = null;
      });
    return p;
  };

  // ¿El servidor admite los encabezados de identidad? (ver `sondearIdentidad`).
  // Un "sí" se recuerda para siempre; un "no" se vuelve a preguntar cada
  // `revisarIdentidadMs`, así la terminal empieza a identificarse sola cuando
  // se actualiza el servidor. Si no se pudo preguntar, se mantiene lo último
  // que se supo (y, sin dato, se mandan: es lo que pasa con un servidor nuevo).
  const revisarMs = io.revisarIdentidadMs ?? 60_000;
  let capacidad: { admite: boolean; en: number } | null = null;
  let sondeoP: Promise<boolean> | null = null;
  const servidorAdmiteIdentidad = (): Promise<boolean> => {
    if (!io.sondearIdentidad || !lanCfg) return Promise.resolve(true);
    if (capacidad && (capacidad.admite || Date.now() - capacidad.en < revisarMs)) {
      return Promise.resolve(capacidad.admite);
    }
    sondeoP ??= (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await doFetch(`${baseDelServidor(lanCfg)}/lan/ping`, { method: 'GET', signal: controller.signal, redirect: 'error' });
        const body = (await res.json().catch(() => null)) as { ok?: unknown; identidad?: unknown } | null;
        if (!res.ok || !body || body.ok !== true) return capacidad?.admite ?? true;
        capacidad = { admite: body.identidad === true, en: Date.now() };
        return capacidad.admite;
      } catch {
        return capacidad?.admite ?? true;
      } finally {
        clearTimeout(timer);
        sondeoP = null;
      }
    })();
    return sondeoP;
  };

  async function httpRpc(channel: string, payload: unknown): Promise<IpcResponse<unknown>> {
    if (!lanCfg) {
      return { ok: false, code: 'INTERNAL', message: 'Configuración LAN ausente' };
    }
    const url = `${baseDelServidor(lanCfg)}/lan/rpc`;
    // Primero la identidad (es local: la contesta el main). En una PC de
    // sucursal trae el resultado de comprobar a la casa central, y eso NO puede
    // depender de lo que conteste la dirección (el sondeo de abajo lo contesta
    // ella misma): si no está verificada, no sale nada.
    const ident = await obtenerIdentidad(channel === 'auth:login');
    if (ident.bloqueo) return { ok: false, code: 'UNAUTHENTICATED', message: ident.bloqueo };
    // Los encabezados viajan si la central está verificada (una central que
    // prueba su identidad es nueva y los admite) o si el servidor dice que los admite.
    const identidad = ident.verificada || (await servidorAdmiteIdentidad()) ? ident.h : {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutDeCanal(channel, payload, timeoutMs, timeoutLargoMs));
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', ...identidad };
      if (state.sessionToken) headers['authorization'] = `Bearer ${state.sessionToken}`;
      const res = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel, payload, token: lanCfg.token }),
        signal: controller.signal,
        // El servidor nunca redirige: una redirección se llevaría la sesión,
        // el token de la PC o una contraseña a otro lado.
        redirect: 'error',
      });
      // PC de sucursal con la casa central apagada (o abriendo antes que ella):
      // Cloudflare contesta 502–504 / 520–530 con texto o HTML. Antes salía
      // "Respuesta inválida del servidor LAN", en cada pantalla y en el login.
      if (lanCfg.esSucursal && (res.status === 502 || res.status === 503 || res.status === 504 || (res.status >= 520 && res.status <= 530))) {
        return { ok: false, code: 'INTERNAL', message: MENSAJE_CENTRAL_NO_RESPONDE };
      }
      let body: IpcResponse<unknown>;
      try {
        body = (await res.json()) as IpcResponse<unknown>;
      } catch {
        return {
          ok: false,
          code: 'INTERNAL',
          message: lanCfg.esSucursal ? MENSAJE_CENTRAL_NO_RESPONDE : 'Respuesta inválida del servidor LAN',
        };
      }
      if (res.status === 401) {
        setToken(null);
        return body.ok
          ? { ok: false, code: 'UNAUTHENTICATED', message: 'Sesión expirada' }
          : body;
      }
      // Interceptar auth:login ok para guardar JWT y stripearlo del data
      if (channel === 'auth:login' && body.ok) {
        const data = body.data as LoginResultDTO & { _lanSessionToken?: string };
        if (typeof data._lanSessionToken === 'string') {
          setToken(data._lanSessionToken);
          const { _lanSessionToken: _drop, ...rest } = data;
          void _drop;
          return { ok: true, data: rest as LoginResultDTO };
        }
      }
      if (channel === 'auth:logout') {
        setToken(null);
      }
      return body;
    } catch (err) {
      if (lanCfg.esSucursal) return { ok: false, code: 'INTERNAL', message: MENSAJE_SIN_CONEXION_CENTRAL };
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
    whatsapp: {
      openChat: (p) => c<never>('whatsapp:open-chat', p),
      onNavigate: (cb) => on('whatsapp:navigate', (phone) => cb(phone as string)),
    },
    assistant: {
      ask: (p) => c<AssistantAskResultDTO>('assistant:ask', p),
      seguir: (p) => c<AssistantSeguirResultDTO>('assistant:seguir', p),
      iaEstado: () => c<EstadoIADTO>('assistant:iaEstado'),
      iaConfigurar: (p) => c<EstadoIADTO>('assistant:iaConfigurar', p),
      iaDescargar: () => c<EstadoIADTO>('assistant:iaDescargar'),
      iaInstalarOllama: () => c<EstadoInstalacionOllamaDTO>('assistant:iaInstalarOllama'),
      iaPrecalentar: () => c<{ ok: true }>('assistant:iaPrecalentar'),
      iaProbar: () => c<{ ms: number; ia: boolean; reply: string }>('assistant:iaProbar'),
    },
    onboarding: {
      status: () => c<OnboardingStatusDTO>('onboarding:status'),
      dismiss: () => c<{ ok: true }>('onboarding:dismiss'),
    },
    novedades: {
      pendientes: () => c<NovedadesPendientesDTO>('novedades:pendientes'),
      vistas: () => c<{ ok: true }>('novedades:vistas'),
    },
    guia: {
      estado: () => c<GuiaEstadoDTO>('guia:estado'),
      progreso: (p) => c<{ ok: true }>('guia:progreso', p),
      vista: () => c<{ ok: true }>('guia:vista'),
    },
    facturas: {
      estado: () => c<EstadoFacturasDTO>('facturas:estado'),
      configurar: (p) => c<EstadoFacturasDTO>('facturas:configurar', p),
      descargarLector: () => c<EstadoFacturasDTO>('facturas:descargarLector'),
      vincular: () => c<FacturasVincularDTO>('facturas:vincular'),
      listar: () => c<FacturaEscaneadaResumenDTO[]>('facturas:listar'),
      obtener: (p) => c<FacturaEscaneadaDetalleDTO>('facturas:obtener', p),
      foto: (p) => c<{ dataUrl: string }>('facturas:foto', p),
      guardar: (p) => c<FacturaEscaneadaDetalleDTO>('facturas:guardar', p),
      releer: (p) => c<{ ok: true }>('facturas:releer', p),
      descartar: (p) => c<{ ok: true }>('facturas:descartar', p),
      marcarCargada: (p) => c<{ ok: true; guardados: number }>('facturas:marcarCargada', p),
      seguir: (p) => c<FacturasSeguimientoDTO>('facturas:seguir', p),
      aCompras: (p) => c<{ recibe: boolean }>('facturas:aCompras', p),
    },
    catalogo: {
      estadisticas: (p) => c<CatalogoEstadisticasDTO>('catalogo:estadisticas', p),
      syncEstado: () => c<CatalogoSyncEstadoDTO>('catalogo:syncEstado'),
      syncActivar: (p) => c<{ ok: true }>('catalogo:syncActivar', p),
      syncConfigurar: (p) => c<{ ok: true }>('catalogo:syncConfigurar', p),
      syncAhora: (p) => c<CatalogoSyncResultadoDTO>('catalogo:syncAhora', p),
      sugerirVinculacion: () => c<CatalogoSugerenciaVinculacionDTO>('catalogo:sugerirVinculacion'),
      vincularLote: (p) => c<CatalogoVincularLoteResultadoDTO>('catalogo:vincularLote', p),
      planCargaTotal: () => c<CatalogoPlanCargaTotalDTO>('catalogo:planCargaTotal'),
      aplicarCargaTotal: (p) => c<CatalogoResultadoCargaTotalDTO>('catalogo:aplicarCargaTotal', p),
      pedidosContarPendientes: () => c<{ pendientes: number }>('catalogo:pedidosContarPendientes'),
      pedidosListar: (p) => c<PedidoWebDTO[]>('catalogo:pedidosListar', p),
      pedidoConvertir: (p) => c<{ ok: true; ventaNumero: number; ventaTipo: string }>('catalogo:pedidoConvertir', p),
      pedidoRechazar: (p) => c<{ ok: true }>('catalogo:pedidoRechazar', p),
      pedidoVincularVenta: (p) => c<{ ok: true }>('catalogo:pedidoVincularVenta', p),
    },
    demo: {
      status: () => c<DemoStatusDTO>('demo:status'),
      load: () => c<{ ok: true; ventas: number; compras: number }>('demo:load'),
      remove: (p) => c<{ ok: true; needsRestart: true }>('demo:remove', p),
      restart: () => c<{ ok: true }>('demo:restart'),
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
      recalcularMargenes: (p) => c<never>('articles:recalcularMargenes', p),
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
    roles: {
      getConfig: () => c<RolesConfigDTO>('roles:getConfig'),
      setConfig: (p) => c<RolesConfigDTO>('roles:setConfig', p),
    },
    company: {
      get: () => c<never>('company:get'),
      upsert: (p) => c<never>('company:upsert', p),
    },
    funciones: {
      estado: () => c<never>('funciones:estado'),
      edicionPrueba: () => c<never>('funciones:edicionPrueba'),
      setEdicionPrueba: (p) => c<never>('funciones:setEdicionPrueba', p),
    },
    branches: {
      listar: () => c<never>('branches:listar'),
      renombrar: (p) => c<never>('branches:renombrar', p),
    },
    fiscal: {
      getConfig: () => c<never>('fiscal:getConfig'),
      getConfigPublic: () => c<never>('fiscal:getConfigPublic'),
      saveConfig: (p) => c<never>('fiscal:saveConfig', p),
      testConnection: () => c<never>('fiscal:testConnection'),
      listSalePoints: () => c<never>('fiscal:listSalePoints'),
      fetchSalePointsFromArca: () => c<never>('fiscal:fetchSalePointsFromArca'),
      saveSalePoint: (p) => c<never>('fiscal:saveSalePoint', p),
      deleteSalePoint: (p) => c<never>('fiscal:deleteSalePoint', p),
      issueInvoice: (p) => c<never>('fiscal:issueInvoice', p),
      issueNote: (p) => c<never>('fiscal:issueNote', p),
      getVoucherForSale: (p) => c<never>('fiscal:getVoucherForSale', p),
      listVouchers: (p) => c<never>('fiscal:listVouchers', p),
      archivarPendientes: () => c<never>('fiscal:archivarPendientes'),
      getPdfFolder: () => c<never>('fiscal:getPdfFolder'),
      openPdfFolder: () => c<never>('fiscal:openPdfFolder'),
    },
    maintenance: {
      resetOperationalData: (p) => c<never>('maintenance:resetOperationalData', p),
    },
    audit: {
      list: (p) => c<never>('audit:list', p),
      listAreas: () => c<never>('audit:listAreas'),
    },
    returns: {
      createForSale: (p) => c<never>('returns:createForSale', p),
      listBySale: (p) => c<never>('returns:listBySale', p),
      createForPurchase: (p) => c<never>('returns:createForPurchase', p),
      listByPurchase: (p) => c<never>('returns:listByPurchase', p),
    },
    promotions: {
      list: () => c<never>('promotions:list'),
      get: (p) => c<never>('promotions:get', p),
      create: (p) => c<never>('promotions:create', p),
      update: (p) => c<never>('promotions:update', p),
      setActive: (p) => c<never>('promotions:setActive', p),
      delete: (p) => c<never>('promotions:delete', p),
    },
    quotes: {
      create: (p) => c<never>('quotes:create', p),
      get: (p) => c<never>('quotes:get', p),
      listByDateRange: (p) => c<never>('quotes:listByDateRange', p),
      delete: (p) => c<never>('quotes:delete', p),
      previewConvert: (p) => c<never>('quotes:previewConvert', p),
      convertToSale: (p) => c<never>('quotes:convertToSale', p),
    },
    sales: {
      create: (p) => c<never>('sales:create', p),
      void: (p) => c<never>('sales:void', p),
      voidRange: (p) => c<never>('sales:voidRange', p),
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
      payToSupplier: (p) => c<never>('supplierAccounts:payToSupplier', p),
      getStatement: (p) => c<never>('supplierAccounts:getStatement', p),
      listOpenBySupplier: (p) =>
        c<never>('supplierAccounts:listOpenBySupplier', p),
      getAccountDetail: (p) =>
        c<never>('supplierAccounts:getAccountDetail', p),
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
    priceUpdate: {
      preview: (p) => c<never>('priceUpdate:preview', p),
      apply: (p) => c<never>('priceUpdate:apply', p),
      listBatches: (p) => c<never>('priceUpdate:listBatches', p),
      getBatchDetail: (p) => c<never>('priceUpdate:getBatchDetail', p),
      rollback: (p) => c<never>('priceUpdate:rollback', p),
      getArticleHistory: (p) => c<never>('priceUpdate:getArticleHistory', p),
    },
    accounts: {
      receivePayment: (p) => c<never>('accounts:receivePayment', p),
      receivePaymentToCustomer: (p) => c<never>('accounts:receivePaymentToCustomer', p),
      getStatement: (p) => c<never>('accounts:getStatement', p),
      getTotalReceivables: () => c<never>('accounts:getTotalReceivables'),
      listBalances: () => c<never>('accounts:listBalances'),
      listOpenByCustomer: (p) =>
        c<never>('accounts:listOpenByCustomer', p),
      getAccountDetail: (p) =>
        c<never>('accounts:getAccountDetail', p),
    },
    search: {
      global: (p) => c<never>('search:global', p),
    },
    reports: {
      salesByDateRange: (p) => c<never>('reports:salesByDateRange', p),
      purchasesByDateRange: (p) =>
        c<never>('reports:purchasesByDateRange', p),
      salesBySeller: (p) => c<never>('reports:salesBySeller', p),
      inventoryByFamily: () => c<never>('reports:inventoryByFamily'),
      topArticles: (p) => c<never>('reports:topArticles', p),
      cashRegisterReport: (p) => c<never>('reports:cashRegisterReport', p),
      getLowStock: (p) => c<never>('reports:getLowStock', p),
      getInventory: (p) => c<never>('reports:getInventory', p),
      getSalesByVendor: (p) => c<never>('reports:getSalesByVendor', p),
    },
    system: {
      /** Aviso de que otra ventana modificó datos: sirve para refrescar. */
      onDataChanged: (cb: (info: { channel: string; group: string }) => void) =>
        on('data:changed', (p) => cb(p as { channel: string; group: string })),
      pickFile: (p) => c<never>('system:pickFile', p),
      pickImage: () => c<never>('system:pickImage'),
      getMachineId: () => c<never>('system:getMachineId'),
      getVersion: () => c<never>('system:getVersion'),
      getDbPath: () => c<never>('system:getDbPath'),
      showInFolder: (p) => c<never>('system:showInFolder', p),
      getInfo: () => c<never>('system:getInfo'),
      openExternal: (p) => c<never>('system:openExternal', p),
    },
    desktopWindow: {
      open: (p: DesktopWindowOpenDTO) =>
        c<{ windowKey: string; created: boolean }>('desktopWindow:open', p),
      close: (p: { windowKey: string }) => c<{ closed: boolean }>('desktopWindow:close', p),
      focus: (p: { windowKey: string }) => c<{ focused: boolean }>('desktopWindow:focus', p),
      list: () => c<{ windows: DesktopWindowInfoDTO[] }>('desktopWindow:list'),
      closeSelf: () => c<{ closed: boolean }>('desktopWindow:closeSelf'),
      minimizeSelf: () => c<{ minimized: boolean }>('desktopWindow:minimizeSelf'),
      focusMain: () => c<{ ok: true }>('desktopWindow:focusMain'),
      openManual: () => c<never>('desktopWindow:openManual'),
      onExtras: (cb) => on('desktopWindow:extras', (p) => cb(p as never)),
    },
    print: {
      diagnose: (p) => c<never>('print:diagnose', p),
      silentCurrent: (p) => c<never>('print:silentCurrent', p),
      listElectron: () => c<never>('printer:listElectron'),
    },
    license: {
      getState: () => c<never>('license:getState'),
      activate: (p) => c<never>('license:activate', p),
      activateTrial: (p) => c<never>('license:activateTrial', p),
      heartbeat: () => c<never>('license:heartbeat'),
      deactivate: () => c<never>('license:deactivate'),
      onChanged: (cb) => on('license:changed', () => cb()),
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
        printPaymentReceipt: (p) =>
          c<never>('hardware:printer:print-payment-receipt', p),
        printCashClose: (p) =>
          c<never>('hardware:printer:print-cash-close', p),
        listSystem: () => c<never>('hardware:printer:list-system'),
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
      openFirewall: () => c<never>('lan:openFirewall'),
      diagnose: () => c<never>('lan:diagnose'),
      remotoEstado: () => c<never>('lan:remotoEstado'),
      remotoActivar: (p) => c<never>('lan:remotoActivar', p),
      remotoAprovisionar: (p) => c<never>('lan:remotoAprovisionar', p),
      remotoConfigurarAutomatico: () => c<never>('lan:remotoConfigurarAutomatico'),
      remotoClavesDebiles: () => c<never>('lan:remotoClavesDebiles'),
      getConnectedClients: () => c<never>('lan:getConnectedClients'),
      applyAndRestart: () => c<never>('lan:applyAndRestart'),
      emparejarGenerarCodigo: () => c<never>('lan:emparejarGenerarCodigo'),
      dispositivosListar: () => c<never>('lan:dispositivosListar'),
      dispositivoRevocar: (p) => c<never>('lan:dispositivoRevocar', p),
      setCajaPorPc: (p) => c<never>('lan:setCajaPorPc', p),
    },
    mpQr: {
      getConfig: () => c<never>('mpQr:getConfig'),
      setupCompany: (p) => c<never>('mpQr:setupCompany', p),
      testConnection: () => c<never>('mpQr:testConnection'),
      listPosDevices: () => c<never>('mpQr:listPosDevices'),
      createPosDevice: (p) => c<never>('mpQr:createPosDevice', p),
      getQrForCashRegister: (p) => c<never>('mpQr:getQrForCashRegister', p),
      createOrder: (p) => c<never>('mpQr:createOrder', p),
      cancelOrder: (p) => c<never>('mpQr:cancelOrder', p),
      verifyPayment: (p) => c<never>('mpQr:verifyPayment', p),
      getActiveOrder: (p) => c<never>('mpQr:getActiveOrder', p),
      listOrders: (p) => c<never>('mpQr:listOrders', p),
      linkOrderToSale: (p) => c<never>('mpQr:linkOrderToSale', p),
    },
    accounting: {
      getSummary: (p) => c<never>('accounting:getSummary', p),
      getVatBookSales: (p) => c<never>('accounting:getVatBookSales', p),
      getVatBookPurchases: (p) => c<never>('accounting:getVatBookPurchases', p),
    },
    cashGeneral: {
      getBalance: () => c<never>('cashGeneral:getBalance'),
      getBalanceBreakdown: () => c<never>('cashGeneral:getBalanceBreakdown'),
      adjustBreakdown: (p: { cashAmount: string }) => c('cashGeneral:adjustBreakdown', p),
      listMovements: (p) => c<never>('cashGeneral:listMovements', p),
      addIncome: (p) => c<never>('cashGeneral:addIncome', p),
      addExpense: (p) => c<never>('cashGeneral:addExpense', p),
      transferFromDaily: (p) => c<never>('cashGeneral:transferFromDaily', p),
      transferFromClosed: (p) => c<never>('cashGeneral:transferFromClosed', p),
    },
    analytics: {
      resumenDelDia: (p) => c<never>('analytics:resumenDelDia', p),
      avanceDelMes: (p) => c<never>('analytics:avanceDelMes', p),
      resultadoNeto: (p) => c<never>('analytics:resultadoNeto', p),
      antiguedadDeuda: () => c<never>('analytics:antiguedadDeuda'),
      conversionPresupuestos: (p) => c<never>('analytics:conversionPresupuestos', p),
      stockSinMovimiento: (p) => c<never>('analytics:stockSinMovimiento', p),
      reposicionPrioritaria: (p) => c<never>('analytics:reposicionPrioritaria', p),
      ventasDeArticulo: (p) => c<never>('analytics:ventasDeArticulo', p),
      getTopSellingProducts: (p) => c<never>('analytics:getTopSellingProducts', p),
      getBottomSellingProducts: (p) => c<never>('analytics:getBottomSellingProducts', p),
      getPaymentMethodsRanking: (p) => c<never>('analytics:getPaymentMethodsRanking', p),
      ventasPorFormaPago: (p) => c<never>('analytics:ventasPorFormaPago', p),
      ventasPorFormaPagoEnTiempo: (p) => c<never>('analytics:ventasPorFormaPagoEnTiempo', p),
      getTopCustomers: (p) => c<never>('analytics:getTopCustomers', p),
      getTopSuppliers: (p) => c<never>('analytics:getTopSuppliers', p),
      getSalesTrend: (p) => c<never>('analytics:getSalesTrend', p),
      getAverageTicket: (p) => c<never>('analytics:getAverageTicket', p),
      getSalesByHour: (p) => c<never>('analytics:getSalesByHour', p),
      getSalesByDayOfWeek: (p) => c<never>('analytics:getSalesByDayOfWeek', p),
      getMarginByCategory: (p) => c<never>('analytics:getMarginByCategory', p),
      getStockRotation: (p) => c<never>('analytics:getStockRotation', p),
    },
    updater: {
      checkNow: () => c<never>('updater:checkNow'),
      quitAndInstall: () => c<never>('updater:quitAndInstall'),
      getPending: () => c<never>('updater:getPending'),
      getAutoCheck: () => c<never>('updater:getAutoCheck'),
      setAutoCheck: (p) => c<never>('updater:setAutoCheck', p),
      getChannel: () => c<never>('updater:getChannel'),
      setChannel: (p) => c<never>('updater:setChannel', p),
      onAvailable: (cb) => on('updater:available', (p) => cb(p as never)),
      onDownloaded: (cb) => on('updater:downloaded', (p) => cb(p as never)),
      onOutdated: (cb) => on('updater:outdated', (p) => cb(p as never)),
    },
  };
}
