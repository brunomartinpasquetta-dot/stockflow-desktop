/**
 * Servicio de ventas: orquesta SaleRepository + stock + cuentas corrientes y
 * aplica reglas de negocio (permisos, caja abierta, resolución de precios).
 */
import type {
  AccountReceivable,
  Sale,
  SaleLine,
  SalePayment,
  VoucherType,
} from '@stockflow/shared';
import { cmpDecimal, sumDecimals } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import { type ServiceContext, cajaAbiertaDeTerminal } from '../context';
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors';
import {
  type PriceMode,
  type SaleTotals,
  type SaleTotalsLineInput,
  calculateSaleTotals,
  resolvePrice,
} from '../pricing';

/** Línea tal como llega del front: el precio puede resolverse automáticamente. */
export interface SaleLineDraft {
  /**
   * Si falta, es un ARTÍCULO RÁPIDO: algo que no está en el catálogo. Entonces
   * `description` y `unitPrice` son obligatorios y la línea no mueve stock.
   */
  articleId?: string;
  /** Descripción escrita a mano. Sólo para artículo rápido. */
  description?: string;
  quantity: string;
  /** Si se omite, se resuelve por lista del cliente / precio mayorista. */
  unitPrice?: string;
  /** Descuento absoluto sobre la línea. */
  discount?: string;
  /** Si se omite, se toma del artículo. */
  vatRate?: string;
}

/** Un pago de la venta (un medio de pago + monto). */
export interface SalePaymentDraft {
  paymentMethodId: string;
  amount: string;
  reference?: string | null;
}

export interface CreateSaleInput {
  type: VoucherType;
  customerId: string;
  /** true = venta a cuenta corriente (no lleva pagos; abre una AR). */
  isAccountSale?: boolean;
  /** Pagos de la venta; obligatorio (≥1) si NO es a cuenta corriente. */
  payments?: SalePaymentDraft[];
  /** Descuento global (absoluto) sobre el total. */
  discount?: string;
  notes?: string | null;
  lines: SaleLineDraft[];
  /**
   * Clave única del intento de cobro (uuid que genera la pantalla). Si la
   * misma venta llega dos veces —la respuesta se perdió en la red y el cajero
   * volvió a cobrar el mismo carrito—, se devuelve la ya registrada en vez de
   * crear otra. Ausente = sin protección (terminal vieja, procesos internos).
   */
  idempotencyKey?: string | null;
}

export interface CreateSaleResult {
  sale: Sale;
  lines: SaleLine[];
  payments: SalePayment[];
  accountReceivable: AccountReceivable | null;
}

/*
 * Cualquier cliente cargado puede comprar en cuenta corriente.
 *
 * Antes se exigía tipo y número de documento y la venta se frenaba con "falta
 * documento identificatorio". No tiene fundamento: fiarle a un cliente NO es
 * emitir un comprobante fiscal —el documento hace falta para la Factura A, y
 * eso se valida al facturar— y el comercio ya lo tiene identificado por su
 * ficha. En Leo Citzia, 60 de 63 clientes no tenían documento porque nunca lo
 * necesitaron: la regla dejaba la cuenta corriente inutilizable justo en el
 * cliente que más la usa.
 */

export class SalesService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Cálculo puro de totales (preview en UI), sin tocar la DB. */
  static calculateTotals(
    lines: ReadonlyArray<SaleTotalsLineInput>,
    globalDiscount?: string,
    mode: PriceMode = 'gross',
  ): SaleTotals {
    return calculateSaleTotals(lines, globalDiscount, mode);
  }

  private async resolveOpenRegister() {
    // La caja de la PC que vende (caja por terminal), no la última abierta.
    const reg = await cajaAbiertaDeTerminal(this.ctx);
    if (!reg) {
      throw new BusinessRuleError('no_open_cash_register', 'No hay una caja abierta');
    }
    return reg;
  }

  async createSale(input: CreateSaleInput): Promise<CreateSaleResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'create_sale');

    // VENTA REPETIDA: antes que cualquier otra validación. Si la primera vez
    // entró y la respuesta se perdió, la caja pudo cerrarse o el stock cambiar
    // en el medio: igual hay que devolver la venta que ya existe, no fallar ni
    // crear otra.
    if (input.idempotencyKey) {
      const previa = await repos.sales.findByIdempotencyKey(input.idempotencyKey, {
        customerId: input.customerId,
        type: input.type,
      });
      if (previa) return previa;
    }

    const draft = input;
    const lines = input.lines;
    if (lines.length === 0) {
      throw new BusinessRuleError('empty_sale', 'La venta debe tener al menos una línea');
    }
    const isAccountSale = draft.isAccountSale === true;
    const payments = isAccountSale ? [] : (draft.payments ?? []);

    const register = await this.resolveOpenRegister();

    const customer = await repos.customers.findById(draft.customerId);
    if (!customer) throw new NotFoundError('Cliente', draft.customerId);

    // Espejo del bloqueo del front (Ventas.tsx isCfCustomer): el CONSUMIDOR
    // FINAL no lleva cuenta corriente — sin ficha real no hay a quién cobrarle.
    // El front ya lo impide; esto cierra la puerta por IPC directo/LAN/tests.
    if (
      isAccountSale &&
      (customer.lastName.trim().toUpperCase() === 'CONSUMIDOR FINAL' || customer.docType === 'CF')
    ) {
      throw new BusinessRuleError(
        'account_sale_consumer_final',
        'El CONSUMIDOR FINAL no puede comprar a cuenta corriente. Seleccione un cliente con ficha.',
      );
    }

    if (!isAccountSale && payments.length === 0) {
      throw new BusinessRuleError('no_payments', 'La venta debe registrar al menos un pago');
    }

    // Resolver precios e IVA línea por línea.
    const resolvedLines = [] as Array<{
      articleId?: string;
      description?: string;
      quantity: string;
      unitPrice: string;
      discount: string;
      vatRate: string;
    }>;
    for (const line of lines) {
      // ARTÍCULO RÁPIDO: sin artículo no hay lista de precios ni IVA de ficha
      // que consultar, así que el precio y la alícuota vienen de la pantalla.
      if (!line.articleId) {
        const description = line.description?.trim();
        if (!description) {
          throw new ValidationError('lines', 'Un artículo rápido necesita una descripción');
        }
        if (!line.unitPrice) {
          throw new ValidationError('lines', `Falta el precio de "${description}"`);
        }
        resolvedLines.push({
          description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discount: line.discount ?? '0.0000',
          vatRate: line.vatRate ?? '21.00',
        });
        continue;
      }

      const article = await repos.articles.findById(line.articleId);
      if (!article) throw new NotFoundError('Artículo', line.articleId);
      const unitPrice = line.unitPrice ?? resolvePrice(article, customer, line.quantity);
      resolvedLines.push({
        articleId: line.articleId,
        quantity: line.quantity,
        unitPrice,
        discount: line.discount ?? '0.0000',
        vatRate: line.vatRate ?? article.vatRate,
      });
    }

    // Totales (preview): replica el cálculo del repositorio, según el modo de precios.
    const company = await repos.company.getOrCreate();
    const mode: PriceMode = company.priceMode === 'net' ? 'net' : 'gross';
    const preview = calculateSaleTotals(resolvedLines, draft.discount ?? '0.0000', mode);

    if (!isAccountSale) {
      // La suma de los pagos debe ser EXACTAMENTE igual al total (no hay vuelto).
      const paidSum = sumDecimals(payments.map((p) => p.amount));
      const cmp = cmpDecimal(paidSum, preview.total);
      if (cmp > 0) {
        throw new ValidationError('payments', 'Los pagos exceden el total de la venta');
      }
      if (cmp < 0) {
        throw new ValidationError('payments', 'Los pagos no cubren el total de la venta');
      }
    }

    // Límite de crédito (creditLimit '0.0000' = sin límite).
    if (isAccountSale && Number(customer.creditLimit) > 0) {
      const currentBalance = await repos.accountsReceivable.getTotalBalance(customer.id);
      if (Number(currentBalance) + Number(preview.total) > Number(customer.creditLimit)) {
        throw new BusinessRuleError(
          'credit_limit_exceeded',
          `Se supera el límite de crédito del cliente (${customer.creditLimit})`,
        );
      }
    }

    // La transacción atómica (cabecera + líneas + stock + pagos + caja + AR de
    // cuenta corriente, BUG-S03) la hace el repo. Todo o nada.
    const {
      sale,
      lines: savedLines,
      payments: savedPayments,
      accountReceivable,
    } = await repos.sales.createWithLines({
      type: draft.type,
      customerId: customer.id,
      sellerId: currentUser.id,
      cashRegisterId: register.id,
      isAccountSale,
      payments,
      discount: draft.discount ?? '0.0000',
      // El límite se revalida DENTRO de la transacción del repo (defensa contra
      // dos ventas a cuenta concurrentes que superan el límite — caso LAN). El
      // chequeo de arriba es sólo defensa temprana. '0.0000' = sin límite.
      creditLimit: customer.creditLimit,
      notes: draft.notes ?? null,
      lines: resolvedLines,
      idempotencyKey: draft.idempotencyKey ?? null,
    });

    return { sale, lines: savedLines, payments: savedPayments, accountReceivable };
  }

  /**
   * Anula una venta: revierte stock y caja (vía repo) y, si la venta había abierto
   * una cuenta corriente sin pagos, la elimina. Falla si la cuenta ya recibió pagos.
   */
  async voidSale(saleId: string, reason: string | null = null): Promise<Sale> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'void_sale');

    const sale = await repos.sales.findById(saleId);
    if (!sale) throw new NotFoundError('Venta', saleId);
    if (sale.status === 'voided') {
      throw new BusinessRuleError('sale_already_voided', `La venta ${saleId} ya está anulada`);
    }

    const account = await repos.accountsReceivable.findOne({ saleId });
    if (account) {
      const payments = await repos.payments.findByAccount(account.id);
      if (payments.length > 0) {
        throw new BusinessRuleError(
          'cannot_void_account_sale_with_payments',
          'No se puede anular una venta en cuenta corriente que ya recibió pagos',
        );
      }
    }

    // La cuenta corriente (si la hay) se cierra dentro de la misma transacción
    // del repositorio.
    // Si la caja original ya cerró, el efectivo sale del cajón de la PC que
    // anula (caja por terminal), no de la última caja abierta de cualquiera.
    const cajaReverso = await cajaAbiertaDeTerminal(this.ctx);
    const { reversoElectronico, ...voided } = await repos.sales.voidSale(saleId, {
      reason,
      userName: currentUser.fullName,
      cajaReversoId: cajaReverso?.id ?? null,
    });
    await this.reflejarReintegroElectronicoEnCajaGeneral(sale, reversoElectronico);
    return voided;
  }

  /**
   * El reverso ELECTRÓNICO de una venta anulada entra a la caja ORIGINAL de la
   * venta. Si esa caja ya cerró y su neto electrónico ya se había ingresado a
   * Caja General, el reintegro sale de la cuenta del comercio: se registra la
   * salida en Caja General (electrónico) por la parte que ya no está cubierta
   * por lo no ingresado. Best-effort y fuera de la transacción de la venta: la
   * anulación ya quedó hecha; si esto falla, queda en el log para corregirlo.
   */
  private async reflejarReintegroElectronicoEnCajaGeneral(sale: Sale, reversoElectronico: string): Promise<void> {
    const { repos, currentUser } = this.ctx;
    if (!(Number(reversoElectronico) > 0)) return;
    try {
      const origen = await repos.cashRegisters.findById(sale.cashRegisterId);
      if (!origen || origen.status !== 'closed') return;
      const dep = (await repos.cashGeneral.closeDepositRefIds([origen.id])).get(origen.id);
      const depositadoElec = Number(dep?.electronic ?? 0);
      if (!(depositadoElec > 0)) return;
      const [movs, pmById] = await Promise.all([
        repos.cashMovements.findByRegister(origen.id),
        repos.paymentMethods.byId(),
      ]);
      let netoDespues = 0;
      for (const mv of movs) {
        const fisico = mv.paymentMethodId == null || pmById.get(mv.paymentMethodId)?.isPhysicalCash === true;
        if (fisico) continue;
        netoDespues += mv.type === 'income' ? Number(mv.amount) : -Number(mv.amount);
      }
      // Antes de este reverso, cuánto electrónico había en la caja SIN ingresar
      // a Caja General: eso absorbe el reintegro; el resto ya estaba allá.
      const netoAntes = netoDespues + Number(reversoElectronico);
      const sinIngresar = Math.max(0, netoAntes - depositadoElec);
      const exceso = Math.max(0, Number(reversoElectronico) - sinIngresar);
      if (exceso < 0.005) return;
      await repos.cashGeneral.addMovement({
        type: 'expense',
        amount: exceso.toFixed(2),
        description: `Anulación venta ${sale.type} #${sale.number}: reintegro electrónico de un cierre ya ingresado (caja #${origen.number})`,
        category: 'other',
        createdBy: currentUser.id,
        referenceId: sale.id,
        isCash: false,
      });
    } catch (e) {
      console.error(`[voidSale] no se pudo reflejar el reintegro electrónico en Caja General (venta ${sale.id}):`, e);
    }
  }

  /**
   * Anula EN LOTE las ventas de un rango. Nació para limpiar de un saque las
   * ventas de prueba del día cuando se está poniendo en marcha un local: a mano
   * son decenas de confirmaciones.
   *
   * Dos decisiones:
   *
   * 1. **No borra: anula.** Cada venta pasa por `voidSale`, así que el stock y
   *    la caja se revierten exactamente igual que anulando una por una. Las
   *    ventas siguen en el historial marcadas como anuladas, que es lo que
   *    corresponde y lo que después mira el contador.
   *
   * 2. **No se corta ante el primer problema.** Una venta a cuenta corriente
   *    que ya recibió un pago no se puede anular; si eso abortara el lote,
   *    quedaría todo a medias y sin saber dónde cortó. Se saltea, se sigue, y
   *    al final se informa cuáles quedaron afuera y por qué.
   *
   * Ojo con `conCAE`: el CAE ya lo otorgó ARCA y anular acá NO lo da de baja
   * allá. Eso se arregla emitiendo una nota de crédito.
   */
  async voidSalesInRange(
    from: number,
    to: number,
  ): Promise<{
    anuladas: number;
    conCAE: number;
    omitidas: { number: number; motivo: string }[];
  }> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'void_sale');

    const enRango = await repos.sales.findByDateRange(from, to);
    const pendientes = enRango.filter((s) => s.status !== 'voided');

    let anuladas = 0;
    let conCAE = 0;
    const omitidas: { number: number; motivo: string }[] = [];

    for (const venta of pendientes) {
      try {
        await this.voidSale(venta.id);
        anuladas += 1;
        if (venta.afipCAE) conCAE += 1;
      } catch (err) {
        omitidas.push({
          number: venta.number,
          motivo: err instanceof Error ? err.message : 'No se pudo anular',
        });
      }
    }

    return { anuladas, conCAE, omitidas };
  }

  async getSale(
    saleId: string,
  ): Promise<{ sale: Sale; lines: SaleLine[]; payments: SalePayment[] }> {
    const { repos } = this.ctx;
    const sale = await repos.sales.findById(saleId);
    if (!sale) throw new NotFoundError('Venta', saleId);
    const [lines, payments] = await Promise.all([
      repos.saleLines.findBySale(saleId),
      repos.salePayments.findBySale(saleId),
    ]);
    // La descripción de cada artículo viaja CON la línea. Antes la pantalla
    // resolvía los nombres bajando el catálogo entero: en Leo Citzia son 6,6 MB
    // por cada venta que se abre —y por red, a una terminal Windows 7—, para
    // mostrar tres renglones. Son unas pocas consultas por id contra la misma
    // base que ya estamos leyendo.
    const conNombre = await Promise.all(
      lines.map(async (l) => {
        // Artículo rápido: la descripción la trae la propia línea y no hay
        // código que mostrar.
        if (!l.articleId) {
          return { ...l, articleDescription: l.description ?? null, articleCode: null };
        }
        const a = await repos.articles.findById(l.articleId);
        // El código va en la factura A (columna CÓDIGO): es lo que el cliente
        // usa para volver a pedir el mismo artículo.
        return { ...l, articleDescription: a?.description ?? null, articleCode: a?.barcode ?? null };
      }),
    );
    return { sale, lines: conNombre, payments };
  }
}
