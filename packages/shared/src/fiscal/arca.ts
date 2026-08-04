/**
 * Constantes y reglas de facturación electrónica ARCA (ex AFIP).
 *
 * Referencia: manual WSFEv1 de ARCA. Los códigos son los oficiales; cambiarlos
 * hace que ARCA rechace el comprobante.
 */

/** Códigos de tipo de comprobante (ARCA `CbteTipo`). */
export const VOUCHER_CODES = {
  FACTURA_A: 1,
  NOTA_DEBITO_A: 2,
  NOTA_CREDITO_A: 3,
  FACTURA_B: 6,
  NOTA_DEBITO_B: 7,
  NOTA_CREDITO_B: 8,
  FACTURA_C: 11,
  NOTA_DEBITO_C: 12,
  NOTA_CREDITO_C: 13,
} as const;

/** Tipos de documento del receptor (ARCA `DocTipo`). */
export const DOC_TYPES = {
  CUIT: 80,
  CUIL: 86,
  DNI: 96,
  PASAPORTE: 94,
  /** Consumidor final sin identificar. Obliga a `DocNro = 0`. */
  CONSUMIDOR_FINAL: 99,
} as const;

/** Ids de alícuota de IVA (ARCA `Iva.Id`). */
export const VAT_IDS = {
  '0.00': 3,
  '10.50': 4,
  '21.00': 5,
  '27.00': 6,
} as const;

/** Conceptos: qué se factura (ARCA `Concepto`). */
export const CONCEPTS = {
  PRODUCTOS: 1,
  SERVICIOS: 2,
  PRODUCTOS_Y_SERVICIOS: 3,
} as const;

export type VoucherLetter = 'A' | 'B' | 'C';
export type VoucherKind = 'invoice' | 'credit_note' | 'debit_note';
/** Condición del emisor frente al IVA. */
export type IssuerVatCondition = 'RI' | 'MT';
/** Condición del receptor: RI, Monotributo, Consumidor Final, Exento. */
export type CustomerVatCategory = 'RI' | 'MT' | 'CF' | 'EX';

/**
 * Determina la LETRA del comprobante según quién emite y quién recibe.
 *
 * Reglas de ARCA:
 *  - Emisor Monotributista → siempre C (no discrimina IVA).
 *  - Emisor Responsable Inscripto:
 *      · receptor RI                     → A (se discrimina el IVA)
 *      · receptor MT / CF / Exento       → B (IVA incluido en el precio)
 *
 * Es la regla que evita el error más caro: emitir A a un consumidor final.
 */
export function resolveVoucherLetter(
  issuer: IssuerVatCondition,
  customer: CustomerVatCategory,
): VoucherLetter {
  if (issuer === 'MT') return 'C';
  return customer === 'RI' ? 'A' : 'B';
}

/** Código ARCA a partir de la letra y la clase de comprobante. */
export function resolveVoucherCode(letter: VoucherLetter, kind: VoucherKind): number {
  const table: Record<VoucherLetter, Record<VoucherKind, number>> = {
    A: {
      invoice: VOUCHER_CODES.FACTURA_A,
      credit_note: VOUCHER_CODES.NOTA_CREDITO_A,
      debit_note: VOUCHER_CODES.NOTA_DEBITO_A,
    },
    B: {
      invoice: VOUCHER_CODES.FACTURA_B,
      credit_note: VOUCHER_CODES.NOTA_CREDITO_B,
      debit_note: VOUCHER_CODES.NOTA_DEBITO_B,
    },
    C: {
      invoice: VOUCHER_CODES.FACTURA_C,
      credit_note: VOUCHER_CODES.NOTA_CREDITO_C,
      debit_note: VOUCHER_CODES.NOTA_DEBITO_C,
    },
  };
  return table[letter][kind];
}

/** Nombre legible del comprobante, para pantalla e impresión. */
export function voucherLabel(letter: VoucherLetter, kind: VoucherKind): string {
  const base =
    kind === 'invoice' ? 'Factura' : kind === 'credit_note' ? 'Nota de Crédito' : 'Nota de Débito';
  return `${base} ${letter}`;
}

/**
 * Tipo y número de documento del receptor en formato ARCA.
 *
 * Consumidor final sin datos → tipo 99 y número 0, que es lo que ARCA espera
 * (y lo único válido para una factura B de mostrador).
 */
export function resolveCustomerDoc(
  docType: 'DNI' | 'CUIT' | 'CUIL' | 'PASS' | 'CF' | null | undefined,
  docNumber: string | null | undefined,
): { docType: number; docNumber: string } {
  const clean = (docNumber ?? '').replace(/\D/g, '');
  if (!docType || docType === 'CF' || clean === '') {
    return { docType: DOC_TYPES.CONSUMIDOR_FINAL, docNumber: '0' };
  }
  const map = {
    CUIT: DOC_TYPES.CUIT,
    CUIL: DOC_TYPES.CUIL,
    DNI: DOC_TYPES.DNI,
    PASS: DOC_TYPES.PASAPORTE,
  } as const;
  return { docType: map[docType], docNumber: clean };
}

/**
 * Factura A exige identificar al receptor con CUIT: ARCA la rechaza si va como
 * consumidor final. Se valida ANTES de emitir para no quemar numeración.
 */
export function validateForLetter(
  letter: VoucherLetter,
  doc: { docType: number; docNumber: string },
): { ok: true } | { ok: false; reason: string } {
  if (letter === 'A' && doc.docType !== DOC_TYPES.CUIT) {
    return {
      ok: false,
      reason: 'Una Factura A necesita el CUIT del cliente. Cargalo en su ficha o emití una Factura B.',
    };
  }
  if (letter === 'B' && doc.docType === DOC_TYPES.CONSUMIDOR_FINAL) {
    // Permitido, pero ARCA exige identificar al receptor cuando el total supera
    // el tope vigente para consumidor final.
    return { ok: true };
  }
  return { ok: true };
}

/** Fecha en el formato que pide ARCA: YYYYMMDD. */
export function toArcaDate(date: Date | number): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Convierte una fecha ARCA (YYYYMMDD) a timestamp local. */
export function fromArcaDate(value: string): number {
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(4, 6)) - 1;
  const d = Number(value.slice(6, 8));
  return new Date(y, m, d).getTime();
}

/** Endpoints de ARCA por entorno. */
export const ARCA_ENDPOINTS = {
  homologacion: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  },
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  },
} as const;

/**
 * URL del QR obligatorio en el comprobante (RG 4892).
 * El payload va en base64 dentro de la URL pública de ARCA.
 */
export function buildQrUrl(data: {
  cuit: string;
  ptoVta: number;
  tipoCmp: number;
  nroCmp: number;
  importe: number;
  moneda?: string;
  ctz?: number;
  tipoDocRec: number;
  nroDocRec: string;
  tipoCodAut?: 'E' | 'A';
  codAut: string;
  fecha: string;
}): string {
  const payload = {
    ver: 1,
    fecha: `${data.fecha.slice(0, 4)}-${data.fecha.slice(4, 6)}-${data.fecha.slice(6, 8)}`,
    cuit: Number(data.cuit.replace(/\D/g, '')),
    ptoVta: data.ptoVta,
    tipoCmp: data.tipoCmp,
    nroCmp: data.nroCmp,
    importe: data.importe,
    moneda: data.moneda ?? 'PES',
    ctz: data.ctz ?? 1,
    tipoDocRec: data.tipoDocRec,
    nroDocRec: Number(data.nroDocRec) || 0,
    tipoCodAut: data.tipoCodAut ?? 'E',
    codAut: Number(data.codAut),
  };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${b64}`;
}
