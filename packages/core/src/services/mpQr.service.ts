/**
 * Servicio MercadoPago QR Atendido.
 *
 * Maneja:
 *  - Setup de la empresa (alta de Store + persistencia de access token cifrado).
 *  - Alta de POS por caja (createPos + getQr).
 *  - Creación / cancelación / verificación de órdenes (PUT/DELETE).
 *  - Procesamiento idempotente de webhooks.
 *  - Expiración batch de órdenes vencidas.
 *
 * Almacena el access token cifrado (safeStorage en Electron; passthrough en tests
 * mediante el helper `MpTokenStoreLike`).
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, lte, lt } from 'drizzle-orm';
import {
  mpConfig,
  mpOrders,
  mpPosDevices,
  paymentMethods,
  type MpConfig,
  type MpOrder,
  type MpPosDevice,
} from '@stockflow/db';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError } from '../errors';
import { MpApiClient } from '../lib/mpApi';

export interface MpTokenStoreLike {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

export interface MpConfigStatus {
  configured: boolean;
  mpUserId?: string;
  storeId?: string | null;
  webhookSecret?: string;
}

export interface MpSetupInput {
  mpUserId: string;
  accessToken: string;
}

export interface MpCreateOrderInput {
  cashRegisterId: string;
  amount: string;
  description: string;
  externalReference?: string;
}

export interface MpWebhookContext {
  mpPaymentId?: string;
}

const ORDER_TTL_MS = 5 * 60_000;

export class MpQrService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly tokenStore: MpTokenStoreLike,
    /** Override del baseUrl de MP (sólo tests). */
    private readonly mpBaseUrl?: string,
  ) {}

  /* --------------------------- helpers ---------------------------- */

  private async getConfigRow(): Promise<MpConfig | null> {
    const row = this.ctx.db.select().from(mpConfig).limit(1).get();
    return row ?? null;
  }

  private async client(): Promise<MpApiClient> {
    const cfg = await this.getConfigRow();
    if (!cfg) throw new BusinessRuleError('mp_not_configured', 'MercadoPago no está configurado.');
    const token = this.tokenStore.decrypt(cfg.accessTokenEncrypted);
    return new MpApiClient(token, this.mpBaseUrl);
  }

  /* ---------------------------- API ------------------------------- */

  async getConfig(): Promise<MpConfigStatus> {
    const row = await this.getConfigRow();
    if (!row) return { configured: false };
    return {
      configured: true,
      mpUserId: row.mpUserId,
      storeId: row.storeId,
      webhookSecret: row.webhookSecret,
    };
  }

  async setupCompany(input: MpSetupInput): Promise<{ configured: true; storeId: string }> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    if (this.ctx.currentUser.role !== 'admin') {
      throw new BusinessRuleError('mp_setup_admin_only', 'Sólo un administrador puede configurar MercadoPago.');
    }
    if (!input.mpUserId || !input.accessToken) {
      throw new BusinessRuleError('mp_invalid_input', 'mpUserId y accessToken son obligatorios.');
    }

    const client = new MpApiClient(input.accessToken, this.mpBaseUrl);
    try {
      await client.validateToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BusinessRuleError('mp_invalid_token', `Access token inválido: ${msg}`);
    }

    let storeId: string;
    try {
      const store = await client.createStore(input.mpUserId, { name: 'StockFlow' });
      storeId = String(store.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BusinessRuleError('mp_store_create_failed', `No se pudo crear la sucursal en MercadoPago: ${msg}`);
    }

    const webhookSecret = randomBytes(32).toString('hex');
    const encrypted = this.tokenStore.encrypt(input.accessToken);
    const now = Date.now();

    const existing = await this.getConfigRow();
    if (existing) {
      this.ctx.db
        .update(mpConfig)
        .set({
          mpUserId: input.mpUserId,
          accessTokenEncrypted: encrypted,
          webhookSecret,
          storeId,
          updatedAt: now,
        })
        .where(eq(mpConfig.id, existing.id))
        .run();
    } else {
      this.ctx.db
        .insert(mpConfig)
        .values({
          id: randomUUID(),
          companyId: null,
          mpUserId: input.mpUserId,
          accessTokenEncrypted: encrypted,
          webhookSecret,
          storeId,
          webhookUrlConfigured: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // Crear el payment method "MercadoPago QR" si no existe.
    const pmExisting = this.ctx.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.name, 'MercadoPago QR'))
      .get();
    if (!pmExisting) {
      try {
        this.ctx.db
          .insert(paymentMethods)
          .values({
            id: randomUUID(),
            name: 'MercadoPago QR',
            type: 'mp',
            isPhysicalCash: false,
            commissionPct: '0.00',
            active: true,
            sortOrder: 90,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } catch (err) {
        console.warn('[mpQr] no se pudo crear el payment method MercadoPago QR:', err);
      }
    }

    return { configured: true, storeId };
  }

  async listPosDevices(): Promise<MpPosDevice[]> {
    return this.ctx.db.select().from(mpPosDevices).orderBy(asc(mpPosDevices.createdAt)).all();
  }

  async getQrForCashRegister(
    cashRegisterId: string,
  ): Promise<{ qrUrl: string; qrImageBase64: string | null } | null> {
    const dev = this.ctx.db
      .select()
      .from(mpPosDevices)
      .where(eq(mpPosDevices.cashRegisterId, cashRegisterId))
      .get();
    if (!dev) return null;
    return { qrUrl: dev.qrUrl, qrImageBase64: dev.qrImageBase64 ?? null };
  }

  async getPosDeviceByCashRegister(cashRegisterId: string): Promise<MpPosDevice | null> {
    const dev = this.ctx.db
      .select()
      .from(mpPosDevices)
      .where(eq(mpPosDevices.cashRegisterId, cashRegisterId))
      .get();
    return dev ?? null;
  }

  async createPosDevice(input: { cashRegisterId: string }): Promise<MpPosDevice> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    const cfg = await this.getConfigRow();
    if (!cfg || !cfg.storeId) {
      throw new BusinessRuleError('mp_not_configured', 'Configurá MercadoPago antes de asignar QR a cajas.');
    }
    const existing = await this.getPosDeviceByCashRegister(input.cashRegisterId);
    if (existing) return existing;

    const externalPosId = `CAJA-${input.cashRegisterId.slice(0, 8)}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;

    const client = await this.client();
    let pos;
    try {
      pos = await client.createPos({
        name: `StockFlow ${externalPosId}`,
        external_id: externalPosId,
        store_id: cfg.storeId,
        category: 5411,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BusinessRuleError('mp_pos_create_failed', `No se pudo crear el POS en MercadoPago: ${msg}`);
    }

    let qrUrl = '';
    try {
      const qr = await client.getQr(cfg.mpUserId, externalPosId);
      qrUrl = String(qr.qr_template_url ?? qr.qr_template_image ?? '');
    } catch (err) {
      console.warn('[mpQr] getQr falló:', err);
    }

    let qrImageBase64: string | null = null;
    if (qrUrl) {
      try {
        const res = await (globalThis.fetch as typeof fetch)(qrUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          qrImageBase64 = buf.toString('base64');
        }
      } catch (err) {
        console.warn('[mpQr] no se pudo descargar la imagen del QR:', err);
      }
    }

    const now = Date.now();
    const id = randomUUID();
    this.ctx.db
      .insert(mpPosDevices)
      .values({
        id,
        cashRegisterId: input.cashRegisterId,
        externalPosId,
        mpPosId: String(pos.id),
        qrUrl,
        qrImageBase64,
        active: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.ctx.db.select().from(mpPosDevices).where(eq(mpPosDevices.id, id)).get()!;
  }

  async createOrder(input: MpCreateOrderInput): Promise<MpOrder> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    const cfg = await this.getConfigRow();
    if (!cfg) throw new BusinessRuleError('mp_not_configured', 'MercadoPago no está configurado.');

    const device = await this.getPosDeviceByCashRegister(input.cashRegisterId);
    if (!device) {
      throw new BusinessRuleError('mp_pos_missing', 'La caja no tiene un QR de MercadoPago asignado.');
    }

    const amountNum = Number(input.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new BusinessRuleError('mp_invalid_amount', 'El monto debe ser mayor a cero.');
    }
    const externalReference = input.externalReference ?? `ORD-${randomUUID()}`;

    const client = await this.client();
    try {
      await client.putOrder(cfg.mpUserId, device.externalPosId, {
        external_reference: externalReference,
        title: 'Venta StockFlow',
        description: input.description,
        total_amount: Number(amountNum.toFixed(2)),
        items: [
          {
            title: input.description,
            unit_price: Number(amountNum.toFixed(2)),
            quantity: 1,
            unit_measure: 'unit',
            total_amount: Number(amountNum.toFixed(2)),
          },
        ],
        cash_out: { amount: 0 },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BusinessRuleError('mp_order_failed', `No se pudo crear la orden en MercadoPago: ${msg}`);
    }

    const now = Date.now();
    const id = randomUUID();
    this.ctx.db
      .insert(mpOrders)
      .values({
        id,
        mpPosDeviceId: device.id,
        saleId: null,
        externalReference,
        amount: amountNum.toFixed(2),
        description: input.description,
        status: 'pending',
        mpPaymentId: null,
        mpMerchantOrderId: null,
        expiresAt: now + ORDER_TTL_MS,
        paidAt: null,
        createdAt: now,
        createdBy: this.ctx.currentUser.id,
      })
      .run();
    return this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, id)).get()!;
  }

  async cancelOrder(orderId: string): Promise<MpOrder> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    const order = this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get();
    if (!order) throw new NotFoundError('Orden MP', orderId);
    if (order.status !== 'pending') return order;

    const cfg = await this.getConfigRow();
    const device = this.ctx.db
      .select()
      .from(mpPosDevices)
      .where(eq(mpPosDevices.id, order.mpPosDeviceId))
      .get();
    if (cfg && device) {
      try {
        const client = await this.client();
        await client.deleteOrder(cfg.mpUserId, device.externalPosId);
      } catch (err) {
        console.warn('[mpQr] DELETE order en MP falló (igual marcamos cancelled local):', err);
      }
    }

    this.ctx.db
      .update(mpOrders)
      .set({ status: 'cancelled' })
      .where(eq(mpOrders.id, orderId))
      .run();
    return this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get()!;
  }

  async verifyPayment(orderId: string): Promise<MpOrder> {
    const order = this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get();
    if (!order) throw new NotFoundError('Orden MP', orderId);
    if (order.status !== 'pending') return order;

    let result;
    try {
      const client = await this.client();
      result = await client.searchPayments(order.externalReference);
    } catch (err) {
      console.warn('[mpQr] verifyPayment search falló:', err);
      return order;
    }

    const payment = result.results?.[0];
    if (!payment) return order;

    const now = Date.now();
    if (payment.status === 'approved') {
      this.ctx.db
        .update(mpOrders)
        .set({
          status: 'approved',
          mpPaymentId: String(payment.id),
          paidAt: now,
        })
        .where(eq(mpOrders.id, orderId))
        .run();
    } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
      this.ctx.db
        .update(mpOrders)
        .set({ status: payment.status, mpPaymentId: String(payment.id) })
        .where(eq(mpOrders.id, orderId))
        .run();
    }
    return this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get()!;
  }

  async handleWebhook(
    payload: { type?: string; data?: { id?: string | number } } | Record<string, unknown>,
    _tenantContext: MpWebhookContext = {},
  ): Promise<{ processed: boolean; orderId?: string }> {
    const data = (payload as { data?: { id?: string | number } }).data;
    const mpPaymentId = data?.id != null ? String(data.id) : undefined;
    if (!mpPaymentId) return { processed: false };

    // Idempotencia: si ya tenemos una orden con este mpPaymentId, no repetir.
    const already = this.ctx.db
      .select()
      .from(mpOrders)
      .where(eq(mpOrders.mpPaymentId, mpPaymentId))
      .get();
    if (already) return { processed: false, orderId: already.id };

    let payment;
    try {
      const client = await this.client();
      payment = await client.getPayment(mpPaymentId);
    } catch (err) {
      console.warn('[mpQr] webhook getPayment falló:', err);
      return { processed: false };
    }

    if (!payment.external_reference) return { processed: false };
    const order = this.ctx.db
      .select()
      .from(mpOrders)
      .where(eq(mpOrders.externalReference, payment.external_reference))
      .get();
    if (!order) return { processed: false };

    const now = Date.now();
    if (payment.status === 'approved') {
      this.ctx.db
        .update(mpOrders)
        .set({ status: 'approved', mpPaymentId, paidAt: now })
        .where(eq(mpOrders.id, order.id))
        .run();
    } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
      this.ctx.db
        .update(mpOrders)
        .set({ status: payment.status, mpPaymentId })
        .where(eq(mpOrders.id, order.id))
        .run();
    }

    return { processed: true, orderId: order.id };
  }

  async expireStaleOrders(): Promise<{ expired: number }> {
    const now = Date.now();
    const stale = this.ctx.db
      .select()
      .from(mpOrders)
      .where(and(eq(mpOrders.status, 'pending'), lt(mpOrders.expiresAt, now)))
      .all();
    if (stale.length === 0) return { expired: 0 };

    const cfg = await this.getConfigRow();
    for (const order of stale) {
      if (cfg) {
        const device = this.ctx.db
          .select()
          .from(mpPosDevices)
          .where(eq(mpPosDevices.id, order.mpPosDeviceId))
          .get();
        if (device) {
          try {
            const client = await this.client();
            await client.deleteOrder(cfg.mpUserId, device.externalPosId);
          } catch (err) {
            console.warn('[mpQr] expire deleteOrder falló para', order.id, err);
          }
        }
      }
      this.ctx.db.update(mpOrders).set({ status: 'expired' }).where(eq(mpOrders.id, order.id)).run();
    }
    return { expired: stale.length };
  }

  async linkOrderToSale(orderId: string, saleId: string): Promise<void> {
    this.ctx.db.update(mpOrders).set({ saleId }).where(eq(mpOrders.id, orderId)).run();
  }

  async getActiveOrder(cashRegisterId: string): Promise<MpOrder | null> {
    const device = await this.getPosDeviceByCashRegister(cashRegisterId);
    if (!device) return null;
    const row = this.ctx.db
      .select()
      .from(mpOrders)
      .where(and(eq(mpOrders.mpPosDeviceId, device.id), eq(mpOrders.status, 'pending')))
      .orderBy(desc(mpOrders.createdAt))
      .limit(1)
      .get();
    return row ?? null;
  }

  async getOrder(orderId: string): Promise<MpOrder | null> {
    const row = this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get();
    return row ?? null;
  }

  async listOrders(input: { from: number; to: number }): Promise<MpOrder[]> {
    return this.ctx.db
      .select()
      .from(mpOrders)
      .where(and(gte(mpOrders.createdAt, input.from), lte(mpOrders.createdAt, input.to)))
      .orderBy(desc(mpOrders.createdAt))
      .all();
  }

  async testConnection(): Promise<{ ok: boolean; mpUserId?: string; error?: string }> {
    try {
      const client = await this.client();
      const me = await client.validateToken();
      return { ok: true, mpUserId: String(me.id) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}
