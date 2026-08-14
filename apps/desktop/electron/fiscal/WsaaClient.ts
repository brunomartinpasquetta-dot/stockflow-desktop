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
 * La firma CMS se arma DENTRO del programa, con node-forge.
 *
 * Antes se ejecutaba el `openssl` del sistema. Windows NO trae openssl —el que
 * existe es el de Git o el de WSL, que un comercio no tiene—, así que la
 * facturación electrónica fallaba en TODA instalación Windows con
 * "spawn openssl ENOENT", justo el sistema operativo de todos los clientes.
 * Apareció en Leo Citzia el 13-ago-2026, con la primera factura por emitir.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';

/**
 * Error del login contra ARCA. Se marca con este `name` para que la capa IPC lo
 * muestre TAL CUAL en vez de convertirlo en "Error interno": lo que dice ARCA
 * es lo único que permite saber qué hay que corregir.
 */
export class WsaaApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WsfeApiError';
  }
}

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
    throw new WsaaApiError(fault ? `ARCA rechazó la autenticación: ${fault}` : 'Respuesta de ARCA inválida');
  }
  const xml = inner
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
  const token = extractTag(xml, 'token');
  const sign = extractTag(xml, 'sign');
  const expiration = extractTag(xml, 'expirationTime');
  if (!token || !sign) throw new WsaaApiError('El ticket de ARCA no trae token/sign');
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
   * Firma el TRA en CMS/PKCS#7 (DER, base64), que es lo que espera `LoginCms`.
   *
   * Equivale a `openssl cms -sign -nodetach -outform DER`, pero hecho en
   * proceso: no depende de que haya un openssl instalado.
   */
  async signTra(tra: string): Promise<string> {
    try {
      const certPem = readFileSync(this.opts.certPath, 'utf8');
      const keyPem = readFileSync(this.opts.keyPath, 'utf8');
      const cert = forge.pki.certificateFromPem(certPem);
      const key = forge.pki.privateKeyFromPem(keyPem);

      // El certificado tiene que estar vigente: si no, ARCA rechaza el login
      // con un mensaje que no explica nada. Mejor decirlo acá.
      const ahora = new Date();
      if (ahora < cert.validity.notBefore || ahora > cert.validity.notAfter) {
        throw new WsaaApiError(
          `el certificado está fuera de vigencia (vale del ` +
            `${cert.validity.notBefore.toLocaleDateString('es-AR')} al ` +
            `${cert.validity.notAfter.toLocaleDateString('es-AR')})`,
        );
      }

      const p7 = forge.pkcs7.createSignedData();
      p7.content = forge.util.createBuffer(tra, 'utf8');
      p7.addCertificate(cert);
      p7.addSigner({
        key,
        certificate: cert,
        // Los OID vienen tipados como opcionales, pero son constantes de la
        // librería: siempre están.
        digestAlgorithm: forge.pki.oids.sha256!,
        authenticatedAttributes: [
          { type: forge.pki.oids.contentType!, value: forge.pki.oids.data! },
          { type: forge.pki.oids.messageDigest! },
          { type: forge.pki.oids.signingTime!, value: ahora as unknown as string },
        ],
      });
      // Sin `detached`: el TRA viaja DENTRO del CMS, que es lo que pide ARCA.
      p7.sign();
      return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WsaaApiError(
        'No se pudo firmar con el certificado. Revisá que el .crt y la clave ' +
          `se correspondan y que el certificado no esté vencido. Detalle: ${msg}`,
        { cause: err },
      );
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
      throw new WsaaApiError(`No se encuentra el certificado en ${this.opts.certPath}`);
    }
    if (!existsSync(this.opts.keyPath)) {
      throw new WsaaApiError(`No se encuentra la clave privada en ${this.opts.keyPath}`);
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
      throw new WsaaApiError(fault ?? `ARCA respondió ${res.status} al autenticar`);
    }
    const ta = parseAccessTicket(text);
    this.writeCache(ta);
    return ta;
  }
}
