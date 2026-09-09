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
 * Condición frente al IVA del receptor (ARCA `CondicionIVAReceptorId`,
 * RG 5616). Obligatoria en TODA solicitud de CAE, consumidor final incluido:
 * sin este campo ARCA rechaza el comprobante (errores 10245/10246).
 * Códigos según `FEParamGetCondicionIvaReceptor` (manual WSFEv1 v4.7, pág. 203).
 */
export const RECEIVER_VAT_CONDITION_IDS: Record<CustomerVatCategory, number> = {
  RI: 1,
  EX: 4,
  CF: 5,
  MT: 6,
};

/** Descripción oficial de cada código, para imprimirla en el comprobante. */
export const RECEIVER_VAT_CONDITION_LABELS: Record<number, string> = {
  1: 'IVA Responsable Inscripto',
  4: 'IVA Sujeto Exento',
  5: 'Consumidor Final',
  6: 'Responsable Monotributo',
  7: 'Sujeto No Categorizado',
  8: 'Proveedor del Exterior',
  9: 'Cliente del Exterior',
  10: 'IVA Liberado – Ley N° 19.640',
  13: 'Monotributista Social',
  15: 'IVA No Alcanzado',
  16: 'Monotributo Trabajador Independiente Promovido',
};

/**
 * Clases de comprobante que admite cada condición del receptor (misma tabla
 * de ARCA). Mandar una combinación que no figure acá es el error 10243.
 * Lo que más importa: Monotributo (6) NO admite clase B — el Responsable
 * Inscripto le emite Factura A al monotributista.
 */
export const RECEIVER_VAT_CONDITION_CLASSES: Record<number, readonly VoucherLetter[]> = {
  1: ['A', 'C'],
  4: ['B', 'C'],
  5: ['B', 'C'],
  6: ['A', 'C'],
  7: ['B', 'C'],
  8: ['B', 'C'],
  9: ['B', 'C'],
  10: ['B', 'C'],
  13: ['A', 'C'],
  15: ['B', 'C'],
  16: ['A', 'C'],
};

/**
 * Leyenda que ARCA exige en una Factura A cuyo receptor es monotributista
 * (observación 10217 del manual WSFEv1).
 */
export const MONOTRIBUTO_CLASS_A_LEGEND =
  'El crédito fiscal discriminado en el presente comprobante solo podrá ser computado a efectos del Procedimiento permanente de transición al Régimen General.';

/** Código ARCA de condición IVA del receptor a partir de la categoría del cliente. */
export function resolveReceiverVatConditionId(category: CustomerVatCategory): number {
  return RECEIVER_VAT_CONDITION_IDS[category] ?? RECEIVER_VAT_CONDITION_IDS.CF;
}

/** ¿ARCA admite esa condición del receptor en un comprobante de esa clase? */
export function isReceiverVatConditionAllowed(id: number, letter: VoucherLetter): boolean {
  return RECEIVER_VAT_CONDITION_CLASSES[id]?.includes(letter) ?? false;
}

/**
 * Condición del receptor a asumir cuando un comprobante viejo no la tiene
 * guardada (emitido antes de que el sistema la informara). Se usa sólo para
 * que las notas de crédito/débito sobre esos comprobantes puedan salir.
 */
export function defaultReceiverVatConditionForLetter(letter: VoucherLetter): number {
  return letter === 'A' ? RECEIVER_VAT_CONDITION_IDS.RI : RECEIVER_VAT_CONDITION_IDS.CF;
}

/**
 * Determina la LETRA del comprobante según quién emite y quién recibe.
 *
 * Reglas de ARCA (RG 5616):
 *  - Emisor Monotributista → siempre C (no discrimina IVA).
 *  - Emisor Responsable Inscripto:
 *      · receptor RI o Monotributo       → A (se discrimina el IVA)
 *      · receptor CF / Exento            → B (IVA incluido en el precio)
 *
 * Es la regla que evita el error más caro: emitir A a un consumidor final, o
 * B a un monotributista (ARCA la rechaza con el error 10243).
 */
export function resolveVoucherLetter(
  issuer: IssuerVatCondition,
  customer: CustomerVatCategory,
): VoucherLetter {
  if (issuer === 'MT') return 'C';
  return customer === 'RI' || customer === 'MT' ? 'A' : 'B';
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
 * Validaciones locales ANTES de pedir el CAE, para no depender del rechazo de
 * ARCA ni quemar numeración:
 *  - Factura A exige identificar al receptor con CUIT.
 *  - La condición IVA del receptor tiene que ser admitida por la clase del
 *    comprobante (tabla de `FEParamGetCondicionIvaReceptor`).
 */
export function validateForLetter(
  letter: VoucherLetter,
  doc: { docType: number; docNumber: string },
  receiverVatConditionId?: number,
): { ok: true } | { ok: false; reason: string } {
  if (letter === 'A' && doc.docType !== DOC_TYPES.CUIT) {
    return {
      ok: false,
      reason:
        'Una Factura A requiere el CUIT del cliente. Debe cargarse en la ficha del cliente antes de facturar.',
    };
  }
  if (receiverVatConditionId != null) {
    const allowed = RECEIVER_VAT_CONDITION_CLASSES[receiverVatConditionId];
    if (!allowed) {
      return {
        ok: false,
        reason: `La condición frente al IVA del cliente (código ${receiverVatConditionId}) no es un valor admitido por ARCA.`,
      };
    }
    if (!allowed.includes(letter)) {
      const label = RECEIVER_VAT_CONDITION_LABELS[receiverVatConditionId] ?? 'informada';
      const sugerida =
        receiverVatConditionId === RECEIVER_VAT_CONDITION_IDS.MT
          ? ' Según la RG 5616, a un cliente Monotributista corresponde emitirle Factura A.'
          : '';
      return {
        ok: false,
        reason: `ARCA no admite un comprobante clase ${letter} para un receptor con condición "${label}".${sugerida} Verifique la categoría fiscal en la ficha del cliente.`,
      };
    }
  }
  // Factura B a consumidor final sin identificar es válida; ARCA exige
  // identificar al receptor sólo cuando el total supera el tope vigente.
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
