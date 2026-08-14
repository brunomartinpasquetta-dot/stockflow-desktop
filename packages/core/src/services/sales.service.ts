/**
 * Servicio de ventas: orquesta SaleRepository + stock + cuentas corrientes y
 * aplica reglas de negocio (permisos, caja abierta, resolución de precios).
 */
import type {
  AccountReceivable,
  Customer,
  Sale,
  SaleLine,
  SalePayment,
  VoucherType,
} from '@stockflow/shared';
import { cmpDecimal, sumDecimals } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
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
  articleId: string;
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
    const reg =
      this.ctx.currentCashRegister && this.ctx.currentCashRegister.status === 'open'
        ? this.ctx.currentCashRegister
        : await this.ctx.repos.cashRegisters.getCurrentOpen();
    if (!reg) {
      throw new BusinessRuleError('no_open_cash_register', 'No hay una caja abierta');
    }
    return reg;
  }

  async createSale(input: CreateSaleInput): Promise<CreateSaleResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'create_sale');

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

    if (!isAccountSale && payments.length === 0) {
      throw new BusinessRuleError('no_payments', 'La venta debe registrar al menos un pago');
    }

    // Resolver precios e IVA línea por línea.
    const resolvedLines = [] as Array<{
      articleId: string;
      quantity: string;
      unitPrice: string;
      discount: string;
      vatRate: string;
    }>;
    for (const line of lines) {
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
    });

    return { sale, lines: savedLines, payments: savedPayments, accountReceivable };
  }

  /**
   * Anula una venta: revierte stock y caja (vía repo) y, si la venta había abierto
   * una cuenta corriente sin pagos, la elimina. Falla si la cuenta ya recibió pagos.
   */
  async voidSale(saleId: string): Promise<Sale> {
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

    const voided = await repos.sales.voidSale(saleId);
    if (account) {
      await repos.accountsReceivable.delete(account.id);
    }
    return voided;
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
        const a = await repos.articles.findById(l.articleId);
        return { ...l, articleDescription: a?.description ?? null };
      }),
    );
    return { sale, lines: conNombre, payments };
  }
}
