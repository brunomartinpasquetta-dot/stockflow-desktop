import { and, asc, eq } from 'drizzle-orm';
import {
  CreatePaymentMethodSchema,
  UpdatePaymentMethodSchema,
  type PaymentMethodType,
} from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  paymentMethods,
  type NewPaymentMethod,
  type PaymentMethod,
} from '../schema/local';
import { BaseRepository } from './base.repository';

export class PaymentMethodRepository extends BaseRepository<
  PaymentMethod,
  NewPaymentMethod
> {
  protected override readonly createSchema = CreatePaymentMethodSchema;
  protected override readonly updateSchema = UpdatePaymentMethodSchema;

  constructor(db: LocalDatabase) {
    super(db, paymentMethods, 'Medio de pago');
  }

  /** Todos los medios, ordenados por sortOrder y nombre. */
  async findOrdered(): Promise<PaymentMethod[]> {
    try {
      return this.db
        .select()
        .from(paymentMethods)
        .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Medios activos, ordenados por sortOrder. */
  async findActive(): Promise<PaymentMethod[]> {
    try {
      return this.db
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.active, true))
        .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findByType(type: PaymentMethodType): Promise<PaymentMethod[]> {
    try {
      return this.db
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.type, type))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** El medio de efectivo físico (asume que hay exactamente uno). */
  async getEfectivo(): Promise<PaymentMethod | null> {
    try {
      const row = this.db
        .select()
        .from(paymentMethods)
        .where(and(eq(paymentMethods.type, 'cash'), eq(paymentMethods.isPhysicalCash, true)))
        .orderBy(asc(paymentMethods.sortOrder))
        .get();
      return row ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Mapa id → medio (para enriquecer reportes sin N+1). */
  async byId(): Promise<Map<string, PaymentMethod>> {
    try {
      const rows = this.db.select().from(paymentMethods).all();
      return new Map(rows.map((r) => [r.id, r]));
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
