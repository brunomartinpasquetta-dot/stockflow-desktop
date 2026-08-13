/**
 * Servidor LAN embebido para el modo multi-caja.
 *
 * Expone:
 *  - `POST /lan/rpc { channel, payload, token }` — RPC sobre los handlers IPC.
 *  - `GET  /lan/ping` — keepalive sin auth (registra al cliente).
 *
 * Auth en /lan/rpc:
 *  - `token` (PIN) en el body: identifica al "tenant" (suficiente para LAN).
 *  - `Authorization: Bearer <jwt>`: identifica la SESIÓN del usuario logueado
 *    en la caja cliente. La firma del JWT usa HMAC-SHA256 con secret derivado
 *    del PIN. Se exige para todos los canales excepto `auth:login`/`auth:logout`.
 *  - El handler `auth:login` que devuelve `{ user, sessionToken }` se intercepta
 *    en este server para **firmar** un JWT (sub=user.id, exp=12h) y agregarlo
 *    al data como `_lanSessionToken`. El cliente lo cachea (preload).
 *  - Antes de cada handler con JWT válido, hacemos `sessionStore.runWith(user)`
 *    para que `withSession(deps,...)` vea ese user como sesión activa durante
 *    el lifetime del RPC. `runWith` AÍSLA la sesión por invocación vía
 *    AsyncLocalStorage: RPCs concurrentes nunca comparten `currentUser`, y la
 *    sesión local del proceso (caja servidor) queda intacta.
 *
 * Decisiones:
 *  - `node:http` (sin Fastify) para no inflar el bundle.
 *  - JWT inline (HS256) con `crypto.createHmac`. Cero deps nuevas.
 *  - mDNS via `bonjour-service` cargado dinámicamente (opcional).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync, promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { HandlerMap } from '../ipc/handler-context';
import type { SessionStore } from '../ipc/session-store';
import type { IpcResponse } from '../ipc/types';

interface InfoCliente {
  lastSeen: number;
  usuario?: string;
  ultimaAccion?: string;
  via?: 'app' | 'navegador';
  operaciones?: number;
}

export interface ClienteConectado {
  ip: string;
  lastSeen: number;
  usuario: string | null;
  ultimaAccion: string | null;
  via: 'app' | 'navegador';
  operaciones: number;
}

export interface LanServerOptions {
  handlers: HandlerMap;
  port: number;
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
   * Estado de la licencia de ESTE servidor. Los puestos conectados no tienen
   * licencia propia: trabajan amparados por la del servidor (una licencia por
   * comercio), así que necesitan poder consultarla.
   */
  licenseStatus?: () => 'active' | 'readOnly' | 'unlicensed' | 'revoked';
  /** Versión del servidor, para que los puestos por navegador la muestren. */
  appVersion?: string;
  /** Carpeta con la interfaz compilada, para servirla al navegador. */
  webRoot?: string;
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

/** Verifica firma + exp. Devuelve el payload decoded o null si inválido. */
export function verifyJwt(token: string, secret: string): { sub: string; exp: number } | null {
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
  let parsed: { sub?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number') return null;
  if (Date.now() / 1000 >= parsed.exp) return null;
  return { sub: parsed.sub, exp: parsed.exp };
}

function isLanRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (addr.startsWith('10.') || addr.startsWith('192.168.')) return true;
  if (addr.startsWith('172.')) {
    const second = Number(addr.split('.')[1] ?? '0');
    return second >= 16 && second <= 31;
  }
  if (addr.startsWith('::ffff:')) return isLanRemote(addr.slice('::ffff:'.length));
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,GET,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
  });
  res.end(JSON.stringify(body));
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
  private bonjour: { unpublishAll: (cb?: () => void) => void } | null = null;
  private bonjourService: { stop: (cb?: () => void) => void } | null = null;
  private readonly log: NonNullable<LanServerOptions['log']>;
  /** ip -> lastSeen ms; ping y rpc actualizan. */
  private readonly clients = new Map<string, InfoCliente>();
  /** Última vez que cambiaron los datos (para que los puestos web refresquen). */
  private ultimoCambio = Date.now();

  constructor(opts: LanServerOptions) {
    this.opts = opts;
    this.log = opts.log ?? {
      info: (m) => console.info('[lan]', m),
      warn: (m) => console.warn('[lan]', m),
      error: (m) => console.error('[lan]', m),
    };
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((err: unknown) => {
          this.log.error(`error inesperado: ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'Error interno' });
        });
      });
      server.once('error', reject);
      server.listen(this.opts.port, '0.0.0.0', () => {
        this.server = server;
        this.log.info(`escuchando en :${this.opts.port}`);
        if (this.opts.enableMdns) this.tryStartMdns();
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
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
    for (const [ip, info] of this.clients) {
      if (now - info.lastSeen > PING_TTL_MS) {
        this.clients.delete(ip);
        continue;
      }
      result.push({
        ip,
        lastSeen: info.lastSeen,
        usuario: info.usuario ?? null,
        ultimaAccion: info.ultimaAccion ?? null,
        via: info.via ?? 'app',
        operaciones: info.operaciones ?? 0,
      });
    }
    return result.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  private touchClient(req: IncomingMessage, extra?: Partial<InfoCliente>): void {
    const remote = req.socket.remoteAddress ?? '';
    if (!remote || !isLanRemote(remote)) return;
    const prev = this.clients.get(remote);
    this.clients.set(remote, {
      lastSeen: Date.now(),
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
  private async servirEstatico(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const raiz = this.opts.webRoot;
    if (!raiz) return false;
    const pedido = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    if (pedido.startsWith('/lan/')) return false;

    const candidato = pedido === '/' ? 'index.html' : pedido.replace(/^\/+/, '');
    // Nunca salir de la carpeta servida.
    const destino = path.resolve(raiz, candidato);
    if (!destino.startsWith(path.resolve(raiz))) {
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
      this.touchClient(req, { via: 'navegador' });
      return true;
    } catch {
      return false;
    }
  }

  /** Marca que hubo un cambio de datos, para que los puestos web refresquen. */
  private marcarCambio(): void {
    this.ultimoCambio = Date.now();
  }

  private get jwtSecret(): string {
    return `${this.opts.token}:stockflow-lan-jwt`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === 'GET' && req.url === '/lan/ping') {
      this.touchClient(req);
      sendJson(res, 200, {
        ok: true,
        timestamp: Date.now(),
        license: this.opts.licenseStatus ? this.opts.licenseStatus() : 'active',
        // La versión viaja acá para que los puestos por navegador puedan
        // mostrarla: en una pestaña no hay proceso de Electron al que
        // preguntarle, y el comercio necesita saber con qué versión trabaja
        // para reportar un problema.
        version: this.opts.appVersion ?? null,
      });
      return;
    }
    // Los puestos que entran por navegador preguntan acá si hubo cambios, para
    // refrescar la pantalla cuando otro puesto carga una venta (en la app
    // instalada eso llega por IPC, que en una pestaña no existe).
    if (req.method === 'GET' && req.url?.startsWith('/lan/changes')) {
      this.touchClient(req, { via: 'navegador' });
      const desde = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
      sendJson(res, 200, { changed: this.ultimoCambio > desde, at: this.ultimoCambio });
      return;
    }
    // La interfaz servida al navegador. Permite que una PC vieja (Windows 7,
    // donde Electron ya no arranca) trabaje sin instalar nada.
    if (req.method === 'GET' && this.opts.webRoot) {
      const servido = await this.servirEstatico(req, res);
      if (servido) return;
    }
    if (req.method !== 'POST' || req.url !== '/lan/rpc') {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Ruta inexistente' });
      return;
    }
    const remote = req.socket.remoteAddress ?? '';
    if (!isLanRemote(remote)) {
      this.log.warn(`origen rechazado (no-LAN): ${remote}`);
      sendJson(res, 403, { ok: false, code: 'PERMISSION_DENIED', message: 'Origen no permitido' });
      return;
    }
    this.touchClient(req);

    let parsed: RpcBody;
    try {
      const raw = await readBody(req);
      parsed = raw ? (JSON.parse(raw) as RpcBody) : {};
    } catch {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: 'Body inválido' });
      return;
    }

    if (typeof parsed.token !== 'string' || parsed.token !== this.opts.token) {
      sendJson(res, 401, { ok: false, code: 'UNAUTHENTICATED', message: 'Token inválido' });
      return;
    }
    if (typeof parsed.channel !== 'string') {
      sendJson(res, 400, { ok: false, code: 'VALIDATION', message: 'Canal requerido' });
      return;
    }
    const channel = parsed.channel;
    const handler = this.opts.handlers[channel];
    if (!handler) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `Canal no registrado: ${channel}` });
      return;
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
    this.touchClient(req, {
      usuario: (jwtUser as { fullName?: string; username?: string } | null)?.fullName
        ?? (jwtUser as { username?: string } | null)?.username,
      ultimaAccion: channel,
      via: /Mozilla/i.test(String(req.headers['user-agent'] ?? '')) ? 'navegador' : 'app',
    });

    try {
      let response: IpcResponse<unknown>;
      if (needsAuth && jwtUser && this.opts.sessionStore) {
        response = (await this.opts.sessionStore.runWith(
          jwtUser as unknown as Parameters<SessionStore['runWith']>[0],
          'lan-impersonation',
          () => handler(parsed.payload) as Promise<IpcResponse<unknown>>,
        )) as IpcResponse<unknown>;
      } else {
        response = (await handler(parsed.payload)) as IpcResponse<unknown>;
      }

      // Si fue una escritura, avisar a los puestos web que refresquen.
      if (response.ok && /^(create|update|delete|void|add|receive|pay|transfer|open|close|apply|adjust|register|reset)/i.test(channel.split(':')[1] ?? '')) {
        this.marcarCambio();
      }

      // En auth:login ok: firmar JWT y adjuntarlo al data.
      if (channel === 'auth:login' && response.ok) {
        const data = response.data as { user?: { id?: string } };
        if (data?.user?.id) {
          const expiresIn = this.opts.jwtExpiresInSec ?? 12 * 60 * 60;
          const exp = Math.floor(Date.now() / 1000) + expiresIn;
          const jwt = signJwt({ sub: data.user.id, exp }, this.jwtSecret);
          response = { ok: true, data: { ...data, _lanSessionToken: jwt } };
        }
      }
      sendJson(res, 200, response);
    } catch (err) {
      this.log.error(`handler '${channel}' tiró: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'Error interno del handler' });
    }
  }

  private tryStartMdns(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('bonjour-service') as { Bonjour?: new () => { publish: (opts: object) => unknown; unpublishAll: (cb?: () => void) => void } };
      if (!mod.Bonjour) return;
      const instance = new mod.Bonjour();
      const service = instance.publish({
        name: 'StockFlow',
        type: 'http',
        port: this.opts.port,
        txt: { app: 'stockflow' },
      }) as { stop: (cb?: () => void) => void };
      this.bonjour = instance;
      this.bonjourService = service;
      this.log.info('mDNS publicado como stockflow._http._tcp');
    } catch {
      this.log.warn('mDNS no disponible (bonjour-service no instalado); seguimos sin broadcast');
    }
  }
}
