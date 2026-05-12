/**
 * Servicio de compras: orquesta PurchaseRepository (carga atómica de la compra,
 * incremento de stock y, si corresponde, actualización de precios) y aplica
 * los permisos de negocio.
 */
import type { Purchase, PurchaseLine, VoucherType } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError } from '../errors';

export interface PurchaseLineDraft {
  articleId: string;
  quantity: string;
  costPrice: string;
  /** Precio de venta sugerido (se aplica a listPrice1 si updatePrices = true). */
  salePrice: string;
  vatRate?: string;
}

export interface CreatePurchaseInput {
  type: VoucherType;
  supplierId: string;
  paymentType: 'cash' | 'credit';
  supplierInvoiceNumber?: string | null;
  /** Si true, al guardar actualiza costPrice y listPrice1 de cada artículo. */
  updatePrices?: boolean;
  discount?: string;
  notes?: string | null;
  /** Caja donde impacta el egreso (sólo si paymentType = 'cash'). */
  cashRegisterId?: string | null;
  lines: PurchaseLineDraft[];
}

export interface CreatePurchaseResult {
  purchase: Purchase;
  lines: PurchaseLine[];
}

export class PurchasesService {
  constructor(private readonly ctx: ServiceContext) {}

  async createPurchase(input: CreatePurchaseInput): Promise<CreatePurchaseResult> {
    const { repos, currentUser } = this.ctx;
    requirePermission(currentUser, 'manage_purchases');

    if (input.lines.length === 0) {
      throw new BusinessRuleError('empty_purchase', 'La compra debe tener al menos una línea');
    }

    const supplier = await repos.suppliers.findById(input.supplierId);
    if (!supplier) throw new NotFoundError('Proveedor', input.supplierId);

    for (const line of input.lines) {
      const article = await repos.articles.findById(line.articleId);
      if (!article) throw new NotFoundError('Artículo', line.articleId);
    }

    const cashRegisterId =
      input.paymentType === 'cash'
        ? (input.cashRegisterId ??
          (this.ctx.currentCashRegister?.status === 'open'
            ? this.ctx.currentCashRegister.id
            : (await repos.cashRegisters.getCurrentOpen())?.id) ??
          null)
        : null;

    const { purchase, lines } = await repos.purchases.createWithLines({
      type: input.type,
      supplierId: input.supplierId,
      paymentType: input.paymentType,
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      updatedPricesOnSave: input.updatePrices ?? false,
      discount: input.discount ?? '0.0000',
      notes: input.notes ?? null,
      cashRegisterId,
      userId: currentUser.id,
      lines: input.lines.map((l) => ({
        articleId: l.articleId,
        quantity: l.quantity,
        costPrice: l.costPrice,
        salePrice: l.salePrice,
        vatRate: l.vatRate ?? '21.00',
      })),
    });

    return { purchase, lines };
  }

  async getPurchase(purchaseId: string): Promise<{ purchase: Purchase; lines: PurchaseLine[] }> {
    const purchase = await this.ctx.repos.purchases.findById(purchaseId);
    if (!purchase) throw new NotFoundError('Compra', purchaseId);
    const lines = await this.ctx.repos.purchaseLines.findByPurchase(purchaseId);
    return { purchase, lines };
  }
}
