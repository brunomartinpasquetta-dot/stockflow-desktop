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
  RECEIVER_VAT_CONDITION_IDS,
  VAT_RATE_BY_ID,
  arcaAmounts,
  defaultReceiverVatConditionForLetter,
  isReceiverVatConditionAllowed,
  resolveCustomerDoc,
  resolveReceiverVatConditionId,
  resolveVoucherCode,
  resolveVoucherLetter,
  validateForLetter,
  voucherLabel,
  type CustomerVatCategory,
  type IssuerVatCondition,
  type VoucherKind,
  type VoucherLetter,
} from "@stockflow/shared";

import { requirePermission } from "../auth/permissions";
import type { ServiceContext } from "../context";
import { BusinessRuleError, NotFoundError, ValidationError } from "../errors";

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
    /** Condición IVA del receptor (`CondicionIVAReceptorId`, RG 5616). */
    receiverVatConditionId: number;
    netAmount: number;
    vatAmount: number;
    exemptAmount: number;
    untaxedAmount: number;
    total: number;
    vatDetails: { id: number; baseAmount: number; amount: number }[];
    associated?: { voucherCode: number; salePoint: number; number: number }[];
  }): Promise<{
    cae: string;
    caeExpiry: string;
    number: number;
    observations: string[];
  }>;
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
  /**
   * Comprobante ya emitido según ARCA (`FECompConsultar`), o `null` si no
   * existe. Sirve para recuperar un CAE cuya respuesta se perdió en la red.
   */
  findVoucher?(
    salePoint: number,
    voucherCode: number,
    number: number,
  ): Promise<{
    cae: string;
    caeExpiry: string;
    total: number;
    /** YYYYMMDD */
    date: string;
    docType: number;
    docNumber: string;
  } | null>;
}

export interface IssueInvoiceInput {
  saleId: string;
  salePoint: number;
  /** Fuerza la letra (por defecto se deduce del cliente). */
  letter?: VoucherLetter;
  /**
   * Documento del receptor cargado EN LA VENTA. Pisa el de la ficha del
   * cliente: al que pide factura en el mostrador se le toma el documento en el
   * momento, sin darlo de alta como cliente.
   */
  receiverDoc?: { docType?: string | null; docNumber?: string | null };
}

export interface IssueNoteInput {
  /** Comprobante que se ajusta. */
  relatedVoucherId: string;
  kind: "credit_note" | "debit_note";
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

/**
 * Si el error deja abierta la posibilidad de que ARCA haya autorizado igual:
 * el pedido salió pero la respuesta no volvió (timeout o corte de red, los
 * códigos que pone `WsfeClient`). Un rechazo de ARCA o un error local (WSAA,
 * certificado) no entran: ahí el comprobante seguro no se emitió.
 */
function respuestaPerdida(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "TIMEOUT" || code === "NETWORK";
}

/**
 * YYYYMMDD en hora LOCAL, igual que `toArcaDate` de WsfeClient (que arma el
 * `CbteFch` real enviado a ARCA). El QR (RG 4892) tiene que declarar la misma
 * fecha que el comprobante: usar `.toISOString()` acá metía el desfasaje de
 * `UTC−3` — una factura emitida entre las 21:00 y medianoche quedaba con el
 * QR fechado al día siguiente del CbteFch real.
 */
export function fechaArcaLocal(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Candado por (punto de venta, tipo de comprobante): dos terminales que
 * facturan a la vez consultaban el mismo "último autorizado" y pedían el mismo
 * número; ARCA rechazaba a la segunda y el cajero veía un error sin
 * explicación. Con el candado, la segunda espera y pide el número siguiente.
 * (Vale dentro de un proceso: el servidor LAN es uno solo.)
 */
const emisionEnCurso = new Map<string, Promise<void>>();
async function conCandadoDeEmision<T>(
  clave: string,
  fn: () => Promise<T>,
): Promise<T> {
  const anterior = emisionEnCurso.get(clave) ?? Promise.resolve();
  let liberar: () => void = () => {};
  const mia = new Promise<void>((r) => {
    liberar = r;
  });
  const cola = anterior.then(() => mia);
  emisionEnCurso.set(clave, cola);
  await anterior;
  try {
    return await fn();
  } finally {
    liberar();
    if (emisionEnCurso.get(clave) === cola) emisionEnCurso.delete(clave);
  }
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
        "fiscal_disabled",
        "La facturación electrónica no está configurada. Andá a Configuración → Facturación electrónica.",
      );
    }
    if (!cfg.cuit) {
      throw new ValidationError(
        "cuit",
        "Falta el CUIT del emisor en la configuración fiscal",
      );
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
    requirePermission(currentUser, "create_sale");
    const cfg = this.requireConfig();

    const existing = repos.fiscal.findVoucherBySale(input.saleId);
    if (existing) {
      throw new BusinessRuleError(
        "already_invoiced",
        `Esta venta ya tiene ${voucherLabel(existing.letter, existing.kind)} ${String(
          existing.salePoint,
        ).padStart(5, "0")}-${String(existing.number).padStart(8, "0")}`,
      );
    }

    const sale = await repos.sales.findById(input.saleId);
    if (!sale) throw new NotFoundError("Venta", input.saleId);
    if (sale.status === "voided") {
      throw new BusinessRuleError(
        "sale_voided",
        "No se puede facturar una venta anulada",
      );
    }

    const customer = await repos.customers.findById(sale.customerId);
    if (!customer) throw new NotFoundError("Cliente", sale.customerId);

    const issuer = cfg.vatCondition as IssuerVatCondition;
    const letter =
      input.letter ??
      resolveVoucherLetter(issuer, customer.category as CustomerVatCategory);
    // La letra tiene que ser una que ESTE emisor pueda emitir: un monotributista
    // sólo emite C y un responsable inscripto A o B. El desplegable de Ventas
    // ofrecía las tres a cualquiera; ARCA rechazaba y el reintento repetía.
    if (issuer === "MT" ? letter !== "C" : letter === "C") {
      throw new ValidationError(
        "letter",
        issuer === "MT"
          ? "Un emisor Monotributista sólo puede emitir Factura C."
          : "Un emisor Responsable Inscripto emite Factura A o B, no C.",
      );
    }
    const doc = resolveCustomerDoc(
      (input.receiverDoc?.docType ?? customer.docType) as Parameters<
        typeof resolveCustomerDoc
      >[0],
      input.receiverDoc?.docNumber ?? customer.docNumber,
    );
    // Condición IVA del receptor: sale de la categoría fiscal del cliente y es
    // obligatoria en todo comprobante (RG 5616), consumidor final incluido.
    let receiverVatConditionId = resolveReceiverVatConditionId(
      customer.category as CustomerVatCategory,
    );
    // Factura A "de mostrador": la ficha es Consumidor Final pero se cargó un
    // CUIT en la venta. Ese CUIT identifica a un responsable inscripto; si se
    // informara la condición de la ficha (5) la validación rechazaría la A y la
    // venta quedaría sin CAE, irrecuperable desde el Historial.
    // Sólo aplica a la ficha CONSUMIDOR FINAL: un Exento o un Monotributista
    // con ficha propia no se convierten en RI por tener CUIT (la validación de
    // abajo los frena, como corresponde: a un exento no se le emite A).
    if (
      letter === "A" &&
      doc.docType === DOC_TYPES.CUIT &&
      customer.category === "CF" &&
      !isReceiverVatConditionAllowed(receiverVatConditionId, "A")
    ) {
      receiverVatConditionId = RECEIVER_VAT_CONDITION_IDS.RI;
    }
    const check = validateForLetter(letter, doc, receiverVatConditionId);
    if (!check.ok) throw new ValidationError("customer", check.reason);

    const voucherCode = resolveVoucherCode(letter, "invoice");

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
    const priceMode = company?.priceMode === "net" ? "net" : "gross";

    // Importes al centavo con las identidades que ARCA valida (neto + IVA =
    // total, Σ bases = neto), con el descuento global ya prorrateado.
    const amounts = arcaAmounts(
      lines.map((l) => ({
        lineTotal: l.lineTotal,
        vatRate: l.vatRate ?? "21.00",
      })),
      sale.discount ?? "0",
      priceMode,
    );
    const total = amounts.total;

    // Factura C (monotributo): no se discrimina IVA — todo va como neto.
    const isC = letter === "C";
    const netAmount = isC ? total : amounts.netAmount;
    const vatAmount = isC ? 0 : amounts.vatAmount;
    const vatDetails = isC ? [] : amounts.vatDetails;

    const persistir = (
      res: {
        cae: string;
        caeExpiry: string;
        number: number;
        observations: string[];
      },
      date: number,
    ): IssuedVoucher => {
      const qrUrl = this.gateway.buildQrUrl({
        cuit: cfg.cuit,
        ptoVta: input.salePoint,
        tipoCmp: voucherCode,
        nroCmp: res.number,
        importe: total,
        tipoDocRec: doc.docType,
        nroDocRec: doc.docNumber,
        codAut: res.cae,
        fecha: fechaArcaLocal(date),
      });

      const saved = repos.fiscal.createVoucher(
        {
          voucherCode,
          letter,
          kind: "invoice",
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
          customerVatConditionId: receiverVatConditionId,
          netAmount: String(netAmount),
          vatAmount: String(vatAmount),
          total: sale.total,
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
        label: voucherLabel(letter, "invoice"),
        letter,
        salePoint: input.salePoint,
        number: res.number,
        cae: res.cae,
        caeExpiry: saved.caeExpiry,
        total: sale.total,
        qrUrl,
        observations: res.observations,
      };
    };

    return conCandadoDeEmision(
      `${input.salePoint}:${voucherCode}`,
      async () => {
        const last = await this.gateway.lastAuthorized(
          input.salePoint,
          voucherCode,
        );

        // REINTENTO: si un intento anterior de ESTA venta se quedó sin respuesta
        // (timeout o corte de red después de mandar el pedido), ARCA pudo haberlo
        // autorizado igual. Antes de emitir otro —y facturar dos veces la misma
        // venta— se consulta el número que ESE intento pidió: si existe y coincide
        // en importe, fecha y documento, se adopta. Se mira el número pedido y no
        // el último autorizado porque entre el corte y el reintento otra terminal
        // (o el mismo cajero, que sigue vendiendo) pudo emitir los siguientes. Un
        // rechazo explícito de ARCA no entra: ahí el comprobante seguro no existe,
        // y consultar "el último" podía adoptar uno ajeno del mismo importe (base
        // migrada con comprobantes que no están acá, consumidor final).
        if (this.gateway.findVoucher) {
          for (const intento of repos.fiscal.findFailuresBySale(sale.id)) {
            const nro = intento.requestedNumber;
            if (intento.status !== "error" || nro == null || nro > last)
              continue;
            // Sólo un intento del MISMO tipo y punto de venta: una B perdida que se
            // reintenta como A no puede adoptar el número de la B.
            if (
              intento.voucherCode !== voucherCode ||
              intento.salePoint !== input.salePoint
            )
              continue;
            // Si ese número ya es de otra venta en esta base, no hay nada que adoptar.
            if (
              repos.fiscal.findVoucherByNumber(
                voucherCode,
                input.salePoint,
                nro,
              )
            )
              continue;
            const emitido = await this.gateway.findVoucher(
              input.salePoint,
              voucherCode,
              nro,
            );
            if (
              emitido &&
              emitido.cae &&
              n2(emitido.total) === total &&
              emitido.date === fechaArcaLocal(intento.date) &&
              emitido.docType === doc.docType &&
              emitido.docNumber.replace(/\D/g, "") ===
                doc.docNumber.replace(/\D/g, "")
            ) {
              return persistir(
                {
                  cae: emitido.cae,
                  caeExpiry: emitido.caeExpiry,
                  number: nro,
                  observations: [],
                },
                intento.date,
              );
            }
          }
        }

        const nextNumber = last + 1;
        const date = Date.now();

        try {
          const res = await this.gateway.requestCae({
            salePoint: input.salePoint,
            voucherCode,
            number: nextNumber,
            date,
            docType: doc.docType,
            docNumber: doc.docNumber,
            receiverVatConditionId,
            netAmount,
            vatAmount,
            exemptAmount: 0,
            untaxedAmount: 0,
            total,
            vatDetails,
          });
          return persistir(res, date);
        } catch (err) {
          // Deja constancia del intento para diagnóstico y para el reintento (qué
          // número se pidió y si ARCA llegó a contestar), sin consumir numeración.
          repos.fiscal.recordFailure({
            voucherCode,
            letter,
            kind: "invoice",
            salePoint: input.salePoint,
            number: nextNumber,
            customerId: customer.id,
            customerDocType: doc.docType,
            customerDocNumber: doc.docNumber,
            customerName: customer.lastName,
            customerVatConditionId: receiverVatConditionId,
            total: sale.total,
            userId: currentUser.id,
            errors: [err instanceof Error ? err.message : String(err)],
            saleId: sale.id,
            responseLost: respuestaPerdida(err),
          });
          throw err;
        }
      },
    );
  }

  /**
   * Emite una nota de crédito o débito sobre un comprobante existente.
   * ARCA exige referenciar el comprobante original.
   */
  async issueNote(input: IssueNoteInput): Promise<IssuedVoucher> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, "void_sale");
    const cfg = this.requireConfig();

    const related = repos.fiscal.findVoucherById(input.relatedVoucherId);
    if (!related)
      throw new NotFoundError("Comprobante", input.relatedVoucherId);
    if (related.status !== "approved") {
      throw new BusinessRuleError(
        "related_not_approved",
        "Solo se puede ajustar un comprobante autorizado por ARCA",
      );
    }

    const letter = related.letter as VoucherLetter;
    const kind: VoucherKind = input.kind;
    const voucherCode = resolveVoucherCode(letter, kind);
    const total = input.total ?? related.total;
    // Importe: mayor a cero, y una nota de crédito no puede superar lo que
    // queda del comprobante (original − notas de crédito ya autorizadas).
    if (!(Number(total) > 0) || !Number.isFinite(Number(total))) {
      throw new ValidationError(
        "total",
        "El importe de la nota debe ser mayor a cero",
      );
    }
    if (kind === "credit_note") {
      const acreditado = repos.fiscal
        .listVouchers({ kind: "credit_note" })
        .filter((v) => v.relatedVoucherId === related.id)
        .reduce((acc, v) => acc + Number(v.total), 0);
      const disponible = Number(related.total) - acreditado;
      if (Number(total) > disponible + 0.005) {
        throw new ValidationError(
          "total",
          `La nota de crédito (${Number(total).toFixed(2)}) supera lo que queda del comprobante: ${Math.max(0, disponible).toFixed(2)} de ${Number(related.total).toFixed(2)}${acreditado > 0 ? ` (ya se acreditaron ${acreditado.toFixed(2)})` : ""}`,
        );
      }
    }

    // La nota hereda la proporción de IVA del comprobante original: cada
    // alícuota se escala al importe de la nota y se vuelve a cerrar al centavo
    // con la misma regla que la factura (neto + IVA = total, Σ bases = neto).
    // Escalar y redondear cada parte por separado dejaba sumas que no cerraban.
    const originalVat = repos.fiscal.vatDetailsFor(related.id);
    // La proporción se toma contra la suma de las alícuotas guardadas y no
    // contra el total del comprobante: en los emitidos con el cálculo viejo
    // esa suma podía diferir un centavo del total, y la nota heredaba el desvío.
    const sumaOriginal = originalVat.reduce(
      (acc, v) => acc + Number(v.baseAmount) + Number(v.vatAmount),
      0,
    );
    const ratio = sumaOriginal !== 0 ? Number(total) / sumaOriginal : 1;
    const amounts = arcaAmounts(
      originalVat.map((v) => ({
        lineTotal: (
          (Number(v.baseAmount) + Number(v.vatAmount)) *
          ratio
        ).toFixed(4),
        vatRate: VAT_RATE_BY_ID[v.vatId] ?? "21.00",
      })),
      "0",
      "gross",
    );
    // Sin detalle de alícuotas (Factura C, o comprobante sin desglose): todo
    // neto, como en la factura.
    const sinDetalle = originalVat.length === 0;
    const totalArca = sinDetalle ? n2(total) : amounts.total;
    const vatDetails = sinDetalle ? [] : amounts.vatDetails;
    const netAmount = sinDetalle ? totalArca : amounts.netAmount;
    const vatAmount = sinDetalle ? 0 : amounts.vatAmount;

    // La nota repite la condición IVA del receptor del comprobante que ajusta.
    const receiverVatConditionId =
      related.customerVatConditionId ??
      (await this.receiverVatConditionFor(related));

    return conCandadoDeEmision(
      `${related.salePoint}:${voucherCode}`,
      async () => {
        const nextNumber =
          (await this.gateway.lastAuthorized(related.salePoint, voucherCode)) +
          1;
        const date = Date.now();

        const res = await this.gateway.requestCae({
          salePoint: related.salePoint,
          voucherCode,
          number: nextNumber,
          date,
          docType: related.customerDocType,
          docNumber: related.customerDocNumber,
          receiverVatConditionId,
          netAmount,
          vatAmount,
          exemptAmount: 0,
          untaxedAmount: 0,
          total: totalArca,
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
          importe: totalArca,
          tipoDocRec: related.customerDocType,
          nroDocRec: related.customerDocNumber,
          codAut: res.cae,
          fecha: fechaArcaLocal(date),
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
            customerVatConditionId: receiverVatConditionId,
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
      },
    );
  }

  /**
   * Condición IVA del receptor para ajustar un comprobante emitido ANTES de que
   * el sistema la informara (no la tiene guardada). Se toma la categoría actual
   * del cliente si ARCA la admite para esa letra; si no, la típica de la letra.
   */
  private async receiverVatConditionFor(related: {
    letter: string;
    customerId: string;
  }): Promise<number> {
    const letter = related.letter as VoucherLetter;
    const customer = await this.ctx.repos.customers.findById(
      related.customerId,
    );
    if (customer) {
      const id = resolveReceiverVatConditionId(
        customer.category as CustomerVatCategory,
      );
      if (isReceiverVatConditionAllowed(id, letter)) return id;
    }
    return defaultReceiverVatConditionForLetter(letter);
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
    requirePermission(this.ctx.currentUser, "view_accounting");
    return this.ctx.repos.fiscal.listVouchers(input);
  }
}

/** Códigos de documento re-exportados para la capa IPC. */
export { DOC_TYPES };
