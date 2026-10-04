/**
 * Servidor LAN embebido para el modo multi-caja.
 *
 * Expone:
 *  - `POST /lan/rpc { channel, payload, token }` — RPC sobre los handlers IPC.
 *  - `GET  /lan/ping` — keepalive sin auth (registra al cliente).
 *
 * Auth en /lan/rpc:
 *  - `token` (PIN) en el body: empareja el puesto con este servidor. Sólo eso:
 *    el PIN lo conocen todas las terminales, así que no puede ser prueba de
 *    nada más. Los intentos fallidos se cuentan por IP y a los pocos errores
 *    el servidor contesta 429 un rato (un PIN de 6 dígitos se adivina en
 *    minutos si se lo deja).
 *  - `Authorization: Bearer <jwt>`: identifica la SESIÓN del usuario logueado
 *    en la caja cliente. La firma del JWT usa HMAC-SHA256 con un secreto
 *    aleatorio que sólo tiene el servidor (`opts.jwtSecret`, persistido por
 *    LanManager). Antes se derivaba del PIN y cualquier terminal podía
 *    firmarse una sesión de administrador. Se exige para todos los canales
 *    excepto `auth:login`/`auth:logout`.
 *  - Sólo se atienden los canales que un puesto tiene motivo para llamar
 *    (`lanServerAccepts`); el resto (licencia, updater, red, archivos del
 *    servidor) recibe 403 aunque la sesión sea de administrador.
 *  - Con la licencia del servidor en sólo lectura o revocada, los canales que
 *    escriben reciben 403: la regla que el escritorio aplica en la pantalla
 *    (useCanWrite) acá se aplica en el servidor, que es donde vale.
 *  - El handler `auth:login` que devuelve `{ user, sessionToken }` se intercepta
 *    en este server para **firmar** un JWT (sub=user.id, exp=12h) y agregarlo
 *    al data como `_lanSessionToken`. El cliente lo cachea (preload).
 *  - Antes de cada handler con JWT válido, hacemos `sessionStore.runWith(user)`
 *    para que `withSession(deps,...)` vea ese user como sesión activa durante
 *    el lifetime del RPC. `runWith` AÍSLA la sesión por invocación vía
 *    AsyncLocalStorage: RPCs concurrentes nunca comparten `currentUser`, y la
 *    sesión local del proceso (caja servidor) queda intacta.
 *
 * Multisucursal (etapa 1):
 *  - `POST /lan/emparejar { codigo, nombre, machineId }`: una PC de sucursal
 *    canjea un código de un solo uso por un token de dispositivo (ver
 *    `dispositivos.ts`). Con ese token (`x-stockflow-dispositivo`) el túnel le
 *    aplica la lista de la red local, los intentos fallidos se cuentan por PC
 *    y su sesión queda atada a ella. Sin la edición Multisucursal, la ruta da
 *    404 y el encabezado se ignora.
 *  - `POST /lan/central { dispositivoId, nonce }`: la PC de sucursal comprueba
 *    que del otro lado está SU casa central antes de mandar el token o una
 *    contraseña (`{ prueba }` = HMAC del hash del secreto; ver dispositivos.ts).
 *    No habilita nada: es sólo identidad.
 *  - Identidad de la terminal (`x-stockflow-terminal`, `-nombre`): cada
 *    handler corre dentro de `correrComoTerminal`, y `obtenerTerminalActual`
 *    dice desde qué PC llegó el pedido (electron/ipc/terminal-actual.ts).
 *  - Las respuestas de /lan/rpc de 8 KB o más viajan con gzip si el cliente
 *    manda `Accept-Encoding: gzip` (fetch lo hace solo y descomprime solo).
 *
 * Decisiones:
 *  - `node:http` (sin Fastify) para no inflar el bundle.
 *  - JWT inline (HS256) con `crypto.createHmac`. Cero deps nuevas.
 *  - mDNS via `bonjour-service` cargado dinámicamente (opcional).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync, promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';

import type { HandlerMap } from '../ipc/handler-context';
import type { SessionStore } from '../ipc/session-store';
import {
  correrComoTerminal,
  idTerminalDeDispositivo,
  limpiarIdTerminal,
  limpiarNombreTerminal,
  type TerminalActual,
} from '../ipc/terminal-actual';
import type { IpcResponse } from '../ipc/types';
import {
  dispositivoAccepts,
  HDR_DISPOSITIVO,
  HDR_TERMINAL,
  HDR_TERMINAL_NOMBRE,
  lanServerAccepts,
  remotoAccepts,
} from '../preload-bridge';
import type { DispositivoVerificado, DispositivosLike, OrigenPedido } from './dispositivos';

const gzip = promisify(gzipCb);

interface InfoCliente {
  /** Lo que se muestra: la IP en la red local; por el túnel, la red del visitante. */
  ip?: string;
  lastSeen: number;
  nombre?: string;
  usuario?: string;
  ultimaAccion?: string;
  via?: 'app' | 'navegador';
  operaciones?: number;
}

export interface ClienteConectado {
  ip: string;
  lastSeen: number;
  /** Nombre de la PC, si la terminal se identificó. */
  nombre: string | null;
  usuario: string | null;
  ultimaAccion: string | null;
  via: 'app' | 'navegador';
  operaciones: number;
}

export interface LanServerOptions {
  handlers: HandlerMap;
  port: number;
  /**
   * Puerta dedicada al acceso remoto, atada a 127.0.0.1. Sólo la alcanza el
   * túnel de esta misma PC; por ahí no se pide el PIN de la red local.
   * Ausente = no hay acceso remoto (comportamiento anterior).
   */
  tunnelPort?: number;
  /**
   * Comercio de UNA sola PC: no hay red local que atender, pero el acceso
   * remoto igual tiene que funcionar. Con esto se abre SÓLO la puerta del
   * túnel (127.0.0.1:`tunnelPort`) y no se escucha en `port` ni se anuncia por
   * mDNS: nada queda expuesto a la red del local. Requiere `tunnelPort`.
   */
  soloTunel?: boolean;
  token: string;
  /** Required para impersonar al usuario del JWT durante RPCs autenticados. */
  sessionStore?: SessionStore;
  /** Resolver opcional de usuario por id (los handlers requieren SafeUser). */
  resolveUser?: (userId: string) => Promise<UserLite | null> | UserLite | null;
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  enableMdns?: boolean;
  /** Duración del JWT en segundos (default 12h). */
  jwtExpiresInSec?: number;
  /**
   * Secreto con que se firman los JWT de sesión. En la app viene de lan.json
   * (`LanManager.getOrCreateJwtSecret`). Si no se pasa, se genera uno por
   * proceso: nunca se cae al PIN.
   */
  jwtSecret?: string;
  /**
   * Estado de la licencia de ESTE servidor. Los puestos conectados no tienen
   * licencia propia: trabajan amparados por la del servidor (una licencia por
   * comercio), así que necesitan poder consultarla.
   */
  licenseStatus?: () => 'active' | 'readOnly' | 'unlicensed' | 'revoked';
  /** Versión del servidor, para que los puestos por navegador la muestren. */
  appVersion?: string;
  /** Carpeta con la interfaz compilada, para servirla al navegador. */
  webRoot?: string;
  /**
   * Rutas `/lan/foto/…` (facturas por teléfono), atendidas por fuera del RPC:
   * tienen su propia credencial, el token del enlace. Devuelve true si
   * contestó. Ausente = esas rutas dan 404 como siempre.
   */
  rutaExtra?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /**
   * PC de sucursal emparejadas (multisucursal). Habilita `POST /lan/emparejar`
   * y el encabezado `x-stockflow-dispositivo`. Ausente = esa ruta da 404 y el
   * encabezado se ignora (comportamiento anterior).
   */
  dispositivos?: DispositivosLike;
  /**
   * ¿El comercio tiene la edición Multisucursal? Sin ella, `/lan/emparejar`
   * da 404 y el encabezado de dispositivo se ignora: un comercio común queda
   * exactamente como antes aunque alguna vez haya tenido PC emparejadas (si
   * baja de edición, sus sucursales vuelven a la lista corta del túnel).
   * Se consulta en cada pedido: la licencia puede cambiar con la app abierta.
   * Ausente = activo (tests).
   */
  multisucursalActivo?: () => boolean;
  /**
   * machineId de ESTA PC: es la terminal que se informa a los handlers cuando
   * un pedido remoto no se identificó (versiones viejas), igual que antes.
   */
  machineId?: string;
}

interface UserLite {
  id: string;
  username: string;
  fullName: string;
  role: 'admin' | 'manager' | 'seller';
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RpcBody {
  channel?: unknown;
  payload?: unknown;
  token?: unknown;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const PING_TTL_MS = 60_000;
/**
 * Respuestas de /lan/rpc desde este tamaño viajan comprimidas si el cliente
 * lo pide (`Accept-Encoding: gzip`). El listado de artículos de un comercio
 * con 5.000 artículos pesa ~3 MB en JSON y baja a ~10 %: por el túnel es la
 * diferencia entre esperar y no esperar. Lo chico no vale el trabajo.
 */
const UMBRAL_GZIP_BYTES = 8 * 1024;
/** Canjes de código de emparejamiento fallidos que se toleran por IP en la ventana. */
const MAX_FALLOS_EMPAREJAR = 5;
/**
 * Tokens de PC de sucursal inventados o adulterados que se toleran por IP.
 * Contador APARTE del canje de códigos: un encargado que tipea mal el código
 * no tiene por qué cortar a nadie, y nada de esto frena a una PC con token
 * válido (se verifica primero el token). Un token de una PC revocada que
 * sigue prendida no cuenta: es una PC conocida, no alguien adivinando.
 */
const MAX_FALLOS_TOKEN = 5;

/**
 * Fuerza bruta: fallos de PIN o de contraseña que se toleran por IP dentro de
 * la ventana antes de contestar 429 hasta que la ventana se vacíe. El PIN se
 * escribe una vez por terminal, así que 5 errores seguidos ya no son un
 * cajero distraído; la contraseña se tipea todos los días y se le da más aire.
 */
const VENTANA_FALLOS_MS = 10 * 60_000;
const MAX_FALLOS_PIN = 5;
const MAX_FALLOS_LOGIN = 10;

/**
 * Métodos que modifican datos. Con la licencia del servidor fuera de 'active'
 * (suscripción suspendida, prueba vencida, revocada) el escritorio bloquea
 * estos botones (useCanWrite); acá se aplica la misma regla a lo que llega
 * por red, porque un puesto no tiene licencia propia y la interfaz servida al
 * navegador no puede hacer cumplir nada por sí sola. Las lecturas siguen
 * pasando: el comercio tiene que poder consultar lo suyo.
 */
// Con licencia en sólo lectura pasa SÓLO lo que se reconoce como lectura;
// cualquier verbo nuevo cae del lado de la escritura por defecto (antes era al
// revés y `catalogo:syncConfigurar` o `mpQr:verifyPayment` seguían escribiendo).
const METODOS_DE_LECTURA =
  /^(get|list|find|search|count|preview|check|has|is|status|stats|report|summary|export|print|ping|dummy|test|whoami|me|read|show|calc|compute|resolve|suggest|validate|lookup|history|balance|breakdown|available|current|detail|movements|top|ranking|analytics|dashboard|logout|login|refresh|listar|contar|sugerir|estado|estadisticas|historial|pedidosListar|pedidosContarPendientes|syncEstado|sugerirVinculacion|planCargaTotal)(?=[A-Z_]|$)/;

/** Grupos y canales que son consulta pura aunque su nombre no lo diga. */
const GRUPOS_DE_LECTURA = new Set(['analytics', 'reports', 'search', 'assistant']);
const CANALES_DE_LECTURA = new Set([
  'guia:progreso',
  'novedades:pendientes',
  'import:progress',
  'lan:diagnose',
  'print:diagnose',
  // Facturas por teléfono: abrir una factura, ver su foto y seguir la que está
  // en revisión no escriben nada (lo que escribe es guardar, releer, descartar
  // y marcarCargada, que siguen cayendo del lado de la escritura).
  'facturas:obtener',
  'facturas:foto',
  'facturas:seguir',
]);

function esEscritura(channel: string): boolean {
  const sep = channel.indexOf(':');
  const grupo = channel.slice(0, sep);
  if (GRUPOS_DE_LECTURA.has(grupo) || CANALES_DE_LECTURA.has(channel)) return false;
  return !METODOS_DE_LECTURA.test(channel.slice(sep + 1));
}

function mensajeSoloLectura(status: string): string {
  if (status === 'revoked') return 'La licencia fue revocada: el sistema está en sólo lectura';
  if (status === 'unlicensed') return 'El servidor no tiene una licencia activa: el sistema está en sólo lectura';
  return 'La suscripción está suspendida: el sistema está en sólo lectura';
}

function b64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Firma un JWT minimalista HS256: header.payload.sig. */
export function signJwt(payload: object, secret: string): string {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = b64urlEncode(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

/**
 * Verifica firma + exp. Devuelve el payload decoded o null si inválido.
 * `dis` = PC de sucursal con la que se inició la sesión (si la hubo).
 */
export function verifyJwt(token: string, secret: string): { sub: string; exp: number; dis?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const h = parts[0]!;
  const p = parts[1]!;
  const s = parts[2]!;
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(s);
  } catch {
    return null;
  }
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  let parsed: { sub?: unknown; exp?: unknown; dis?: unknown };
  try {
    parsed = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') return null;
  if (Date.now() / 1000 >= parsed.exp) return null;
  return typeof parsed.dis === 'string'
    ? { sub: parsed.sub, exp: parsed.exp, dis: parsed.dis }
    : { sub: parsed.sub, exp: parsed.exp };
}

/**
 * Quién es el visitante, a los efectos del contador de intentos fallidos.
 *
 * Por la puerta del túnel TODO llega desde 127.0.0.1: si el contador se
 * indexara por ahí, cinco intentos de un desconocido dejarían afuera al dueño
 * (y un atacante podría bloquearle el acceso a propósito). El borde agrega la
 * IP real en `X-Forwarded-For`; se toma el ÚLTIMO salto, que es el que agregó
 * nuestro propio borde, y se agrupa por red /24 para que cambiar de IP dentro
 * del mismo proveedor no saltee el bloqueo. Fuera del túnel la cabecera se
 * IGNORA: ahí el que la mandaría es el propio atacante.
 */
function ipDelVisitante(req: IncomingMessage, esTunel: boolean): string {
  const directa = req.socket.remoteAddress ?? '';
  if (!esTunel) return directa;
  const xff = req.headers['x-forwarded-for'];
  const crudo = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  const ultimo = (crudo ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
  if (!ultimo) return directa;
  const limpia = ultimo.startsWith('::ffff:') ? ultimo.slice('::ffff:'.length) : ultimo;
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(limpia);
  if (v4) return `${v4[1]}.0/24`;
  const partes = limpia.split(':').filter(Boolean);
  return partes.length >= 4 ? `${partes.slice(0, 4).join(':')}::/64` : limpia;
}

/**
 * ¿El pedido viene de la app instalada o de un navegador? El de la app
 * (Chromium dentro de Electron) TAMBIÉN dice "Mozilla" en su user-agent: la
 * PC de sucursal figuraba "por navegador". Electron agrega "Electron/x.y".
 */
export function viaDelPedido(req: Pick<IncomingMessage, 'headers'>): 'app' | 'navegador' {
  const ua = String(req.headers['user-agent'] ?? '');
  if (/Electron\//.test(ua)) return 'app';
  return /Mozilla/i.test(ua) ? 'navegador' : 'app';
}

function isLanRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (addr.startsWith('10.') || addr.startsWith('192.168.')) return true;
  if (addr.startsWith('172.')) {
    const second = Number(addr.split('.')[1] ?? '0');
    return second >= 16 && second <= 31;
  }
  // Link-local (Windows sin DHCP: 169.254.x.x), CGNAT (100.64/10, típico de
  // routers 4G) y ULA IPv6 (fd00::/8, fe80::/10): también son "la red local".
  if (addr.startsWith('169.254.')) return true;
  if (addr.startsWith('100.')) {
    const second = Number(addr.split('.')[1] ?? '0');
    if (second >= 64 && second <= 127) return true;
  }
  const low = addr.toLowerCase();
  if (low.startsWith('fd') || low.startsWith('fc') || low.startsWith('fe80:')) return true;
  if (addr.startsWith('::ffff:')) return isLanRemote(addr.slice('::ffff:'.length));
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,GET,OPTIONS',
    // Los encabezados de identidad tienen que figurar: la terminal instalada
    // habla desde file:// (otro origen) y el navegador hace la consulta previa.
    'access-control-allow-headers': `content-type,authorization,${HDR_TERMINAL},${HDR_TERMINAL_NOMBRE},${HDR_DISPOSITIVO}`,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/** ¿El cliente acepta gzip? Sin el encabezado (terminales viejas, curl) no se comprime. */
export function aceptaGzip(req: IncomingMessage): boolean {
  const ae = String(req.headers['accept-encoding'] ?? '').toLowerCase();
  return ae.split(',').some((parte) => {
    const [nombre, ...params] = parte.trim().split(';');
    if (nombre?.trim() !== 'gzip' && nombre?.trim() !== '*') return false;
    // `gzip;q=0` = "no me mandes gzip".
    return !params.some((p) => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(p));
  });
}

/**
 * Como `sendJson`, pero comprime con gzip las respuestas grandes si el cliente
 * lo acepta. Si la compresión falla, sale sin comprimir.
 */
async function sendJsonRpc(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  const texto = JSON.stringify(body);
  const crudo = Buffer.from(texto, 'utf8');
  const cabeceras: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,GET,OPTIONS',
    'access-control-allow-headers': `content-type,authorization,${HDR_TERMINAL},${HDR_TERMINAL_NOMBRE},${HDR_DISPOSITIVO}`,
    vary: 'Accept-Encoding',
  };
  if (crudo.length >= UMBRAL_GZIP_BYTES && aceptaGzip(req)) {
    try {
      const comprimido = await gzip(crudo);
      res.writeHead(status, { ...cabeceras, 'content-encoding': 'gzip', 'content-length': String(comprimido.length) });
      res.end(comprimido);
      return;
    } catch {
      /* sale sin comprimir */
    }
  }
  res.writeHead(status, { ...cabeceras, 'content-length': String(crudo.length) });
  res.end(crudo);
}

/** Comparación en tiempo constante: un PIN corto no tiene que filtrar ni eso. */
function mismoToken(recibido: unknown, esperado: string): boolean {
  if (typeof recibido !== 'string') return false;
  const a = Buffer.from(recibido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('payload demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const NO_AUTH_CHANNELS = new Set(['auth:login', 'auth:logout']);

export class LanServer {
  private readonly opts: LanServerOptions;
  private server: Server | null = null;
  /** Puerta dedicada al acceso remoto: sólo la usa el túnel (ver `start`). */
  private serverTunel: Server | null = null;
  private bonjour: { unpublishAll: (cb?: () => void) => void } | null = null;
  private readonly log: NonNullable<LanServerOptions['log']>;
  /** ip -> lastSeen ms; ping y rpc actualizan. */
  private readonly clients = new Map<string, InfoCliente>();
  /** Última vez que cambiaron los datos (para que los puestos web refresquen). */
  private ultimoCambio = Date.now();
  /** Secreto de firma: el configurado o uno nuevo por proceso, nunca el PIN. */
  private readonly jwtSecret: string;
  /** `pin:<ip>` / `login:<ip>` → instantes de los fallos dentro de la ventana. */
  private readonly fallos = new Map<string, number[]>();

  constructor(opts: LanServerOptions) {
    this.opts = opts;
    this.jwtSecret = opts.jwtSecret ?? randomBytes(32).toString('hex');
    this.log = opts.log ?? {
      info: (m) => console.info('[lan]', m),
      warn: (m) => console.warn('[lan]', m),
      error: (m) => console.error('[lan]', m),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const atender = (esTunel: boolean) => (req: IncomingMessage, res: ServerResponse) => {
        void this.handle(req, res, esTunel).catch((err: unknown) => {
          this.log.error(`error inesperado: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'Error interno' });
        });
      };
      // PUERTA DEL ACCESO REMOTO: una escucha atada a 127.0.0.1, que sólo puede
      // alcanzar el túnel corriendo en esta misma PC. "Vino de afuera" pasa a
      // ser una propiedad de POR DÓNDE ENTRÓ y no una suposición a partir de la
      // IP, que es lo que recomendaba el plan. Por esa puerta no se pide el PIN
      // de la red local (el dueño entra con su usuario y su contraseña); por la
      // otra, todo sigue igual.
      const abrirPuertaDelTunel = (alFallar: (err: unknown) => void, alAbrir?: () => void): void => {
        const st = createServer(atender(true));
        st.once('error', alFallar);
        st.listen(this.opts.tunnelPort, '127.0.0.1', () => {
          this.serverTunel = st;
          this.log.info(`acceso remoto escuchando en 127.0.0.1:${this.opts.tunnelPort}`);
          alAbrir?.();
        });
      };

      // Una sola PC: se abre la puerta del túnel y nada más. Sin escucha en
      // 0.0.0.0 y sin mDNS, así el acceso remoto no obliga al comercio a
      // publicar su sistema en la red del local.
      if (this.opts.soloTunel) {
        if (!this.opts.tunnelPort) {
          reject(new Error('soloTunel necesita tunnelPort'));
          return;
        }
        abrirPuertaDelTunel(reject, resolve);
        return;
      }

      const server = createServer(atender(false));
      server.once('error', reject);
      server.listen(this.opts.port, '0.0.0.0', () => {
        this.server = server;
        this.log.info(`escuchando en :${this.opts.port}`);
        if (this.opts.enableMdns) this.tryStartMdns();
        if (this.opts.tunnelPort) {
          abrirPuertaDelTunel((err) =>
            this.log.warn(`no se pudo abrir la puerta del acceso remoto: ${String(err)}`),
          );
        }
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.serverTunel) {
          this.serverTunel.close();
          this.serverTunel = null;
        }
        if (!this.server) return resolve();
        this.server.close(() => resolve());
        this.server = null;
      };
      if (this.bonjour) {
        try {
          this.bonjour.unpublishAll(() => finish());
          return;
        } catch {
          /* no-op */
        }
      }
      finish();
    });
  }

  /**
   * Puestos vistos últimamente, con lo que se sabe de cada uno. Sirve para el
   * panel de terminales: dice si hay comunicación y quién está trabajando en
   * cada máquina, que es lo que hace falta para diagnosticar sin ir a mirar.
   */
  getConnectedClients(): ClienteConectado[] {
    const now = Date.now();
    const result: ClienteConectado[] = [];
    for (const [clave, info] of this.clients) {
      if (now - info.lastSeen > PING_TTL_MS) {
        this.clients.delete(clave);
        continue;
      }
      result.push({
        ip: info.ip ?? clave,
        lastSeen: info.lastSeen,
        nombre: info.nombre ?? null,
        usuario: info.usuario ?? null,
        ultimaAccion: info.ultimaAccion ?? null,
        via: info.via ?? 'app',
        operaciones: info.operaciones ?? 0,
      });
    }
    return result.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * Por la puerta del túnel TODO llega desde 127.0.0.1: con esa clave, cada
   * PC de sucursal y cada visita pisaban la misma fila ("127.0.0.1"). Por el
   * túnel se agrupa por la red del visitante (la de `X-Forwarded-For`): cada
   * local, una fila.
   */
  private touchClient(req: IncomingMessage, extra?: Partial<InfoCliente>, esTunel = false): void {
    const remote = req.socket.remoteAddress ?? '';
    if (!remote || !isLanRemote(remote)) return;
    const clave = esTunel ? ipDelVisitante(req, true) : remote;
    const prev = this.clients.get(clave);
    this.clients.set(clave, {
      ip: clave,
      lastSeen: Date.now(),
      nombre: extra?.nombre ?? prev?.nombre,
      usuario: extra?.usuario ?? prev?.usuario,
      ultimaAccion: extra?.ultimaAccion ?? prev?.ultimaAccion,
      via: extra?.via ?? prev?.via ?? 'app',
      operaciones: (prev?.operaciones ?? 0) + (extra?.ultimaAccion ? 1 : 0),
    });
  }

  /**
   * Sirve la interfaz web. Cualquier ruta que no sea un archivo cae en
   * index.html, porque el ruteo lo hace la propia interfaz en el navegador.
   */
  private async servirEstatico(req: IncomingMessage, res: ServerResponse, esTunel = false): Promise<boolean> {
    const raiz = this.opts.webRoot;
    if (!raiz) return false;
    let pedido: string;
    try {
      pedido = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    } catch {
      // `%` suelto u otra secuencia inválida: no es un archivo, es basura.
      sendJson(res, 400, { ok: false, code: 'VALIDATION_ERROR', message: 'Ruta inválida' });
      return true;
    }
    if (pedido.startsWith('/lan/')) return false;

    const candidato = pedido === '/' ? 'index.html' : pedido.replace(/^\/+/, '');
    // Nunca salir de la carpeta servida: se compara con el separador puesto,
    // porque "/web/../web-electron/x" también "empieza con" "/web".
    const base = path.resolve(raiz);
    const destino = path.resolve(base, candidato);
    if (destino !== base && !destino.startsWith(base + path.sep)) {
      sendJson(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: 'Ruta inválida' });
      return true;
    }

    let archivo = destino;
    if (!existsSync(archivo) || statSync(archivo).isDirectory()) {
      archivo = path.join(raiz, 'index.html');
      if (!existsSync(archivo)) return false;
    }
    const ext = path.extname(archivo).toLowerCase();
    const tipos: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.pdf': 'application/pdf',
    };
    try {
      const contenido = await fsp.readFile(archivo);
      // El index.html va SIN CACHE (`no-store`, no `no-cache`): cada versión
      // renombra los archivos de la aplicación, así que una terminal que se
      // queda con el index viejo pide archivos que ya no existen y muestra
      // PANTALLA BLANCA. Con `no-cache` Chrome igual podía reusar la copia
      // guardada; `no-store` le prohíbe guardarla. Los demás archivos llevan el
      // hash en el nombre, así que se pueden cachear un año sin riesgo.
      const esHtml = ext === '.html';
      res.writeHead(200, {
        'Content-Type': tipos[ext] ?? 'application/octet-stream',
        'Cache-Control': esHtml
          ? 'no-store, no-cache, must-revalidate'
          : 'public, max-age=31536000, immutable',
        ...(esHtml ? { Pragma: 'no-cache', Expires: '0' } : {}),
        'Access-Control-Allow-Origin': '*',
      });
      res.end(contenido);
      this.touchClient(req, { via: 'navegador' }, esTunel);
      return true;
    } catch {
      return false;
    }
  }

  /** Marca que hubo un cambio de datos, para que los puestos web refresquen. */
  private marcarCambio(): void {
    this.ultimoCambio = Date.now();
  }

  /** Segundos que le faltan a `clave` para salir del bloqueo; 0 si no está bloqueada. */
  private segundosBloqueada(clave: string, max: number): number {
    const ahora = Date.now();
    const vivos = (this.fallos.get(clave) ?? []).filter((t) => ahora - t < VENTANA_FALLOS_MS);
    if (vivos.length === 0) this.fallos.delete(clave);
    else this.fallos.set(clave, vivos);
    if (vivos.length < max) return 0;
    // Se libera cuando el fallo más viejo de los que cuentan sale de la ventana.
    const masViejo = vivos[vivos.length - max]!;
    return Math.max(1, Math.ceil((masViejo + VENTANA_FALLOS_MS - ahora) / 1000));
  }

  private registrarFallo(clave: string): void {
    const lista = this.fallos.get(clave) ?? [];
    lista.push(Date.now());
    this.fallos.set(clave, lista);
  }

  private responderBloqueo(res: ServerResponse, segundos: number, que: string): void {
    // En minutos: "Espere 587 segundos" obliga a hacer la cuenta.
    const minutos = Math.max(1, Math.ceil(segundos / 60));
    sendJson(
      res,
      429,
      {
        ok: false,
        code: 'PERMISSION_DENIED',
        message: `Demasiados intentos de ${que} fallidos. Espere ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} y vuelva a intentar.`,
      },
      { 'retry-after': String(segundos) },
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse, esTunel = false): Promise<void> {
    // Fotos de facturas desde el teléfono: van antes que todo (incluido el
    // OPTIONS de abajo, que abre CORS) porque esas rutas no lo llevan.
    if (this.opts.rutaExtra && req.url?.startsWith('/lan/foto/')) {
      if (await this.opts.rutaExtra(req, res)) return;
    }
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === 'GET' && req.url === '/lan/ping') {
      this.touchClient(req, undefined, esTunel);
      sendJson(res, 200, {
        ok: true,
        timestamp: Date.now(),
        license: this.opts.licenseStatus ? this.opts.licenseStatus() : 'active',
        // La versión viaja acá para que los puestos por navegador puedan
        // mostrarla: en una pestaña no hay proceso de Electron al que
        // preguntarle, y el comercio necesita saber con qué versión trabaja
        // para reportar un problema.
        version: this.opts.appVersion ?? null,
        // La terminal manda sus encabezados de identidad SÓLO si el servidor
        // avisa que los admite: un servidor viejo los rechaza en la consulta
        // previa de CORS y la terminal nueva quedaría sin poder trabajar.
        identidad: true,
        // ¿Este servidor acepta PC de sucursal (edición Multisucursal)? El
        // diagnóstico de la terminal lo usa para no decir "emparejada" cuando
        // el comercio ya bajó de edición.
        sucursales: this.dispositivosVigentes() !== null,
      });
      return;
    }
    // Los puestos que entran por navegador preguntan acá si hubo cambios, para
    // refrescar la pantalla cuando otro puesto carga una venta (en la app
    // instalada eso llega por IPC, que en una pestaña no existe).
    if (req.method === 'GET' && req.url?.startsWith('/lan/changes')) {
      this.touchClient(req, { via: 'navegador' }, esTunel);
      const desde = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
      sendJson(res, 200, { changed: this.ultimoCambio > desde, at: this.ultimoCambio });
      return;
    }
    // La interfaz servida al navegador. Permite que una PC vieja (Windows 7,
    // donde Electron ya no arranca) trabaje sin instalar nada.
    if (req.method === 'GET' && this.opts.webRoot) {
      const servido = await this.servirEstatico(req, res, esTunel);
      if (servido) return;
    }
    // IDENTIDAD DE LA CASA CENTRAL: va con o sin la edición Multisucursal. Si
    // el comercio bajó de edición, su PC de sucursal tiene que poder seguir
    // trabajando como acceso remoto (lista corta, con el aviso de siempre), y
    // para eso primero comprueba que habla con su central.
    if (req.method === 'POST' && req.url === '/lan/central' && this.opts.dispositivos?.probarIdentidad) {
      await this.probarCentral(req, res, this.opts.dispositivos);
      return;
    }
    const dispositivos = this.dispositivosVigentes();
    if (req.method === 'POST' && req.url === '/lan/emparejar' && dispositivos) {
      await this.emparejar(req, res, esTunel, dispositivos);
      return;
    }
    if (req.method !== 'POST' || req.url !== '/lan/rpc') {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Ruta inexistente' });
      return;
    }
    const directa = req.socket.remoteAddress ?? '';
    // Contra quién se cuentan los intentos fallidos: por el túnel, la IP real
    // del visitante; por la red local, la de la terminal.
    const ipRemota = ipDelVisitante(req, esTunel);
    if (!isLanRemote(directa)) {
      this.log.warn(`origen rechazado (no-LAN): ${directa}`);
      sendJson(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: 'Origen no permitido' });
      return;
    }
    this.touchClient(req, undefined, esTunel);

    let parsed: RpcBody;
    try {
      const raw = await readBody(req);
      parsed = raw ? (JSON.parse(raw) as RpcBody) : {};
    } catch {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: 'Body inválido' });
      return;
    }

    // PC DE SUCURSAL EMPAREJADA: si manda token, tiene que ser válido. Uno
    // revocado o inventado NO cae a "visita sin token": se rechaza con un
    // mensaje que dice qué hacer.
    //
    // Orden: PRIMERO se verifica el token. Uno válido pasa siempre, aunque
    // desde esa IP pública (que comparten todas las PC de la sucursal) alguien
    // haya fallado: si no, una PC revocada que reintenta, o un encargado que
    // tipea mal el código, dejaba sin vender a la caja de al lado. Sólo los
    // tokens inválidos suman al contador (`token:<ip>`, aparte del canje de
    // códigos) y sólo a ellos los frena el bloqueo. Los tokens válidos son
    // 32 bytes al azar: no hay fuerza bruta posible contra ellos.
    let dispositivo: DispositivoVerificado | null = null;
    const tokenDispositivo = req.headers[HDR_DISPOSITIVO];
    const traeToken = typeof tokenDispositivo === 'string' && tokenDispositivo.length > 0;
    const origen: OrigenPedido = { ip: ipRemota, via: esTunel ? 'tunel' : 'lan' };
    if (dispositivos && traeToken) {
      dispositivo = dispositivos.verificar(tokenDispositivo as string, origen);
      if (!dispositivo) {
        const revocado = dispositivos.esRevocado?.(tokenDispositivo as string) ?? false;
        if (!revocado) {
          const bloqueo = this.segundosBloqueada(`token:${ipRemota}`, MAX_FALLOS_TOKEN);
          if (bloqueo > 0) {
            this.responderBloqueo(res, bloqueo, 'emparejamiento');
            return;
          }
          this.registrarFallo(`token:${ipRemota}`);
          dispositivos.registrarIncidente?.(
            `Token de PC de sucursal inválido (${ipRemota} ${esTunel ? 'por internet' : 'en la red local'})`,
            `token:${ipRemota}`,
          );
        } else {
          dispositivos.registrarIncidente?.(
            `Pedido de una PC de sucursal revocada (${ipRemota} ${esTunel ? 'por internet' : 'en la red local'})`,
            `revocado:${String(tokenDispositivo).split('.')[1] ?? ''}`,
          );
        }
        this.log.warn(`token de PC de sucursal ${revocado ? 'revocado' : 'inválido'} desde ${ipRemota}`);
        sendJson(res, 401, {
          ok: false,
          code: 'UNAUTHENTICATED',
          message: 'Esta PC ya no está autorizada en el servidor. Pida al administrador un código de emparejamiento nuevo.',
        });
        return;
      }
    }
    // Contador de intentos fallidos: con una PC emparejada se cuenta POR PC,
    // así un cajero que se equivoca no bloquea a toda la sucursal (que por el
    // túnel comparte IP pública). Sin token, por IP como siempre.
    const remote = dispositivo ? `disp:${dispositivo.id}` : ipRemota;

    // ACCESO REMOTO: por la puerta del túnel no se pide PIN. El PIN existe
    // para emparejar las terminales de la red local —es un número compartido
    // que el dueño no tiene por qué llevar a su casa—; desde afuera la puerta
    // es el usuario y la contraseña de siempre. Esa puerta está atada a
    // 127.0.0.1: desde la red local no se la puede alcanzar.
    if (!esTunel) {
      // El bloqueo por PIN aplica a TODO lo que venga de esa IP, acierte o no:
      // si el intento correcto pasara, el bloqueo no frenaría nada.
      const bloqueoPin = this.segundosBloqueada(`pin:${remote}`, MAX_FALLOS_PIN);
      if (bloqueoPin > 0) {
        this.responderBloqueo(res, bloqueoPin, 'PIN');
        return;
      }
      if (!mismoToken(parsed.token, this.opts.token)) {
        this.registrarFallo(`pin:${remote}`);
        this.log.warn(`PIN incorrecto desde ${remote}`);
        sendJson(res, 401, { ok: false, code: 'UNAUTHENTICATED', message: 'Token inválido' });
        return;
      }
      this.fallos.delete(`pin:${remote}`);
    }
    if (typeof parsed.channel !== 'string') {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: 'Canal requerido' });
      return;
    }
    const channel = parsed.channel;
    // Antes de mirar si el canal existe: lo que no cruza la red no cruza,
    // tenga el rol que tenga la sesión (licencia, updater, red, archivos del
    // servidor, restore, usuarios). Ver LAN_SERVER_DENIED_CHANNELS.
    if (!lanServerAccepts(channel)) {
      sendJson(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: 'Esa operación sólo puede hacerse en el servidor' });
      return;
    }
    // Desde INTERNET la lista es más corta que desde la red local: mirar,
    // vender y cobrar sí; tocar la configuración, facturar ante ARCA o mover
    // datos en bloque, no. Limita el daño si alguien consigue una contraseña.
    // Una PC de sucursal EMPAREJADA tiene la lista de la red local: es una
    // caja del comercio, no una visita (para eso se emparejó).
    // La lista de una PC emparejada es la corta MÁS facturar y cobrar con QR
    // (`dispositivoAccepts`): la configuración fiscal, la cuenta de Mercado
    // Pago, la ficha del comercio y lo que mueve datos en bloque siguen siendo
    // sólo del local.
    if (esTunel && (dispositivo ? !dispositivoAccepts(channel) : !remotoAccepts(channel))) {
      // PC que fue de sucursal en un comercio que ya no tiene la edición:
      // decirle por qué, para que soporte no busque la falla donde no está.
      const exSucursal = !dispositivo && traeToken && !dispositivos;
      sendJson(res, 403, {
        ok: false,
        code: 'PERMISSION_DENIED',
        message: exSucursal
          ? 'El comercio ya no tiene la licencia Multisucursal: esta PC trabaja como acceso remoto, sin facturación ni Mercado Pago'
          : dispositivo
            ? 'Esa operación sólo puede hacerse en el local, no desde una PC de sucursal'
            : 'Esa operación sólo puede hacerse desde el local, no por acceso remoto',
      });
      return;
    }
    const handler = Object.prototype.hasOwnProperty.call(this.opts.handlers, channel)
      ? this.opts.handlers[channel]
      : undefined;
    if (!handler) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `Canal no registrado: ${channel}` });
      return;
    }
    const licencia = this.opts.licenseStatus ? this.opts.licenseStatus() : 'active';
    if (licencia !== 'active' && esEscritura(channel)) {
      sendJson(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: mensajeSoloLectura(licencia) });
      return;
    }
    if (channel === 'auth:login') {
      const bloqueoLogin = this.segundosBloqueada(`login:${remote}`, MAX_FALLOS_LOGIN);
      if (bloqueoLogin > 0) {
        this.responderBloqueo(res, bloqueoLogin, 'inicio de sesión');
        return;
      }
    }

    // En tests / configuraciones sin sessionStore+resolveUser, el JWT no se
    // exige (sólo el PIN). En el server real ambos vienen seteados.
    const authIntegrationEnabled = !!(this.opts.sessionStore && this.opts.resolveUser);
    const needsAuth = authIntegrationEnabled && !NO_AUTH_CHANNELS.has(channel);
    let jwtUser: UserLite | null = null;
    if (needsAuth) {
      const authHdr = (req.headers['authorization'] ?? '') as string;
      const match = /^Bearer\s+(.+)$/.exec(authHdr.trim());
      if (!match) {
        sendJson(res, 401, { ok: false, code: 'UNAUTHENTICATED', message: 'No hay una sesión activa' });
        return;
      }
      const verified = verifyJwt(match[1] ?? '', this.jwtSecret);
      if (!verified) {
        sendJson(res, 401, { ok: false, code: 'UNAUTHENTICATED', message: 'Sesión expirada o inválida' });
        return;
      }
      // Una sesión iniciada desde una PC emparejada sólo vale desde ESA PC:
      // copiada a otra máquina (o usada sin el token) no habilita nada.
      if (verified.dis && verified.dis !== dispositivo?.id) {
        sendJson(res, 401, {
          ok: false,
          code: 'UNAUTHENTICATED',
          message: dispositivos
            ? 'La sesión no corresponde a esta PC'
            : 'El comercio ya no tiene la licencia Multisucursal. Inicie sesión de nuevo.',
        });
        return;
      }
      if (this.opts.resolveUser) {
        try {
          const u = await this.opts.resolveUser(verified.sub);
          if (!u || !u.active) {
            sendJson(res, 401, { ok: false, code: 'UNAUTHENTICATED', message: 'Usuario no disponible' });
            return;
          }
          jwtUser = u;
        } catch (err) {
          this.log.error(`resolveUser falló: ${err instanceof Error ? err.message : String(err)}`);
          sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'Error resolviendo sesión' });
          return;
        }
      }
    }

    // Queda registrado quién trabaja en cada puesto y qué hizo último, para
    // que el panel de terminales sirva de verdad para diagnosticar.
    const terminal = this.terminalDelPedido(req, esTunel, ipRemota, dispositivo);
    this.touchClient(
      req,
      {
        nombre: dispositivo?.nombre ?? limpiarNombreTerminal(req.headers[HDR_TERMINAL_NOMBRE]) ?? undefined,
        usuario: (jwtUser as { fullName?: string; username?: string } | null)?.fullName
          ?? (jwtUser as { username?: string } | null)?.username,
        ultimaAccion: channel,
        via: viaDelPedido(req),
      },
      esTunel,
    );

    try {
      let response: IpcResponse<unknown>;
      // Cada handler corre "como" la terminal que hizo el pedido: ver
      // obtenerTerminalActual (electron/ipc/terminal-actual.ts).
      const correr = (fn: () => Promise<IpcResponse<unknown>>): Promise<IpcResponse<unknown>> =>
        correrComoTerminal(terminal, fn);
      if (needsAuth && jwtUser && this.opts.sessionStore) {
        const store = this.opts.sessionStore;
        response = await correr(
          () =>
            store.runWith(
              jwtUser as unknown as Parameters<SessionStore['runWith']>[0],
              'lan-impersonation',
              () => handler(parsed.payload) as Promise<IpcResponse<unknown>>,
            ) as Promise<IpcResponse<unknown>>,
        );
      } else if (this.opts.sessionStore) {
        // Canales sin JWT (auth:login/logout): también AISLADOS. Si corrieran
        // fuera del ALS, el setSession/clearSession de esos handlers escribiría
        // el singleton y pisaría la sesión del usuario del escritorio.
        const store = this.opts.sessionStore;
        response = await correr(
          () => store.runDetached(() => handler(parsed.payload) as Promise<IpcResponse<unknown>>) as Promise<IpcResponse<unknown>>,
        );
      } else {
        response = await correr(() => handler(parsed.payload) as Promise<IpcResponse<unknown>>);
      }

      // Si fue una escritura, avisar a los puestos web que refresquen.
      if (response.ok && /^(create|update|delete|void|add|receive|pay|transfer|open|close|apply|adjust|register|reset)/i.test(channel.split(':')[1] ?? '')) {
        this.marcarCambio();
      }

      // En auth:login ok: firmar JWT y adjuntarlo al data.
      if (channel === 'auth:login') {
        if (response.ok) {
          this.fallos.delete(`login:${remote}`);
          const data = response.data as { user?: { id?: string } };
          if (data?.user?.id) {
            const expiresIn = this.opts.jwtExpiresInSec ?? 12 * 60 * 60;
            const exp = Math.floor(Date.now() / 1000) + expiresIn;
            // Con PC emparejada, la sesión queda atada a ella (`dis`).
            const jwt = signJwt(
              dispositivo ? { sub: data.user.id, exp, dis: dispositivo.id } : { sub: data.user.id, exp },
              this.jwtSecret,
            );
            response = { ok: true, data: { ...data, _lanSessionToken: jwt } };
          }
        } else {
          this.registrarFallo(`login:${remote}`);
        }
      }
      await sendJsonRpc(req, res, 200, response);
    } catch (err) {
      this.log.error(`handler '${channel}' tiró: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'Error interno del handler' });
    }
  }

  /** El servicio de PC de sucursal, si existe y la edición lo habilita. */
  private dispositivosVigentes(): DispositivosLike | null {
    if (!this.opts.dispositivos) return null;
    try {
      if (this.opts.multisucursalActivo && !this.opts.multisucursalActivo()) return null;
    } catch {
      return null;
    }
    return this.opts.dispositivos;
  }

  /**
   * Quién hizo el pedido, para `obtenerTerminalActual`.
   *  - PC emparejada: `disp:<machineId registrado>` (no lo que diga el
   *    encabezado). El prefijo no lo puede declarar nadie más.
   *  - Por el TÚNEL sin PC emparejada (dueño desde su casa o una contraseña
   *    robada): el encabezado se ignora y opera como esta PC, igual que antes
   *    de la caja por PC. Declarar el id de una caja ajena no sirve de nada.
   *  - En la red local: lo que declara la terminal (el PIN es compartido; es
   *    el mismo nivel de confianza de siempre).
   *  - Sin declarar nada (versión vieja): esta PC, con `identificada: false`.
   */
  private terminalDelPedido(
    req: IncomingMessage,
    esTunel: boolean,
    ipRemota: string,
    dispositivo: DispositivoVerificado | null,
  ): TerminalActual {
    const origen = esTunel ? 'tunel' : 'lan';
    if (dispositivo) {
      return {
        id: idTerminalDeDispositivo(dispositivo.machineId),
        nombre: dispositivo.nombre,
        origen,
        dispositivoId: dispositivo.id,
        identificada: true,
      };
    }
    if (esTunel) {
      return { id: this.opts.machineId ?? 'servidor', nombre: ipRemota, origen, dispositivoId: null, identificada: false };
    }
    const id = limpiarIdTerminal(req.headers[HDR_TERMINAL]);
    if (id) {
      const nombre = limpiarNombreTerminal(req.headers[HDR_TERMINAL_NOMBRE]) ?? ipRemota;
      return { id, nombre, origen, dispositivoId: null, identificada: true };
    }
    return { id: this.opts.machineId ?? 'servidor', nombre: ipRemota, origen, dispositivoId: null, identificada: false };
  }

  /**
   * `POST /lan/central { dispositivoId, nonce }` → `{ ok, prueba }`, o 404 con
   * `motivo: 'desconocida'` si esa PC no figura en esta base (por ejemplo, la
   * central volvió a una copia vieja de sus datos). La prueba no sirve para
   * entrar ni para firmar pedidos: sólo dice "soy la central de esa PC".
   */
  private async probarCentral(req: IncomingMessage, res: ServerResponse, dispositivos: DispositivosLike): Promise<void> {
    if (!isLanRemote(req.socket.remoteAddress ?? '')) {
      sendJson(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: 'Origen no permitido' });
      return;
    }
    let body: { dispositivoId?: unknown; nonce?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: 'Body inválido' });
      return;
    }
    let prueba: string | null = null;
    try {
      prueba = dispositivos.probarIdentidad?.(body?.dispositivoId, body?.nonce) ?? null;
    } catch (err) {
      this.log.error(`prueba de identidad: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!prueba) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', motivo: 'desconocida', message: 'Esta PC no figura en la casa central' });
      return;
    }
    sendJson(res, 200, { ok: true, prueba });
  }

  /**
   * `POST /lan/emparejar { codigo, nombre, machineId }` → `{ ok, data: { token, dispositivoId, nombre } }`.
   * Lo llama la PC de sucursal una sola vez. El código es la credencial (no se
   * pide PIN ni sesión); los canjes fallidos se cuentan por IP y a los 5 el
   * servidor contesta 429 por 10 minutos: 50 bits de código no se adivinan así.
   */
  private async emparejar(
    req: IncomingMessage,
    res: ServerResponse,
    esTunel: boolean,
    dispositivos: DispositivosLike,
  ): Promise<void> {
    const directa = req.socket.remoteAddress ?? '';
    if (!isLanRemote(directa)) {
      sendJson(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: 'Origen no permitido' });
      return;
    }
    const ip = ipDelVisitante(req, esTunel);
    const clave = `emparejar:${ip}`;
    const bloqueo = this.segundosBloqueada(clave, MAX_FALLOS_EMPAREJAR);
    if (bloqueo > 0) {
      this.responderBloqueo(res, bloqueo, 'emparejamiento');
      return;
    }
    let body: { codigo?: unknown; nombre?: unknown; machineId?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: 'Body inválido' });
      return;
    }
    const r = dispositivos.canjear(
      { codigo: body?.codigo, nombre: body?.nombre, machineId: body?.machineId },
      { ip, via: esTunel ? 'tunel' : 'lan' },
    );
    if (!r.ok) {
      if (r.motivo === 'datos') {
        sendJson(res, 400, { ok: false, code: 'VALIDATION', message: 'Faltan el nombre o el identificador de la PC' });
        return;
      }
      // Código bueno, pero esa PC ya tiene un emparejamiento activo. No es un
      // intento de adivinar (el código era válido): no suma al bloqueo.
      if (r.motivo === 'ocupado') {
        sendJson(res, 409, {
          ok: false,
          code: 'CONFLICT',
          message:
            'Esta PC ya está emparejada con el servidor. Para emparejarla de nuevo, revóquela primero en el servidor (Configuración → Red local → PC de sucursal) y vuelva a cargar el mismo código.',
        });
        return;
      }
      this.registrarFallo(clave);
      dispositivos.registrarIncidente?.(
        `Canje de código de emparejamiento fallido (${r.motivo === 'vencido' ? 'vencido' : 'inválido'}) desde ${ip} ${esTunel ? 'por internet' : 'en la red local'}`,
      );
      this.log.warn(`canje de código de emparejamiento fallido (${r.motivo}) desde ${ip}`);
      sendJson(res, 401, {
        ok: false,
        code: 'UNAUTHENTICATED',
        // Para que la PC nueva diga cuál de los dos es sin depender del texto.
        motivo: r.motivo === 'vencido' ? 'vencido' : 'invalido',
        message:
          r.motivo === 'vencido'
            ? 'El código de emparejamiento venció. Genere uno nuevo en el servidor.'
            : 'El código de emparejamiento no es válido o ya se usó.',
      });
      return;
    }
    this.fallos.delete(clave);
    this.log.info(`PC de sucursal emparejada: ${r.nombre}`);
    sendJson(res, 200, { ok: true, data: { token: r.token, dispositivoId: r.dispositivoId, nombre: r.nombre } });
  }

  private tryStartMdns(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('bonjour-service') as { Bonjour?: new () => { publish: (opts: object) => unknown; unpublishAll: (cb?: () => void) => void } };
      if (!mod.Bonjour) return;
      const instance = new mod.Bonjour();
      instance.publish({
        name: 'StockFlow',
        type: 'http',
        port: this.opts.port,
        txt: { app: 'stockflow' },
      });
      this.bonjour = instance;
      this.log.info('mDNS publicado como stockflow._http._tcp');
    } catch {
      this.log.warn('mDNS no disponible (bonjour-service no instalado); seguimos sin broadcast');
    }
  }
}
