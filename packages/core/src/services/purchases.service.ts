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
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError, ValidationError } from '../errors';
import { type PriceMode, calculateSaleTotals } from '../pricing';

export interface PurchaseLineDraft {
  articleId: string;
  quantity: string;
  costPrice: string;
  /** Nuevo precio de venta sugerido (se aplica a listPrice1 si updatePrices=true). Vacío → listPrice1 actual. */
  salePrice?: string;
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
  discount?: string;
  notes?: string | null;
  /** Caja donde impacta el egreso (sólo si es contado). */
  cashRegisterId?: string | null;
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

    const resolvedLines: Array<{
      articleId: string;
      quantity: string;
      costPrice: string;
      salePrice: string;
      vatRate: string;
    }> = [];
    for (const line of input.lines) {
      const article = await repos.articles.findById(line.articleId);
      if (!article) throw new NotFoundError('Artículo', line.articleId);
      resolvedLines.push({
        articleId: line.articleId,
        quantity: line.quantity,
        costPrice: line.costPrice,
        salePrice: line.salePrice && line.salePrice.trim() !== '' ? line.salePrice : article.listPrice1,
        vatRate: line.vatRate ?? article.vatRate,
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

    const cashRegisterId = !isAccountPurchase
      ? (input.cashRegisterId ??
        (this.ctx.currentCashRegister?.status === 'open'
          ? this.ctx.currentCashRegister.id
          : (await repos.cashRegisters.getCurrentOpen())?.id) ??
        null)
      : null;

    const { purchase, lines } = await repos.purchases.createWithLines({
      type: input.type,
      supplierId: input.supplierId,
      paymentType,
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      updatedPricesOnSave: input.updatePrices ?? false,
      discount: input.discount ?? '0.0000',
      notes: input.notes ?? null,
      date: input.date,
      cashRegisterId,
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
      })),
    });

    let accountPayable: SupplierAccountPayable | null = null;
    if (isAccountPurchase) {
      accountPayable = await repos.supplierAccountsPayable.create({
        supplierId: input.supplierId,
        purchaseId: purchase.id,
        total: purchase.total,
      });
    }

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
