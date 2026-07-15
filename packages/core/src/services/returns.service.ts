/**
 * Servicio de DEVOLUCIONES.
 *
 * Ventas: permiso `void_sale` (quien puede anular puede devolver). El
 * reintegro en efectivo exige caja abierta (sale como egreso); el crédito en
 * cuenta baja el saldo de la AR de esa venta. Stock: vuelve (promos → componentes).
 *
 * Compras: permiso `manage_purchases`. El stock baja (vuelve al proveedor) y
 * el reintegro entra en efectivo o baja la deuda (AP).
 */
import type {
  CreatePurchaseReturnInput,
  CreateSaleReturnInput,
  PurchaseReturnResult,
  SaleReturnResult,
} from '@stockflow/db';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError } from '../errors';

export interface SaleReturnDraft {
  saleId: string;
  refundMethod: 'cash' | 'account';
  notes?: string | null;
  lines: Array<{ saleLineId: string; quantity: string }>;
}

export interface PurchaseReturnDraft {
  purchaseId: string;
  refundMethod: 'cash' | 'account';
  notes?: string | null;
  lines: Array<{ purchaseLineId: string; quantity: string }>;
}

export class ReturnsService {
  constructor(private readonly ctx: ServiceContext) {}

  async createSaleReturn(input: SaleReturnDraft): Promise<SaleReturnResult> {
    const { repos, currentUser, currentCashRegister } = this.ctx;
    requirePermission(currentUser, 'void_sale');
    if (!currentUser) throw new BusinessRuleError('no_session', 'Sesión requerida');
    if (input.refundMethod === 'cash' && !currentCashRegister) {
      throw new BusinessRuleError(
        'no_open_cash',
        'Para reintegrar en efectivo tiene que haber una caja abierta',
      );
    }
    const payload: CreateSaleReturnInput = {
      saleId: input.saleId,
      userId: currentUser.id,
      cashRegisterId: currentCashRegister?.id ?? null,
      refundMethod: input.refundMethod,
      notes: input.notes ?? null,
      lines: input.lines,
    };
    return repos.returns.createSaleReturn(payload);
  }

  async listBySale(saleId: string): Promise<SaleReturnResult[]> {
    return this.ctx.repos.returns.findBySale(saleId);
  }

  async createPurchaseReturn(input: PurchaseReturnDraft): Promise<PurchaseReturnResult> {
    const { repos, currentUser, currentCashRegister } = this.ctx;
    requirePermission(currentUser, 'manage_purchases');
    if (!currentUser) throw new BusinessRuleError('no_session', 'Sesión requerida');
    if (input.refundMethod === 'cash' && !currentCashRegister) {
      throw new BusinessRuleError(
        'no_open_cash',
        'Para recibir el reintegro en efectivo tiene que haber una caja abierta',
      );
    }
    const payload: CreatePurchaseReturnInput = {
      purchaseId: input.purchaseId,
      userId: currentUser.id,
      cashRegisterId: currentCashRegister?.id ?? null,
      refundMethod: input.refundMethod,
      notes: input.notes ?? null,
      lines: input.lines,
    };
    return repos.returns.createPurchaseReturn(payload);
  }

  async listByPurchase(purchaseId: string): Promise<PurchaseReturnResult[]> {
    return this.ctx.repos.returns.findByPurchase(purchaseId);
  }
}
