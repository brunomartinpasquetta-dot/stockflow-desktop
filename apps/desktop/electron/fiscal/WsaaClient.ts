/**
 * WSAA — Web Service de Autenticación y Autorización de ARCA.
 *
 * Flujo:
 *  1. Se arma un TRA (Ticket de Requerimiento de Acceso): un XML con el servicio
 *     pedido y una ventana de validez.
 *  2. Se firma con el certificado del contribuyente en formato CMS/PKCS#7.
 *  3. Se manda por SOAP a `LoginCms` y ARCA devuelve un TA (Ticket de Acceso)
 *     con `token` y `sign`, válidos 12 horas.
 *  4. Ese par se adjunta a cada llamada de WSFEv1.
 *
 * El TA se cachea en disco: ARCA RECHAZA pedir uno nuevo mientras el anterior
 * siga vigente (error "El CEE ya posee un TA valido"). Sin cache, el segundo
 * login del día falla.
 *
 * La firma CMS se hace con el `openssl` del sistema (presente en macOS, Windows
 * 10+ y Linux) para no arrastrar una dependencia de criptografía pesada.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface AccessTicket {
  token: string;
  sign: string;
  /** Vencimiento en epoch ms. */
  expiresAt: number;
}

export interface WsaaOptions {
  /** Ruta al certificado .crt/.pem del contribuyente. */
  certPath: string;
  /** Ruta a la clave privada .key/.pem. */
  keyPath: string;
  /** Endpoint de LoginCms según el entorno. */
  wsaaUrl: string;
  /** Servicio solicitado. Para facturación electrónica: 'wsfe'. */
  service?: string;
  /** Carpeta donde cachear el TA. */
  cacheDir: string;
  /** CUIT emisor, solo para nombrar el archivo de cache. */
  cuit: string;
}

/** Escapa texto para insertarlo en un XML. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Extrae el contenido de un tag simple. Suficiente para las respuestas de ARCA. */
export function extractTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m?.[1]?.trim() ?? null;
}

/**
 * Arma el XML del TRA.
 *
 * `uniqueId` debe crecer en cada pedido; se usa el epoch en segundos. La ventana
 * arranca 10 minutos ANTES de ahora para tolerar relojes desfasados — un cliente
 * con la hora atrasada es una de las causas típicas de rechazo.
 */
export function buildTra(service: string, now: Date = new Date()): string {
  const uniqueId = Math.floor(now.getTime() / 1000);
  const from = new Date(now.getTime() - 10 * 60 * 1000);
  const to = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<loginTicketRequest version="1.0">',
    '<header>',
    `<uniqueId>${uniqueId}</uniqueId>`,
    `<generationTime>${from.toISOString()}</generationTime>`,
    `<expirationTime>${to.toISOString()}</expirationTime>`,
    '</header>',
    `<service>${xmlEscape(service)}</service>`,
    '</loginTicketRequest>',
  ].join('');
}

/** Envoltorio SOAP para LoginCms. */
export function buildLoginSoap(cmsBase64: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">',
    '<soapenv:Header/>',
    '<soapenv:Body>',
    '<wsaa:loginCms>',
    `<wsaa:in0>${cmsBase64}</wsaa:in0>`,
    '</wsaa:loginCms>',
    '</soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('');
}

/**
 * Parsea el TA que devuelve ARCA. La respuesta trae el XML del ticket escapado
 * dentro del SOAP, así que primero se desescapa.
 */
export function parseAccessTicket(soapResponse: string): AccessTicket {
  const inner = extractTag(soapResponse, 'loginCmsReturn');
  if (!inner) {
    const fault = extractTag(soapResponse, 'faultstring');
    throw new Error(fault ? `ARCA rechazó la autenticación: ${fault}` : 'Respuesta de ARCA inválida');
  }
  const xml = inner
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  const token = extractTag(xml, 'token');
  const sign = extractTag(xml, 'sign');
  const expiration = extractTag(xml, 'expirationTime');
  if (!token || !sign) throw new Error('El ticket de ARCA no trae token/sign');
  return {
    token,
    sign,
    expiresAt: expiration ? new Date(expiration).getTime() : Date.now() + 12 * 60 * 60 * 1000,
  };
}

export class WsaaClient {
  constructor(private readonly opts: WsaaOptions) {}

  private get service(): string {
    return this.opts.service ?? 'wsfe';
  }

  private get cacheFile(): string {
    const cuit = this.opts.cuit.replace(/\D/g, '');
    return path.join(this.opts.cacheDir, `ta-${this.service}-${cuit}.json`);
  }

  /** TA cacheado si todavía es válido (con 5 min de margen). */
  private readCache(): AccessTicket | null {
    try {
      if (!existsSync(this.cacheFile)) return null;
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as AccessTicket;
      if (!raw?.token || !raw?.sign) return null;
      if (raw.expiresAt - 5 * 60 * 1000 <= Date.now()) return null;
      return raw;
    } catch {
      return null;
    }
  }

  private writeCache(ta: AccessTicket): void {
    try {
      mkdirSync(this.opts.cacheDir, { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(ta), 'utf8');
    } catch {
      /* si no se puede cachear, seguimos: solo perdemos la optimización */
    }
  }

  /**
   * Firma el TRA en CMS/PKCS#7 (DER, base64) con openssl.
   *
   * Equivale a:
   *   openssl cms -sign -in tra.xml -signer cert.crt -inkey key.pem \
   *     -nodetach -outform DER
   */
  async signTra(tra: string): Promise<string> {
    mkdirSync(this.opts.cacheDir, { recursive: true });
    const traPath = path.join(this.opts.cacheDir, `tra-${Date.now()}.xml`);
    writeFileSync(traPath, tra, 'utf8');
    try {
      const { stdout } = await execFileP(
        'openssl',
        [
          'cms',
          '-sign',
          '-in',
          traPath,
          '-signer',
          this.opts.certPath,
          '-inkey',
          this.opts.keyPath,
          '-nodetach',
          '-outform',
          'DER',
        ],
        { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 },
      );
      return Buffer.from(stdout).toString('base64');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Errores típicos: certificado vencido, clave que no corresponde al cert,
      // o rutas mal configuradas.
      throw new Error(
        `No se pudo firmar con el certificado. Revisá que el .crt y la clave se ' +
        'correspondan y que el certificado no esté vencido. Detalle: ${msg}`,
      );
    } finally {
      try {
        unlinkSync(traPath);
      } catch {
        /* noop */
      }
    }
  }

  /**
   * Devuelve un TA válido: usa el cacheado si sigue vigente, o pide uno nuevo.
   * Es lo que hay que llamar antes de cada operación de WSFEv1.
   */
  async getAccessTicket(force = false): Promise<AccessTicket> {
    if (!force) {
      const cached = this.readCache();
      if (cached) return cached;
    }
    if (!existsSync(this.opts.certPath)) {
      throw new Error(`No se encuentra el certificado en ${this.opts.certPath}`);
    }
    if (!existsSync(this.opts.keyPath)) {
      throw new Error(`No se encuentra la clave privada en ${this.opts.keyPath}`);
    }

    const tra = buildTra(this.service);
    const cms = await this.signTra(tra);
    const soap = buildLoginSoap(cms);

    const res = await fetch(this.opts.wsaaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '',
      },
      body: soap,
    });
    const text = await res.text();
    if (!res.ok && !text.includes('loginCmsReturn')) {
      const fault = extractTag(text, 'faultstring');
      throw new Error(fault ?? `ARCA respondió ${res.status} al autenticar`);
    }
    const ta = parseAccessTicket(text);
    this.writeCache(ta);
    return ta;
  }
}
