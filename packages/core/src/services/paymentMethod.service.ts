/**
 * Servicio de medios de pago: ABM + reglas (no borrar los predeterminados ni los
 * que tengan ventas/cobranzas asociadas).
 */
import type { NewPaymentMethod, PaymentMethod } from '@stockflow/shared';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, ConstraintError, NotFoundError } from '../errors';

/** IDs de los medios pre-cargados por el seed (no se pueden borrar). */
const DEFAULT_PAYMENT_METHOD_IDS = new Set([
  'pm-efectivo',
  'pm-transferencia',
  'pm-tarjeta-credito',
  'pm-tarjeta-debito',
]);

export class PaymentMethodService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Todos los medios, ordenados por sortOrder. Lectura: no requiere permiso. */
  async list(): Promise<PaymentMethod[]> {
    return this.ctx.repos.paymentMethods.findOrdered();
  }

  async get(id: string): Promise<PaymentMethod | null> {
    return this.ctx.repos.paymentMethods.findById(id);
  }

  async create(data: NewPaymentMethod): Promise<PaymentMethod> {
    requirePermission(this.ctx.currentUser, 'manage_payment_methods');
    return this.ctx.repos.paymentMethods.create(data);
  }

  async update(id: string, data: Partial<NewPaymentMethod>): Promise<PaymentMethod> {
    requirePermission(this.ctx.currentUser, 'manage_payment_methods');
    return this.ctx.repos.paymentMethods.update(id, data);
  }

  async delete(id: string): Promise<void> {
    requirePermission(this.ctx.currentUser, 'manage_payment_methods');
    const pm = await this.ctx.repos.paymentMethods.findById(id);
    if (!pm) throw new NotFoundError('Medio de pago', id);
    if (DEFAULT_PAYMENT_METHOD_IDS.has(id)) {
      throw new BusinessRuleError(
        'cannot_delete_default_payment_method',
        'No se puede borrar un medio de pago predeterminado. Desactivalo en su lugar.',
      );
    }
    const [inSales, inPayments] = await Promise.all([
      this.ctx.repos.salePayments.existsForPaymentMethod(id),
      this.ctx.repos.payments.existsForPaymentMethod(id),
    ]);
    if (inSales || inPayments) {
      throw new ConstraintError(
        'PAYMENT_METHOD_IN_USE',
        'No se puede borrar: el medio de pago tiene ventas o cobranzas registradas. Desactivalo en su lugar.',
      );
    }
    await this.ctx.repos.paymentMethods.delete(id);
  }
}
