/**
 * Servidor LAN embebido para el modo multi-caja.
 *
 * Expone `POST /lan/rpc { channel, payload, token }` que valida un PIN
 * compartido y delega en el `HandlerMap` ya construido por `buildAllHandlers`.
 * Reutiliza los mismos handlers que sirve `ipcMain.handle` en modo single PC,
 * de modo que la lógica de negocio es idéntica.
 *
 * Decisiones:
 *  - Usa `node:http` en lugar de Fastify para no agregar dependencias al
 *    bundle nativo de Electron. La superficie de la API es minúscula (1 ruta)
 *    y no necesitamos plugins.
 *  - CORS abierto: el endpoint exige el `token` en el body, así que sólo
 *    clientes con el PIN pueden invocarlo. El bind ya se restringe a IPs LAN
 *    cuando el SO lo permite (escuchamos en 0.0.0.0 — el firewall del SO es
 *    la primera barrera).
 *  - mDNS (bonjour-service) es OPCIONAL: se carga con `require` dinámico; si
 *    no está instalado, el server arranca sin broadcast.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { HandlerMap } from '../ipc/handler-context';
import type { IpcResponse } from '../ipc/types';

export interface LanServerOptions {
  handlers: HandlerMap;
  port: number;
  token: string;
  /** Logger opcional (default: console). */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  /** Si true, intenta publicar el servicio por mDNS (bonjour-service). */
  enableMdns?: boolean;
}

interface RpcBody {
  channel?: unknown;
  payload?: unknown;
  token?: unknown;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

function isLanRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  // Acepta loopback y rangos privados RFC1918. Para 172.16/12 hace falta
  // chequear el segundo octeto.
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (addr.startsWith('10.') || addr.startsWith('192.168.')) return true;
  if (addr.startsWith('172.')) {
    const second = Number(addr.split('.')[1] ?? '0');
    return second >= 16 && second <= 31;
  }
  // IPv6 mapeada a IPv4 (::ffff:192.168.x.x)
  if (addr.startsWith('::ffff:')) return isLanRemote(addr.slice('::ffff:'.length));
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
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

export class LanServer {
  private readonly opts: LanServerOptions;
  private server: Server | null = null;
  private bonjour: { unpublishAll: (cb?: () => void) => void } | null = null;
  private bonjourService: { stop: (cb?: () => void) => void } | null = null;
  private readonly log: NonNullable<LanServerOptions['log']>;

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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      sendJson(res, 204, {});
      return;
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
    const handler = this.opts.handlers[parsed.channel];
    if (!handler) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `Canal no registrado: ${parsed.channel}` });
      return;
    }
    try {
      const response = (await handler(parsed.payload)) as IpcResponse<unknown>;
      sendJson(res, 200, response);
    } catch (err) {
      this.log.error(`handler '${parsed.channel}' tiró: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { ok: false, code: 'INTERNAL', message: 'Error interno del handler' });
    }
  }

  private tryStartMdns(): void {
    try {
      // Carga dinámica: si `bonjour-service` no está disponible, ignoramos.
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
