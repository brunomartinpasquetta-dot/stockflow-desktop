/**
 * Servicio de compras: orquesta PurchaseRepository (carga atómica de la compra,
 * incremento de stock, pagos / egresos de caja y, si corresponde, actualización
 * de precios y cuenta corriente con el proveedor) y aplica los permisos.
 */
import type {
  Purchase,
  PurchaseLine,
  SupplierAccountPayable,
  VoucherType,
} from '@stockflow/shared';
import { cmpDecimal, sumDecimals } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import { assertPhysicalCashAvailable } from './cash.service';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors';
import { type PriceMode, calculateSaleTotals } from '../pricing';

export interface PurchaseLineDraft {
  articleId: string;
  quantity: string;
  costPrice: string;
  /** Nuevo precio de venta sugerido (se aplica a listPrice1 si updatePrices=true). Vacío → listPrice1 actual. */
  salePrice?: string;
  /** Precios nuevos por lista, editados en pantalla. Prioridad sobre el cálculo por margen. */
  newListPrice1?: string;
  newListPrice2?: string;
  newListPrice3?: string;
  vatRate?: string;
}

export interface PurchasePaymentDraft {
  paymentMethodId: string;
  amount: string;
  reference?: string | null;
}

export interface CreatePurchaseInput {
  type: VoucherType;
  supplierId: string;
  supplierInvoiceNumber?: string | null;
  date?: number;
  /** true = compra a cuenta del proveedor (no lleva pagos; abre una cuenta por pagar). */
  isAccountPurchase?: boolean;
  /** Pagos de la compra (cuando es contado); obligatorio (≥1) si NO es a cuenta. */
  payments?: PurchasePaymentDraft[];
  /** Si true, al guardar actualiza costPrice y listPrice1 de cada artículo. */
  updatePrices?: boolean;
  /**
   * Cómo se actualizan los precios de venta al guardar:
   *  - 'manual': el precio que el usuario puso en cada renglón (lista 1). Es
   *    el comportamiento histórico de `updatePrices: true`.
   *  - 'margin': recalcula TODAS las listas con margen cargado del artículo
   *    (costo nuevo × (1 + margen/100)), redondeado a PESO ENTERO — decisión
   *    de Bruno: en góndola no van centavos.
   * Ausente: 'manual' si updatePrices, si no nada (compatibilidad LAN).
   */
  priceUpdateMode?: 'manual' | 'margin';
  discount?: string;
  notes?: string | null;
  /** Caja donde impacta el egreso (sólo si es contado). */
  cashRegisterId?: string | null;
  /**
   * Origen del dinero cuando es contado: 'daily' (caja diaria, default) o
   * 'general' (Caja General). Con 'general' el egreso baja el saldo consolidado.
   */
  fundingSource?: 'daily' | 'general';
  lines: PurchaseLineDraft[];
}

export interface CreatePurchaseResult {
  purchase: Purchase;
  lines: PurchaseLine[];
  accountPayable: SupplierAccountPayable | null;
}

export class PurchasesService {
  constructor(private readonly ctx: ServiceContext) {}

  async getNextNumber(type: VoucherType): Promise<number> {
    return this.ctx.repos.purchases.getNextNumber(type);
  }

  async createPurchase(input: CreatePurchaseInput): Promise<CreatePurchaseResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_purchases');

    if (input.lines.length === 0) {
      throw new BusinessRuleError('empty_purchase', 'La compra debe tener al menos una línea');
    }
    const isAccountPurchase = input.isAccountPurchase === true;
    const paymentType: 'cash' | 'credit' = isAccountPurchase ? 'credit' : 'cash';
    const payments = isAccountPurchase ? [] : (input.payments ?? []);
    if (!isAccountPurchase && payments.length === 0) {
      throw new BusinessRuleError('no_payments', 'La compra debe registrar al menos un pago');
    }

    const supplier = await repos.suppliers.findById(input.supplierId);
    if (!supplier) throw new NotFoundError('Proveedor', input.supplierId);

    const modoPrecios = input.priceUpdateMode ?? (input.updatePrices ? 'manual' : undefined);
    /** costo × (1 + margen%) redondeado a peso entero: $4.815,90 → $4.816. */
    const precioPorMargen = (costo: string, margen: string | null): string | undefined => {
      if (margen == null || margen.trim() === '') return undefined;
      const m = Number(margen);
      if (!Number.isFinite(m)) return undefined;
      return `${Math.round(Number(costo) * (1 + m / 100))}.0000`;
    };

    const resolvedLines: Array<{
      articleId: string;
      quantity: string;
      costPrice: string;
      salePrice: string;
      vatRate: string;
      newListPrice1?: string;
      newListPrice2?: string;
      newListPrice3?: string;
    }> = [];
    for (const line of input.lines) {
      const article = await repos.articles.findById(line.articleId);
      if (!article) throw new NotFoundError('Artículo', line.articleId);
      // Modo "por utilidad": las listas salen del margen guardado en el
      // artículo. Una lista sin margen no se toca — mejor un precio viejo que
      // uno inventado.
      // LO QUE MANDA LA PANTALLA ES LA VERDAD: los precios por lista vienen
      // editables desde Compras (el usuario puede pisar el redondeo a mano) y
      // tienen prioridad. El cálculo por margen es el FALLBACK, para
      // terminales viejas que no mandan listas en modo 'margin'.
      // Un precio nuevo tiene que ser > 0: '0' llega de campos vaciados en
      // clientes viejos y dejaría la góndola en cero. Se descarta acá también
      // — defensa en el servidor, no sólo en la pantalla.
      const positivo = (v: string | undefined): string | undefined =>
        v != null && Number(v) > 0 ? v : undefined;
      const deLinea = {
        newListPrice1: positivo(line.newListPrice1),
        newListPrice2: positivo(line.newListPrice2),
        newListPrice3: positivo(line.newListPrice3),
      };
      const porMargen =
        modoPrecios === 'margin'
          ? {
              newListPrice1: deLinea.newListPrice1 ?? precioPorMargen(line.costPrice, article.margin1),
              newListPrice2: deLinea.newListPrice2 ?? precioPorMargen(line.costPrice, article.margin2),
              newListPrice3: deLinea.newListPrice3 ?? precioPorMargen(line.costPrice, article.margin3),
            }
          : deLinea;
      const manual = line.salePrice && line.salePrice.trim() !== '' ? line.salePrice : undefined;
      resolvedLines.push({
        articleId: line.articleId,
        quantity: line.quantity,
        costPrice: line.costPrice,
        // El precio de venta del RENGLÓN (queda en el historial de la compra):
        // el que va a regir en lista 1 después de guardar.
        salePrice: porMargen.newListPrice1 ?? manual ?? article.listPrice1,
        vatRate: line.vatRate ?? article.vatRate,
        ...(modoPrecios === 'manual' && manual && !porMargen.newListPrice1
          ? { newListPrice1: manual }
          : {}),
        ...porMargen,
      });
    }

    // Totales (preview) según el modo de precios — replica el cálculo del repositorio.
    const company = await repos.company.getOrCreate();
    const mode: PriceMode = company.priceMode === 'net' ? 'net' : 'gross';
    const preview = calculateSaleTotals(
      resolvedLines.map((l) => ({ quantity: l.quantity, unitPrice: l.costPrice, vatRate: l.vatRate })),
      input.discount ?? '0.0000',
      mode,
    );

    if (!isAccountPurchase) {
      const paidSum = sumDecimals(payments.map((p) => p.amount));
      const cmp = cmpDecimal(paidSum, preview.total);
      if (cmp > 0) throw new ValidationError('payments', 'Los pagos exceden el total de la compra');
      if (cmp < 0) throw new ValidationError('payments', 'Los pagos no cubren el total de la compra');
    }

    const fundingSource: 'daily' | 'general' =
      !isAccountPurchase && input.fundingSource === 'general' ? 'general' : 'daily';

    // Caja diaria: sólo se necesita si el pago sale de la caja diaria. Con
    // fundingSource='general' el egreso va a Caja General y no hace falta caja abierta.
    const cashRegisterId =
      !isAccountPurchase && fundingSource === 'daily'
        ? (input.cashRegisterId ??
          (this.ctx.currentCashRegister?.status === 'open'
            ? this.ctx.currentCashRegister.id
            : (await repos.cashRegisters.getCurrentOpen())?.id) ??
          null)
        : null;

    // La parte en EFECTIVO de una compra contado no puede superar el cajón.
    if (!isAccountPurchase && fundingSource === 'daily' && cashRegisterId && (input.payments ?? []).length > 0) {
      const pmById = await repos.paymentMethods.byId();
      const fisico = sumDecimals(
        (input.payments ?? [])
          .filter((p) => pmById.get(p.paymentMethodId)?.isPhysicalCash === true)
          .map((p) => p.amount),
      );
      await assertPhysicalCashAvailable(repos, cashRegisterId, fisico);
    }

    // Validación de fondos: si sale de Caja General, tiene que haber saldo.
    if (fundingSource === 'general') {
      const cgBalance = await repos.cashGeneral.getBalance();
      if (cmpDecimal(cgBalance, preview.total) < 0) {
        throw new BusinessRuleError(
          'insufficient_cash_general',
          `Caja General no tiene saldo suficiente (disponible ${cgBalance}, compra ${preview.total})`,
        );
      }
    }

    // La transacción atómica (cabecera + líneas + stock + egresos de caja + AP
    // de cuenta corriente, BUG-S03) la hace el repo. Todo o nada.
    const { purchase, lines, accountPayable } = await repos.purchases.createWithLines({
      type: input.type,
      supplierId: input.supplierId,
      paymentType,
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      updatedPricesOnSave: input.updatePrices ?? false,
      discount: input.discount ?? '0.0000',
      notes: input.notes ?? null,
      date: input.date,
      cashRegisterId,
      fundingSource,
      userId: currentUser.id,
      payments: payments.map((p) => ({
        paymentMethodId: p.paymentMethodId,
        amount: p.amount,
        reference: p.reference ?? null,
      })),
      lines: resolvedLines.map((l) => ({
        articleId: l.articleId,
        quantity: l.quantity,
        costPrice: l.costPrice,
        salePrice: l.salePrice,
        vatRate: l.vatRate,
        newListPrice1: l.newListPrice1,
        newListPrice2: l.newListPrice2,
        newListPrice3: l.newListPrice3,
      })),
    });

    return { purchase, lines, accountPayable };
  }

  /**
   * Anula una compra: revierte stock y caja (vía repo) y, si la compra había
   * abierto una cuenta con el proveedor sin pagos, la elimina. Falla si la cuenta
   * ya recibió pagos. (No revierte los cambios de precios de `updatePrices`.)
   */
  async voidPurchase(purchaseId: string): Promise<Purchase> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_purchases');

    const purchase = await repos.purchases.findById(purchaseId);
    if (!purchase) throw new NotFoundError('Compra', purchaseId);
    if (purchase.status === 'voided') {
      throw new BusinessRuleError('purchase_already_voided', `La compra ${purchaseId} ya está anulada`);
    }

    const account = await repos.supplierAccountsPayable.findOne({ purchaseId });
    if (account) {
      const pays = await repos.supplierPayments.findByAccount(account.id);
      if (pays.length > 0) {
        throw new BusinessRuleError(
          'cannot_void_account_purchase_with_payments',
          'No se puede anular una compra a cuenta del proveedor que ya recibió pagos',
        );
      }
    }

    const voided = await repos.purchases.voidPurchase(purchaseId);
    if (account) await repos.supplierAccountsPayable.delete(account.id);
    return voided;
  }

  async getPurchase(purchaseId: string): Promise<{ purchase: Purchase; lines: PurchaseLine[] }> {
    const purchase = await this.ctx.repos.purchases.findById(purchaseId);
    if (!purchase) throw new NotFoundError('Compra', purchaseId);
    const lines = await this.ctx.repos.purchaseLines.findByPurchase(purchaseId);
    return { purchase, lines };
  }
}
