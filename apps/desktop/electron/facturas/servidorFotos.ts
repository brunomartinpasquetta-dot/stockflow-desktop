/**
 * Rutas HTTP por las que el teléfono manda las fotos de una factura.
 *
 *  - `GET  /lan/foto/<token>`         → la página del teléfono (paginaTelefono.ts).
 *  - `POST /lan/foto/<token>/hoja`    → una hoja; el cuerpo es el JPEG crudo. Si la foto no sirve
 *                                       para leer contesta 422 `FOTO` con el motivo y la hoja NO se
 *                                       agrega; con `?forzar=1` ("Usar igual") se acepta igual.
 *                                       Si todavía se está leyendo la hoja anterior de ese enlace
 *                                       contesta 429 `OCUPADO` SIN leer el cuerpo (de a una por enlace).
 *  - `POST /lan/foto/<token>/quitar`  → saca la última hoja recibida (si el servicio lo ofrece).
 *  - `POST /lan/foto/<token>/cerrar`  → no hay más hojas: la factura pasa a la cola de lectura.
 *  - `GET  /lan/foto/<token>/estado`  → cómo va la lectura (lo sondea la página).
 *
 * La única credencial es el token del enlace (32 hex, vence solo): lo recibe
 * el teléfono al escanear el QR. Por eso:
 *  - el token se valida ANTES de leer un solo byte del cuerpo: quien no lo
 *    tiene no puede hacerle guardar 12 MB en memoria al servidor;
 *  - token inválido, vencido o función apagada contestan lo MISMO (404
 *    "El enlace venció"): desde afuera no se distingue un caso del otro, ni
 *    se sabe si este comercio usa la función;
 *  - no se manda ninguna cabecera CORS: la página se sirve desde el mismo
 *    origen, así que ningún otro sitio abierto en el teléfono puede leer las
 *    respuestas;
 *  - nada se cachea (`no-store`) y nada del sistema se lista ni se devuelve:
 *    del servicio salen sólo contadores y el estado.
 *
 * Este archivo no conoce al servicio: trabaja contra `PuertaFotos`, que es lo
 * mínimo que necesita de él. Así se prueba solo, con una puerta falsa.
 *
 * `atenderFotos` sirve tanto para colgarse de LanServer (`rutaExtra`, que
 * además lo deja salir por el túnel) como para `ServidorFotos`, la escucha
 * propia que se usa en el comercio de una sola PC, donde LanServer no escucha
 * en la red del local.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { paginaTelefono, paginaVencido } from './paginaTelefono';

/** Lo que estas rutas necesitan del servicio de facturas por teléfono. */
export interface PuertaFotos {
  /** La opción está activada. Apagada, todo contesta 404. */
  activo(): boolean;
  validarToken(token: string): boolean;
  /**
   * Agrega una hoja. Si la foto no sirve para leer (borrosa, cortada, torcida)
   * tira un error con `tipo: 'foto'` y el motivo como mensaje, salvo `forzar`.
   */
  recibirFoto(token: string, jpeg: Buffer, opciones?: { forzar?: boolean }): Promise<{ hojas: number }>;
  /**
   * ¿Se puede recibir otra hoja de este enlace ahora? false = todavía se está
   * leyendo la anterior: se contesta 429 sin leer el cuerpo (si el servicio lo ofrece).
   */
  puedeRecibir?(token: string): boolean;
  quitarUltimaFoto?(token: string): Promise<{ hojas: number }>;
  cerrarFactura(token: string): Promise<{ id: string }>;
  estadoParaTelefono(token: string): {
    factura: null | { estado: string; hojas: number; hojasLeidas: number; error: string | null; lento?: boolean };
  };
}

export type RutaFotos = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type Log = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export const PREFIJO_FOTOS = '/lan/foto/';
export const PUERTO_FOTOS = 7790;
/** Tope por foto. La página manda ~0,5–1,5 MB; 12 MB cubre una foto sin reducir. */
export const MAX_FOTO_BYTES = 12 * 1024 * 1024;
/** Si el teléfono deja de mandar a mitad de una foto, no se lo espera para siempre. */
const ESPERA_CUERPO_MS = 30_000;

const FORMATO_TOKEN = /^[0-9a-f]{32}$/;

const CABECERAS_COMUNES: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
};

/**
 * La página sólo puede correr su propio script, mostrar las miniaturas que
 * ella misma arma, reproducir la cámara en vivo (blob: en media-src, para los
 * navegadores que todavía la enchufan por URL) y hablar con el servidor que la
 * sirvió. Nada de afuera.
 */
const CSP_PAGINA =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

function enviarJson(res: ServerResponse, status: number, cuerpo: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...CABECERAS_COMUNES, 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(cuerpo));
}

function enviarHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    ...CABECERAS_COMUNES,
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CSP_PAGINA,
  });
  res.end(html);
}

function enviarError(res: ServerResponse, status: number, code: string, message: string, extra: Record<string, string> = {}): void {
  enviarJson(res, status, { ok: false, code, message }, extra);
}

/** 404 único para token malo, vencido o función apagada. */
function enviarVencido(res: ServerResponse, comoPagina: boolean): void {
  if (comoPagina) enviarHtml(res, 404, paginaVencido());
  else enviarError(res, 404, 'NOT_FOUND', 'El enlace venció');
}

type Cuerpo = { ok: true; datos: Buffer } | { ok: false; motivo: 'excedido' | 'lento' | 'cortado' };

/**
 * Junta el cuerpo binario hasta `tope` bytes. Si el teléfono declara de
 * entrada más que el tope no se lee nada; si se pasa por el camino, se deja de
 * leer ahí mismo (quien llama corta la conexión).
 */
function leerCuerpo(req: IncomingMessage, tope: number): Promise<Cuerpo> {
  return new Promise((resolve) => {
    const declarado = Number(req.headers['content-length']);
    if (Number.isFinite(declarado) && declarado > tope) {
      resolve({ ok: false, motivo: 'excedido' });
      return;
    }
    const trozos: Buffer[] = [];
    let total = 0;
    let listo = false;
    let reloj: NodeJS.Timeout | null = null;
    const terminar = (r: Cuerpo): void => {
      if (listo) return;
      listo = true;
      if (reloj) clearTimeout(reloj);
      req.off('data', alDato);
      resolve(r);
    };
    const rearmar = (): void => {
      if (reloj) clearTimeout(reloj);
      reloj = setTimeout(() => terminar({ ok: false, motivo: 'lento' }), ESPERA_CUERPO_MS);
    };
    const alDato = (trozo: Buffer): void => {
      total += trozo.length;
      if (total > tope) {
        req.pause();
        terminar({ ok: false, motivo: 'excedido' });
        return;
      }
      trozos.push(trozo);
      rearmar();
    };
    rearmar();
    req.on('data', alDato);
    req.once('end', () => terminar({ ok: true, datos: Buffer.concat(trozos, total) }));
    req.once('error', () => terminar({ ok: false, motivo: 'cortado' }));
    req.once('close', () => terminar({ ok: false, motivo: 'cortado' }));
  });
}

/** Contesta y cierra la conexión: lo que el teléfono siga mandando no se lee. */
function cortar(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent || res.destroyed) {
    req.socket.destroy();
    return;
  }
  const cuerpo = JSON.stringify({ ok: false, code, message });
  res.writeHead(status, { ...CABECERAS_COMUNES, 'content-type': 'application/json; charset=utf-8', connection: 'close' });
  res.end(cuerpo, () => req.socket.destroy());
}

/**
 * Mensaje de un error del servicio que se le puede mostrar al teléfono. Los
 * del servicio son textos pensados para el usuario ("La factura ya tiene 12
 * hojas"); los del sistema (ENOENT, EACCES…) traen rutas de la PC y no salen.
 */
function mensajeParaTelefono(err: unknown, generico: string, largoMaximo = 200): string {
  if (!(err instanceof Error)) return generico;
  const codigo = (err as { code?: unknown }).code;
  if (typeof codigo === 'string' && /^E[A-Z0-9_]+$/.test(codigo)) return generico;
  const m = err.message.trim();
  if (!m || m.length > largoMaximo || /[\\/]|\n/.test(m)) return generico;
  return m;
}

/** ¿El servicio rechazó la foto por su calidad? (`FacturasError` con `tipo: 'foto'`). */
function esFotoMala(err: unknown): boolean {
  return err instanceof Error && (err as { tipo?: unknown }).tipo === 'foto';
}

/** ¿El servicio todavía está leyendo la hoja anterior? (`FacturasError` con `tipo: 'ocupado'`). */
function estaOcupado(err: unknown): boolean {
  return err instanceof Error && (err as { tipo?: unknown }).tipo === 'ocupado';
}

const MENSAJE_OCUPADO = 'Espere a que termine de enviarse la hoja anterior.';

export function atenderFotos(puerta: PuertaFotos, log?: Log): RutaFotos {
  return async (req, res) => {
    const [ruta = '', consulta = ''] = (req.url ?? '').split('?');
    if (!ruta.startsWith(PREFIJO_FOTOS)) return false;

    const partes = ruta.slice(PREFIJO_FOTOS.length).split('/');
    if (partes.length > 1 && partes[partes.length - 1] === '') partes.pop(); // barra final
    const token = partes[0] ?? '';
    const accion = partes.length === 1 ? '' : partes.length === 2 ? (partes[1] ?? '') : '?';
    const metodo = req.method ?? 'GET';
    const esPagina = accion === '' && (metodo === 'GET' || metodo === 'HEAD');

    try {
      if (!FORMATO_TOKEN.test(token) || !puerta.activo() || !puerta.validarToken(token)) {
        // Sin leer el cuerpo: si venía una foto, se contesta y se corta.
        if (metodo === 'GET' || metodo === 'HEAD') enviarVencido(res, esPagina);
        else cortar(req, res, 404, 'NOT_FOUND', 'El enlace venció');
        return true;
      }

      if (accion === '') {
        if (!esPagina) {
          enviarError(res, 405, 'METHOD_NOT_ALLOWED', 'Método no permitido', { allow: 'GET' });
          return true;
        }
        enviarHtml(res, 200, paginaTelefono());
        return true;
      }

      if (accion === 'estado' && metodo === 'GET') {
        const f = puerta.estadoParaTelefono(token).factura;
        // Se copian los campos uno por uno: si el servicio agrega otros a su
        // objeto, no salen por acá sin que alguien lo decida.
        enviarJson(res, 200, {
          ok: true,
          factura: f
            ? {
                estado: String(f.estado),
                hojas: Number(f.hojas) || 0,
                hojasLeidas: Number(f.hojasLeidas) || 0,
                error: f.error ?? null,
                // Se lee con "Mejorar lectura": la página avisa que puede demorar.
                lento: f.lento === true,
              }
            : null,
          puedeQuitar: typeof puerta.quitarUltimaFoto === 'function',
        });
        return true;
      }

      if (accion === 'hoja' && metodo === 'POST') {
        // De a una hoja por enlace: mientras se lee la anterior no se junta
        // otra foto de 12 MB en memoria.
        if (puerta.puedeRecibir && !puerta.puedeRecibir(token)) {
          cortar(req, res, 429, 'OCUPADO', MENSAJE_OCUPADO);
          return true;
        }
        const cuerpo = await leerCuerpo(req, MAX_FOTO_BYTES);
        if (!cuerpo.ok) {
          if (cuerpo.motivo === 'excedido') {
            log?.warn('foto rechazada: supera los 12 MB');
            cortar(req, res, 413, 'VALIDATION', 'La foto es demasiado grande (máximo 12 MB)');
          } else if (cuerpo.motivo === 'lento') {
            cortar(req, res, 408, 'TIMEOUT', 'La foto no terminó de llegar. Intente de nuevo.');
          } else {
            req.socket.destroy(); // el teléfono se fue: no hay a quién contestarle
          }
          return true;
        }
        const jpeg = cuerpo.datos;
        if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
          enviarError(res, 400, 'VALIDATION', 'El archivo no es una foto JPEG');
          return true;
        }
        // "Usar igual": el usuario vio el aviso de la foto y la manda de todos modos.
        const forzar = /(?:^|&)forzar=1(?:&|$)/.test(consulta);
        try {
          const r = await puerta.recibirFoto(token, jpeg, { forzar });
          enviarJson(res, 200, { ok: true, hojas: r.hojas });
        } catch (err) {
          if (esFotoMala(err)) {
            // La hoja NO se agregó: el teléfono muestra el motivo y pide repetirla.
            enviarError(res, 422, 'FOTO', mensajeParaTelefono(err, 'La foto no se puede leer bien. Por favor, vuelva a sacarla.', 400));
            return true;
          }
          if (estaOcupado(err)) {
            enviarError(res, 429, 'OCUPADO', mensajeParaTelefono(err, MENSAJE_OCUPADO), { 'retry-after': '2' });
            return true;
          }
          log?.warn(`no se pudo guardar la foto: ${err instanceof Error ? err.message : String(err)}`);
          enviarError(res, 400, 'VALIDATION', mensajeParaTelefono(err, 'No se pudo guardar la foto. Intente de nuevo.'));
        }
        return true;
      }

      if ((accion === 'cerrar' || accion === 'quitar') && metodo === 'POST') {
        req.resume(); // estos pedidos no llevan cuerpo; si trae algo, se descarta
        if (accion === 'quitar') {
          if (!puerta.quitarUltimaFoto) {
            enviarError(res, 404, 'NOT_FOUND', 'Ruta inexistente');
            return true;
          }
          try {
            const r = await puerta.quitarUltimaFoto(token);
            enviarJson(res, 200, { ok: true, hojas: r.hojas });
          } catch (err) {
            enviarError(res, 400, 'VALIDATION', mensajeParaTelefono(err, 'No se pudo quitar la hoja.'));
          }
          return true;
        }
        try {
          const r = await puerta.cerrarFactura(token);
          enviarJson(res, 200, { ok: true, id: r.id });
        } catch (err) {
          log?.warn(`no se pudo cerrar la factura: ${err instanceof Error ? err.message : String(err)}`);
          enviarError(res, 400, 'VALIDATION', mensajeParaTelefono(err, 'No se pudo terminar el envío. Intente de nuevo.'));
        }
        return true;
      }

      if (accion === 'hoja' || accion === 'cerrar' || accion === 'quitar' || accion === 'estado') {
        enviarError(res, 405, 'METHOD_NOT_ALLOWED', 'Método no permitido', { allow: accion === 'estado' ? 'GET' : 'POST' });
        return true;
      }
      enviarError(res, 404, 'NOT_FOUND', 'Ruta inexistente');
      return true;
    } catch (err) {
      log?.error(`fotos: error inesperado: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) enviarError(res, 500, 'INTERNAL', 'Error interno');
      else res.destroy();
      return true;
    }
  };
}

export interface ServidorFotosOpciones {
  puerta: PuertaFotos;
  /** Default 7790. Con 0 el sistema elige uno libre (tests): ver `puerto`. */
  port?: number;
  /** Default `0.0.0.0`: el teléfono entra por la red Wi-Fi del local. */
  host?: string;
  log?: Log;
}

/**
 * Escucha propia que SÓLO atiende `/lan/foto/…`. Se levanta únicamente con la
 * opción activa; todo lo demás (incluido `/`) contesta 404 sin decir qué es.
 */
export class ServidorFotos {
  private readonly opts: ServidorFotosOpciones;
  private readonly log: Log;
  private readonly ruta: RutaFotos;
  private server: Server | null = null;

  constructor(opts: ServidorFotosOpciones) {
    this.opts = opts;
    this.log = opts.log ?? {
      info: (m) => console.info('[fotos]', m),
      warn: (m) => console.warn('[fotos]', m),
      error: (m) => console.error('[fotos]', m),
    };
    this.ruta = atenderFotos(opts.puerta, this.log);
  }

  /** Puerto en el que está escuchando, o null si está detenido. */
  get puerto(): number | null {
    const dir = this.server?.address();
    return dir && typeof dir === 'object' ? dir.port : null;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.ruta(req, res)
          .then((atendido) => {
            if (!atendido) enviarError(res, 404, 'NOT_FOUND', 'Ruta inexistente');
          })
          .catch((err: unknown) => {
            this.log.error(`error inesperado: ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) enviarError(res, 500, 'INTERNAL', 'Error interno');
          });
      });
      // Un teléfono que abre la conexión y no manda nada no la retiene.
      server.headersTimeout = 15_000;
      server.requestTimeout = 120_000;
      server.keepAliveTimeout = 5_000;
      server.once('error', reject);
      server.listen(this.opts.port ?? PUERTO_FOTOS, this.opts.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        server.on('error', (err) => this.log.error(`servidor de fotos: ${err.message}`));
        this.server = server;
        this.log.info(`fotos de facturas escuchando en :${this.puerto}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      if (!server) return resolve();
      this.server = null;
      server.close(() => resolve());
      // Las conexiones keep-alive del teléfono no tienen que demorar el cierre.
      server.closeAllConnections?.();
    });
  }
}
