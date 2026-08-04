/**
 * WSFEv1 — Web Service de Facturación Electrónica de ARCA.
 *
 * Operaciones que usamos:
 *  - `FECompUltimoAutorizado`: último número autorizado por punto de venta y
 *    tipo. Se consulta ANTES de emitir para no dejar huecos ni pisar números.
 *  - `FECAESolicitar`: envía el comprobante y devuelve el CAE.
 *  - `FEParamGetPtosVenta`: puntos de venta habilitados (para la config).
 *  - `FEDummy`: chequeo de estado de los servidores de ARCA.
 *
 * Sobre errores: ARCA distingue `Errors` (rechazo: el comprobante NO se emitió)
 * de `Observaciones` (se emitió CON observaciones, el CAE es válido). Tratarlas
 * igual es un error grave — se perderían comprobantes ya autorizados.
 */
import type { AccessTicket } from './WsaaClient';
import { extractTag } from './WsaaClient';

export interface WsfeAuth {
  token: string;
  sign: string;
  cuit: string;
}

export interface VatDetail {
  /** Id de alícuota ARCA: 3=0% 4=10.5% 5=21% 6=27% */
  id: number;
  baseAmount: number;
  amount: number;
}

export interface VoucherRequest {
  salePoint: number;
  voucherCode: number;
  /** Número a emitir. Si se omite, se usa último autorizado + 1. */
  number?: number;
  date: Date | number;
  docType: number;
  docNumber: string;
  /** Neto gravado. */
  netAmount: number;
  vatAmount: number;
  exemptAmount?: number;
  untaxedAmount?: number;
  total: number;
  vatDetails: VatDetail[];
  /** Comprobantes asociados (obligatorio en notas de crédito/débito). */
  associated?: { voucherCode: number; salePoint: number; number: number }[];
  concept?: number;
}

export interface CaeResult {
  cae: string;
  caeExpiry: string;
  number: number;
  /** Observaciones de ARCA: el comprobante ES válido, pero hay que mostrarlas. */
  observations: string[];
}

export class WsfeApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'WsfeApiError';
  }
}

function fmt(n: number): string {
  return n.toFixed(2);
}

function toArcaDate(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** Extrae TODAS las coincidencias de un tag (ARCA repite `<Err>`, `<Obs>`). */
function extractAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

/** Formatea los `<Err>` de ARCA como "código: mensaje". */
function parseErrors(xml: string): string[] {
  return extractAll(xml, 'Err').map((e) => {
    const code = extractTag(e, 'Code') ?? '';
    const msg = extractTag(e, 'Msg') ?? e;
    return code ? `${code}: ${msg}` : msg;
  });
}

function parseObservations(xml: string): string[] {
  return extractAll(xml, 'Obs').map((o) => {
    const code = extractTag(o, 'Code') ?? '';
    const msg = extractTag(o, 'Msg') ?? o;
    return code ? `${code}: ${msg}` : msg;
  });
}

export class WsfeClient {
  constructor(
    private readonly url: string,
    private readonly auth: WsfeAuth,
  ) {}

  static fromTicket(url: string, ta: AccessTicket, cuit: string): WsfeClient {
    return new WsfeClient(url, { token: ta.token, sign: ta.sign, cuit: cuit.replace(/\D/g, '') });
  }

  private authXml(): string {
    return [
      '<ar:Auth>',
      `<ar:Token>${this.auth.token}</ar:Token>`,
      `<ar:Sign>${this.auth.sign}</ar:Sign>`,
      `<ar:Cuit>${this.auth.cuit}</ar:Cuit>`,
      '</ar:Auth>',
    ].join('');
  }

  private async call(action: string, body: string): Promise<string> {
    const soap = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">',
      '<soapenv:Header/>',
      '<soapenv:Body>',
      body,
      '</soapenv:Body>',
      '</soapenv:Envelope>',
    ].join('');

    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `http://ar.gov.afip.dif.FEV1/${action}`,
      },
      body: soap,
    });
    const text = await res.text();
    const fault = extractTag(text, 'faultstring');
    if (fault) throw new WsfeApiError(fault, 'SOAP_FAULT');
    return text;
  }

  /** Estado de los servidores de ARCA (app/db/auth). */
  async dummy(): Promise<{ app: string; db: string; auth: string }> {
    const xml = await this.call('FEDummy', '<ar:FEDummy/>');
    return {
      app: extractTag(xml, 'AppServer') ?? '?',
      db: extractTag(xml, 'DbServer') ?? '?',
      auth: extractTag(xml, 'AuthServer') ?? '?',
    };
  }

  /** Último número autorizado para un punto de venta y tipo de comprobante. */
  async lastAuthorized(salePoint: number, voucherCode: number): Promise<number> {
    const xml = await this.call(
      'FECompUltimoAutorizado',
      [
        '<ar:FECompUltimoAutorizado>',
        this.authXml(),
        `<ar:PtoVta>${salePoint}</ar:PtoVta>`,
        `<ar:CbteTipo>${voucherCode}</ar:CbteTipo>`,
        '</ar:FECompUltimoAutorizado>',
      ].join(''),
    );
    const errors = parseErrors(xml);
    if (errors.length > 0) {
      throw new WsfeApiError(errors.join(' | '), 'ARCA_ERROR', errors);
    }
    return Number(extractTag(xml, 'CbteNro') ?? '0');
  }

  /** Puntos de venta habilitados para facturación electrónica. */
  async salePoints(): Promise<{ number: number; type: string; blocked: boolean }[]> {
    const xml = await this.call(
      'FEParamGetPtosVenta',
      ['<ar:FEParamGetPtosVenta>', this.authXml(), '</ar:FEParamGetPtosVenta>'].join(''),
    );
    const errors = parseErrors(xml);
    if (errors.length > 0) throw new WsfeApiError(errors.join(' | '), 'ARCA_ERROR', errors);
    return extractAll(xml, 'PtoVenta').map((p) => ({
      number: Number(extractTag(p, 'Nro') ?? '0'),
      type: extractTag(p, 'EmisionTipo') ?? '',
      blocked: (extractTag(p, 'Bloqueado') ?? 'N').toUpperCase() === 'S',
    }));
  }

  /**
   * Solicita el CAE de un comprobante.
   *
   * Si `number` viene vacío, consulta el último autorizado y usa el siguiente.
   * Lanza `WsfeApiError` si ARCA RECHAZA; si aprueba con observaciones, las
   * devuelve en el resultado (el CAE es válido igual).
   */
  async requestCae(req: VoucherRequest): Promise<CaeResult> {
    const number =
      req.number ?? (await this.lastAuthorized(req.salePoint, req.voucherCode)) + 1;
    const date = toArcaDate(req.date);
    const exempt = req.exemptAmount ?? 0;
    const untaxed = req.untaxedAmount ?? 0;

    // ARCA rechaza el detalle de IVA si el neto gravado es 0 (caso factura C
    // o exenta): en ese caso no se manda el array.
    const vatXml =
      req.vatAmount > 0 || req.vatDetails.length > 0
        ? [
            '<ar:Iva>',
            ...req.vatDetails.map((v) =>
              [
                '<ar:AlicIva>',
                `<ar:Id>${v.id}</ar:Id>`,
                `<ar:BaseImp>${fmt(v.baseAmount)}</ar:BaseImp>`,
                `<ar:Importe>${fmt(v.amount)}</ar:Importe>`,
                '</ar:AlicIva>',
              ].join(''),
            ),
            '</ar:Iva>',
          ].join('')
        : '';

    // Notas de crédito/débito deben referenciar el comprobante que ajustan.
    const assocXml =
      req.associated && req.associated.length > 0
        ? [
            '<ar:CbtesAsoc>',
            ...req.associated.map((a) =>
              [
                '<ar:CbteAsoc>',
                `<ar:Tipo>${a.voucherCode}</ar:Tipo>`,
                `<ar:PtoVta>${a.salePoint}</ar:PtoVta>`,
                `<ar:Nro>${a.number}</ar:Nro>`,
                '</ar:CbteAsoc>',
              ].join(''),
            ),
            '</ar:CbtesAsoc>',
          ].join('')
        : '';

    const body = [
      '<ar:FECAESolicitar>',
      this.authXml(),
      '<ar:FeCAEReq>',
      '<ar:FeCabReq>',
      '<ar:CantReg>1</ar:CantReg>',
      `<ar:PtoVta>${req.salePoint}</ar:PtoVta>`,
      `<ar:CbteTipo>${req.voucherCode}</ar:CbteTipo>`,
      '</ar:FeCabReq>',
      '<ar:FeDetReq>',
      '<ar:FECAEDetRequest>',
      `<ar:Concepto>${req.concept ?? 1}</ar:Concepto>`,
      `<ar:DocTipo>${req.docType}</ar:DocTipo>`,
      `<ar:DocNro>${req.docNumber.replace(/\D/g, '') || '0'}</ar:DocNro>`,
      `<ar:CbteDesde>${number}</ar:CbteDesde>`,
      `<ar:CbteHasta>${number}</ar:CbteHasta>`,
      `<ar:CbteFch>${date}</ar:CbteFch>`,
      `<ar:ImpTotal>${fmt(req.total)}</ar:ImpTotal>`,
      '<ar:ImpTotConc>' + fmt(untaxed) + '</ar:ImpTotConc>',
      `<ar:ImpNeto>${fmt(req.netAmount)}</ar:ImpNeto>`,
      '<ar:ImpOpEx>' + fmt(exempt) + '</ar:ImpOpEx>',
      '<ar:ImpTrib>0.00</ar:ImpTrib>',
      `<ar:ImpIVA>${fmt(req.vatAmount)}</ar:ImpIVA>`,
      '<ar:MonId>PES</ar:MonId>',
      '<ar:MonCotiz>1</ar:MonCotiz>',
      assocXml,
      vatXml,
      '</ar:FECAEDetRequest>',
      '</ar:FeDetReq>',
      '</ar:FeCAEReq>',
      '</ar:FECAESolicitar>',
    ].join('');

    const xml = await this.call('FECAESolicitar', body);

    const errors = parseErrors(xml);
    if (errors.length > 0) {
      throw new WsfeApiError(
        `ARCA rechazó el comprobante: ${errors.join(' | ')}`,
        'ARCA_REJECTED',
        errors,
      );
    }

    const result = extractTag(xml, 'Resultado');
    const cae = extractTag(xml, 'CAE');
    const caeExpiry = extractTag(xml, 'CAEFchVto');
    const observations = parseObservations(xml);

    if (result === 'R' || !cae) {
      throw new WsfeApiError(
        observations.length > 0
          ? `ARCA rechazó el comprobante: ${observations.join(' | ')}`
          : 'ARCA rechazó el comprobante sin detallar el motivo',
        'ARCA_REJECTED',
        observations,
      );
    }

    return {
      cae,
      caeExpiry: caeExpiry ?? '',
      number,
      // Resultado 'A' (aprobado) u 'P' (parcial): el CAE vale, pero si hay
      // observaciones el usuario las tiene que ver.
      observations,
    };
  }
}
