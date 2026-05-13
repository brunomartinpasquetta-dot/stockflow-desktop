/**
 * Integración con MercadoPago (suscripciones / preapprovals).
 *
 * Usa el SDK v2 (`mercadopago`). El SDK se importa de forma perezosa dentro de
 * los métodos para evitar fallos de import si el paquete no resuelve en algún
 * entorno (p. ej. tests).
 *
 * Si no hay `accessToken` configurado, `createPreapproval` lanza un error claro
 * en español — el flujo de alta sigue funcionando en dev (el tenant queda
 * `pending` y se contacta manualmente).
 */
import crypto from 'node:crypto';

import { BASE_URL, type PlanId } from '../config';

export interface PreapprovalResult {
  initPoint: string;
  preapprovalId: string;
}

export class MercadoPagoService {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly webhookSecret: string | undefined,
  ) {}

  /** ¿Está configurado MercadoPago? */
  get isConfigured(): boolean {
    return Boolean(this.accessToken);
  }

  private async getPreApproval(): Promise<import('mercadopago').PreApproval> {
    if (!this.accessToken) {
      throw new Error('MercadoPago no está configurado (falta MP_ACCESS_TOKEN)');
    }
    const { MercadoPagoConfig, PreApproval } = await import('mercadopago');
    const config = new MercadoPagoConfig({ accessToken: this.accessToken });
    return new PreApproval(config);
  }

  /** Crea una suscripción (preapproval) y devuelve el init_point para redirigir al cliente. */
  async createPreapproval(
    tenant: { id: string; email: string },
    plan: PlanId,
    planPrice: number,
  ): Promise<PreapprovalResult> {
    const preApproval = await this.getPreApproval();
    const result = await preApproval.create({
      body: {
        reason: `Suscripción StockFlow - Plan ${plan}`,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: planPrice,
          currency_id: 'ARS',
        },
        back_url: `${BASE_URL}/api/billing/status/${tenant.id}`,
        payer_email: tenant.email,
        status: 'pending',
      },
    });
    return { initPoint: result.init_point!, preapprovalId: result.id! };
  }

  /** Cancela una suscripción existente en MercadoPago. */
  async cancelPreapproval(preapprovalId: string): Promise<void> {
    const preApproval = await this.getPreApproval();
    await preApproval.update({ id: preapprovalId, body: { status: 'cancelled' } });
  }

  /**
   * Valida la firma del webhook de MercadoPago.
   *
   * Header `x-signature` con formato `ts=<ts>,v1=<hash>`. El manifest es
   * `id:<dataId>;request-id:<xRequestId>;ts:<ts>;` y el hash es HMAC-SHA256 con
   * el secreto. Si no hay secreto configurado, en dev devuelve `true` con un warning.
   */
  validateWebhookSignature(opts: {
    xSignature: string | undefined;
    xRequestId: string | undefined;
    dataId: string;
  }): boolean {
    if (!this.webhookSecret) {
      console.warn(
        '[MercadoPago] MP_WEBHOOK_SECRET no configurado: se acepta el webhook sin validar firma (sólo dev).',
      );
      return true;
    }
    const { xSignature, xRequestId, dataId } = opts;
    if (!xSignature) return false;

    let ts: string | undefined;
    let v1: string | undefined;
    for (const part of xSignature.split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key === 'ts') ts = value;
      else if (key === 'v1') v1 = value;
    }
    if (!ts || !v1) return false;

    const manifest = `id:${dataId};request-id:${xRequestId ?? ''};ts:${ts};`;
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(manifest).digest('hex');

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(v1, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
