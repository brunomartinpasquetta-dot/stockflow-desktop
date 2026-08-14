/**
 * Servicio FISCAL: emisión de comprobantes electrónicos con CAE de ARCA.
 *
 * Responsabilidades:
 *  - Decidir la letra del comprobante según emisor y cliente.
 *  - Calcular el desglose de IVA por alícuota que ARCA exige.
 *  - Delegar en el gateway (implementado en la capa Electron, que es quien puede
 *    firmar con el certificado y hablar SOAP) y persistir el resultado.
 *
 * El servicio NO conoce SOAP ni certificados: recibe un `ArcaGateway`. Así se
 * puede testear la lógica fiscal sin red ni certificado.
 */
import {
  DOC_TYPES,
  VAT_IDS,
  resolveCustomerDoc,
  resolveVoucherCode,
  resolveVoucherLetter,
  validateForLetter,
  voucherLabel,
  type CustomerVatCategory,
  type IssuerVatCondition,
  type VoucherKind,
  type VoucherLetter,
} from '@stockflow/shared';
import { addDecimal, proratedVatBreakdown, vatBreakdown } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors';

/** Lo que el servicio necesita de ARCA. Lo implementa la capa Electron. */
export interface ArcaGateway {
  /** Último número autorizado por ARCA para ese punto de venta y tipo. */
  lastAuthorized(salePoint: number, voucherCode: number): Promise<number>;
  /** Solicita el CAE. Lanza si ARCA rechaza. */
  requestCae(req: {
    salePoint: number;
    voucherCode: number;
    number: number;
    date: number;
    docType: number;
    docNumber: string;
    netAmount: number;
    vatAmount: number;
    exemptAmount: number;
    untaxedAmount: number;
    total: number;
    vatDetails: { id: number; baseAmount: number; amount: number }[];
    associated?: { voucherCode: number; salePoint: number; number: number }[];
  }): Promise<{ cae: string; caeExpiry: string; number: number; observations: string[] }>;
  /** URL del QR obligatorio (RG 4892). */
  buildQrUrl(data: {
    cuit: string;
    ptoVta: number;
    tipoCmp: number;
    nroCmp: number;
    importe: number;
    tipoDocRec: number;
    nroDocRec: string;
    codAut: string;
    fecha: string;
  }): string;
}

export interface IssueInvoiceInput {
  saleId: string;
  salePoint: number;
  /** Fuerza la letra (por defecto se deduce del cliente). */
  letter?: VoucherLetter;
}

export interface IssueNoteInput {
  /** Comprobante que se ajusta. */
  relatedVoucherId: string;
  kind: 'credit_note' | 'debit_note';
  /** Importe total de la nota. Si se omite, se toma el total del comprobante. */
  total?: string;
  reason?: string;
}

export interface IssuedVoucher {
  id: string;
  label: string;
  letter: VoucherLetter;
  salePoint: number;
  number: number;
  cae: string;
  caeExpiry: number | null;
  total: string;
  qrUrl: string | null;
  observations: string[];
}

/** Formatea "1234" → número con 2 decimales para ARCA. */
function n2(v: string | number): number {
  return Math.round(Number(v) * 100) / 100;
}

export class FiscalService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly gateway: ArcaGateway,
  ) {}

  /** Config fiscal validada; lanza con mensaje claro si falta algo. */
  private requireConfig() {
    const cfg = this.ctx.repos.fiscal.getConfig();
    if (!cfg || !cfg.enabled) {
      throw new BusinessRuleError(
        'fiscal_disabled',
        'La facturación electrónica no está configurada. Andá a Configuración → Facturación electrónica.',
      );
    }
    if (!cfg.cuit) {
      throw new ValidationError('cuit', 'Falta el CUIT del emisor en la configuración fiscal');
    }
    return cfg;
  }

  /**
   * Emite una factura electrónica a partir de una venta ya registrada.
   *
   * Orden deliberado:
   *  1. Validar todo lo local (config, venta, cliente, letra).
   *  2. Pedir a ARCA el último número y sumar 1.
   *  3. Pedir el CAE.
   *  4. Recién ahí persistir.
   *
   * Así, si ARCA rechaza, no queda un comprobante local sin CAE ni se consume
   * numeración.
   */
  async issueInvoiceForSale(input: IssueInvoiceInput): Promise<IssuedVoucher> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'create_sale');
    const cfg = this.requireConfig();

    const existing = repos.fiscal.findVoucherBySale(input.saleId);
    if (existing) {
      throw new BusinessRuleError(
        'already_invoiced',
        `Esta venta ya tiene ${voucherLabel(existing.letter, existing.kind)} ${String(
          existing.salePoint,
        ).padStart(5, '0')}-${String(existing.number).padStart(8, '0')}`,
      );
    }

    const sale = await repos.sales.findById(input.saleId);
    if (!sale) throw new NotFoundError('Venta', input.saleId);
    if (sale.status === 'voided') {
      throw new BusinessRuleError('sale_voided', 'No se puede facturar una venta anulada');
    }

    const customer = await repos.customers.findById(sale.customerId);
    if (!customer) throw new NotFoundError('Cliente', sale.customerId);

    const letter =
      input.letter ??
      resolveVoucherLetter(
        cfg.vatCondition as IssuerVatCondition,
        customer.category as CustomerVatCategory,
      );
    const doc = resolveCustomerDoc(customer.docType, customer.docNumber);
    const check = validateForLetter(letter, doc);
    if (!check.ok) throw new ValidationError('customer', check.reason);

    const voucherCode = resolveVoucherCode(letter, 'invoice');

    // Desglose de IVA por alícuota. ARCA exige base y monto por cada una.
    // `repos.sales.findLines` NO EXISTE: emitir cualquier factura reventaba con
    // "TypeError: findLines is not a function", que la capa IPC mostraba como
    // "Error interno" — el comercio veía "ARCA no la autorizó: Error interno"
    // sin que ARCA hubiera visto nada. Las líneas están en su propio
    // repositorio.
    const lines = await repos.saleLines.findBySale(input.saleId);
    // `repos.companies` tampoco existe (el repositorio es `company`, singular).
    // Segunda llamada rota en la misma función: emitir una factura reventaba
    // dos veces antes de llegar a ARCA.
    const company = await repos.company.getOrCreate();
    const priceMode = company?.priceMode === 'net' ? 'net' : 'gross';

    const byRate = new Map<string, { base: string; vat: string }>();
    for (const l of lines) {
      const rate = l.vatRate ?? '21.00';
      const br = vatBreakdown(l.lineTotal, rate, priceMode);
      const acc = byRate.get(rate) ?? { base: '0.0000', vat: '0.0000' };
      byRate.set(rate, {
        base: addDecimal(acc.base, br.net, 4),
        // `vatBreakdown` devuelve `vat`, no `vatAmount`: el IVA por alícuota se
        // sumaba con `undefined` y el desglose que se le manda a ARCA salía en
        // cero. En Factura A eso es el dato que mira el fisco.
        vat: addDecimal(acc.vat, br.vat, 4),
      });
    }

    const totals = proratedVatBreakdown(
      lines.map((l) => ({ lineTotal: l.lineTotal, vatRate: l.vatRate ?? '21.00' })),
      sale.discount ?? '0',
      sale.subtotal,
      priceMode,
    );

    const vatDetails = [...byRate.entries()]
      .filter(([, v]) => Number(v.base) > 0)
      .map(([rate, v]) => ({
        id: VAT_IDS[rate as keyof typeof VAT_IDS] ?? VAT_IDS['21.00'],
        baseAmount: n2(v.base),
        amount: n2(v.vat),
      }));

    // Factura C (monotributo): no se discrimina IVA — todo va como neto.
    const isC = letter === 'C';
    const netAmount = isC ? n2(sale.total) : n2(totals.net);
    const vatAmount = isC ? 0 : n2(totals.vatAmount);

    const nextNumber = (await this.gateway.lastAuthorized(input.salePoint, voucherCode)) + 1;
    const date = Date.now();

    try {
      const res = await this.gateway.requestCae({
        salePoint: input.salePoint,
        voucherCode,
        number: nextNumber,
        date,
        docType: doc.docType,
        docNumber: doc.docNumber,
        netAmount,
        vatAmount,
        exemptAmount: 0,
        untaxedAmount: 0,
        total: n2(sale.total),
        vatDetails: isC ? [] : vatDetails,
      });

      const qrUrl = this.gateway.buildQrUrl({
        cuit: cfg.cuit,
        ptoVta: input.salePoint,
        tipoCmp: voucherCode,
        nroCmp: res.number,
        importe: n2(sale.total),
        tipoDocRec: doc.docType,
        nroDocRec: doc.docNumber,
        codAut: res.cae,
        fecha: new Date(date).toISOString().slice(0, 10).replace(/-/g, ''),
      });

      const saved = repos.fiscal.createVoucher(
        {
          voucherCode,
          letter,
          kind: 'invoice',
          salePoint: input.salePoint,
          number: res.number,
          date,
          saleId: sale.id,
          customerId: customer.id,
          customerDocType: doc.docType,
          customerDocNumber: doc.docNumber,
          customerName: customer.firstName
            ? `${customer.lastName}, ${customer.firstName}`
            : customer.lastName,
          netAmount: String(netAmount),
          vatAmount: String(vatAmount),
          total: sale.total,
          userId: currentUser.id,
          vatDetails: (isC ? [] : vatDetails).map((v) => ({
            vatId: v.id,
            baseAmount: String(v.baseAmount),
            vatAmount: String(v.amount),
          })),
        },
        {
          cae: res.cae,
          caeExpiry: res.caeExpiry ? this.parseArcaDate(res.caeExpiry) : null,
          observations: res.observations,
          qrUrl,
        },
      );

      return {
        id: saved.id,
        label: voucherLabel(letter, 'invoice'),
        letter,
        salePoint: input.salePoint,
        number: res.number,
        cae: res.cae,
        caeExpiry: saved.caeExpiry,
        total: sale.total,
        qrUrl,
        observations: res.observations,
      };
    } catch (err) {
      // Deja constancia del rechazo para diagnóstico, sin consumir numeración.
      repos.fiscal.recordFailure({
        voucherCode,
        letter,
        kind: 'invoice',
        salePoint: input.salePoint,
        number: nextNumber,
        customerId: customer.id,
        customerDocType: doc.docType,
        customerDocNumber: doc.docNumber,
        customerName: customer.lastName,
        total: sale.total,
        userId: currentUser.id,
        errors: [err instanceof Error ? err.message : String(err)],
        saleId: sale.id,
      });
      throw err;
    }
  }

  /**
   * Emite una nota de crédito o débito sobre un comprobante existente.
   * ARCA exige referenciar el comprobante original.
   */
  async issueNote(input: IssueNoteInput): Promise<IssuedVoucher> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'void_sale');
    const cfg = this.requireConfig();

    const related = repos.fiscal.findVoucherById(input.relatedVoucherId);
    if (!related) throw new NotFoundError('Comprobante', input.relatedVoucherId);
    if (related.status !== 'approved') {
      throw new BusinessRuleError(
        'related_not_approved',
        'Solo se puede ajustar un comprobante autorizado por ARCA',
      );
    }

    const letter = related.letter as VoucherLetter;
    const kind: VoucherKind = input.kind;
    const voucherCode = resolveVoucherCode(letter, kind);
    const total = input.total ?? related.total;

    // La nota hereda la proporción de IVA del comprobante original.
    const originalVat = repos.fiscal.vatDetailsFor(related.id);
    const ratio = Number(related.total) !== 0 ? Number(total) / Number(related.total) : 1;
    const vatDetails = originalVat.map((v) => ({
      id: v.vatId,
      baseAmount: n2(Number(v.baseAmount) * ratio),
      amount: n2(Number(v.vatAmount) * ratio),
    }));
    const netAmount = n2(Number(related.netAmount) * ratio);
    const vatAmount = n2(Number(related.vatAmount) * ratio);

    const nextNumber = (await this.gateway.lastAuthorized(related.salePoint, voucherCode)) + 1;
    const date = Date.now();

    const res = await this.gateway.requestCae({
      salePoint: related.salePoint,
      voucherCode,
      number: nextNumber,
      date,
      docType: related.customerDocType,
      docNumber: related.customerDocNumber,
      netAmount,
      vatAmount,
      exemptAmount: 0,
      untaxedAmount: 0,
      total: n2(total),
      vatDetails,
      associated: [
        {
          voucherCode: related.voucherCode,
          salePoint: related.salePoint,
          number: related.number,
        },
      ],
    });

    const qrUrl = this.gateway.buildQrUrl({
      cuit: cfg.cuit,
      ptoVta: related.salePoint,
      tipoCmp: voucherCode,
      nroCmp: res.number,
      importe: n2(total),
      tipoDocRec: related.customerDocType,
      nroDocRec: related.customerDocNumber,
      codAut: res.cae,
      fecha: new Date(date).toISOString().slice(0, 10).replace(/-/g, ''),
    });

    const saved = repos.fiscal.createVoucher(
      {
        voucherCode,
        letter,
        kind,
        salePoint: related.salePoint,
        number: res.number,
        date,
        saleId: related.saleId,
        relatedVoucherId: related.id,
        customerId: related.customerId,
        customerDocType: related.customerDocType,
        customerDocNumber: related.customerDocNumber,
        customerName: related.customerName,
        netAmount: String(netAmount),
        vatAmount: String(vatAmount),
        total: String(total),
        userId: currentUser.id,
        vatDetails: vatDetails.map((v) => ({
          vatId: v.id,
          baseAmount: String(v.baseAmount),
          vatAmount: String(v.amount),
        })),
      },
      {
        cae: res.cae,
        caeExpiry: res.caeExpiry ? this.parseArcaDate(res.caeExpiry) : null,
        observations: res.observations,
        qrUrl,
      },
    );

    return {
      id: saved.id,
      label: voucherLabel(letter, kind),
      letter,
      salePoint: related.salePoint,
      number: res.number,
      cae: res.cae,
      caeExpiry: saved.caeExpiry,
      total: String(total),
      qrUrl,
      observations: res.observations,
    };
  }

  /** YYYYMMDD → epoch ms. */
  private parseArcaDate(v: string): number | null {
    if (!/^\d{8}$/.test(v)) return null;
    return new Date(
      Number(v.slice(0, 4)),
      Number(v.slice(4, 6)) - 1,
      Number(v.slice(6, 8)),
    ).getTime();
  }

  /** Comprobante fiscal de una venta (para reimprimir con CAE). */
  getVoucherForSale(saleId: string) {
    return this.ctx.repos.fiscal.findVoucherBySale(saleId);
  }

  /** Libro IVA Ventas: comprobantes emitidos en un rango. */
  listVouchers(input: { from?: number; to?: number; limit?: number } = {}) {
    requirePermission(this.ctx.currentUser, 'view_accounting');
    return this.ctx.repos.fiscal.listVouchers(input);
  }
}

/** Códigos de documento re-exportados para la capa IPC. */
export { DOC_TYPES };
