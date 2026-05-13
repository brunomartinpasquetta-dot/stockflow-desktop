/**
 * Rutas de facturación / suscripciones.
 *
 * NOTA sobre el webhook: una implementación productiva debería, al recibir la
 * notificación, consultar el recurso en la API de MercadoPago para confirmar su
 * estado real (el webhook sólo trae el `id`). Acá operamos sobre el body + un
 * parámetro opcional `?event=` / `?tenantId=` para poder testear el flujo de
 * forma determinística. El TODO de "fetch del recurso" queda explícito.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { billingEvents, licenses, tenants } from '@stockflow/db';

import { PLAN_PRICES, type PlanId } from '../config';
import type { EmailService } from '../services/EmailService';
import type { MercadoPagoService } from '../services/MercadoPagoService';
import { LicenseService } from '../services/LicenseService';

interface SubscribeBody {
  email?: string;
  fullName?: string;
  phone?: string;
  companyName?: string;
  plan?: string;
}

interface WebhookBody {
  type?: string;
  action?: string;
  data?: { id?: string };
  // MP a veces manda el estado dentro del recurso embebido; lo soportamos.
  status?: string;
  amount?: number;
}

function isValidPlan(plan: unknown): plan is PlanId {
  return plan === 'basic' || plan === 'pro';
}

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export async function billingRoutes(
  app: FastifyInstance,
  opts: { mp: MercadoPagoService; email: EmailService },
): Promise<void> {
  const { mp, email } = opts;
  const licenseService = new LicenseService();

  /* ---------------------------------------------------------------- */
  /* POST /api/billing/subscribe                                       */
  /* ---------------------------------------------------------------- */
  app.post(
    '/api/billing/subscribe',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req: FastifyRequest<{ Body: SubscribeBody }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      const emailAddr = typeof body.email === 'string' ? body.email.trim() : '';
      const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
      const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
      const phone = typeof body.phone === 'string' ? body.phone.trim() : null;
      const plan = body.plan;

      if (!emailAddr || !fullName || !companyName || !isValidPlan(plan)) {
        return reply.code(400).send({ error: 'Datos incompletos o plan inválido (basic | pro).' });
      }

      const [existing] = await app.cloudDb
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.email, emailAddr))
        .limit(1);
      if (existing) {
        return reply.code(409).send({ error: 'Ya existe una cuenta con ese email.' });
      }

      const [tenant] = await app.cloudDb
        .insert(tenants)
        .values({ email: emailAddr, fullName, phone, companyName, plan, status: 'pending' })
        .returning();
      if (!tenant) {
        return reply.code(500).send({ error: 'No se pudo crear la cuenta.' });
      }

      try {
        const { initPoint, preapprovalId } = await mp.createPreapproval(
          { id: tenant.id, email: tenant.email },
          plan,
          PLAN_PRICES[plan],
        );
        await app.cloudDb
          .update(tenants)
          .set({ mpPreapprovalId: preapprovalId, updatedAt: new Date() })
          .where(eq(tenants.id, tenant.id));
        return reply.send({ tenantId: tenant.id, initPoint, mpConfigured: true });
      } catch (err) {
        // MP no configurado (o error): el alta queda registrada igual.
        req.log.warn({ err }, 'No se pudo crear el preapproval en MercadoPago');
        return reply.send({ tenantId: tenant.id, initPoint: null, mpConfigured: false });
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /api/billing/webhook/mp                                      */
  /* ---------------------------------------------------------------- */
  app.post(
    '/api/billing/webhook/mp',
    async (
      req: FastifyRequest<{ Body: WebhookBody; Querystring: { event?: string; tenantId?: string } }>,
      reply: FastifyReply,
    ) => {
      const body = req.body ?? {};
      const xSignature = req.headers['x-signature'] as string | undefined;
      const xRequestId = req.headers['x-request-id'] as string | undefined;
      const dataId = body.data?.id ?? '';

      const signatureOk = mp.validateWebhookSignature({ xSignature, xRequestId, dataId });
      if (!signatureOk) {
        return reply.code(401).send({ error: 'Firma de webhook inválida' });
      }

      // Idempotencia: si ya procesamos este id, salimos.
      if (dataId) {
        const [seen] = await app.cloudDb
          .select({ id: billingEvents.id })
          .from(billingEvents)
          .where(eq(billingEvents.mpPaymentId, dataId))
          .limit(1);
        if (seen) {
          return reply.send({ ok: true, duplicate: true });
        }
      }

      // Determinación del evento: `?event=` para tests; si no, `action` o `type` + status.
      const queryEvent = req.query.event;
      const action = body.action;
      const resourceStatus = body.status;
      let event: 'preapproval.authorized' | 'payment.approved' | 'payment.rejected' | 'preapproval.cancelled' | 'unknown';
      if (queryEvent === 'preapproval.authorized' || queryEvent === 'payment.approved' || queryEvent === 'payment.rejected' || queryEvent === 'preapproval.cancelled') {
        event = queryEvent;
      } else if (body.type === 'preapproval' || action?.startsWith('preapproval')) {
        event = resourceStatus === 'cancelled' ? 'preapproval.cancelled' : 'preapproval.authorized';
      } else if (body.type === 'payment' || action?.startsWith('payment')) {
        event = resourceStatus === 'rejected' ? 'payment.rejected' : 'payment.approved';
      } else {
        event = 'unknown';
      }

      // TODO(prod): consultar el recurso (payment/preapproval) en la API de MP
      // con `dataId` para confirmar el estado real antes de mutar el tenant.

      // Resolución del tenant: por `mpPreapprovalId === dataId`, o por `?tenantId=` (tests).
      const resolveTenant = async () => {
        if (req.query.tenantId) {
          const [t] = await app.cloudDb.select().from(tenants).where(eq(tenants.id, req.query.tenantId)).limit(1);
          if (t) return t;
        }
        if (dataId) {
          const [t] = await app.cloudDb
            .select()
            .from(tenants)
            .where(eq(tenants.mpPreapprovalId, dataId))
            .limit(1);
          if (t) return t;
        }
        return null;
      };

      const tenant = await resolveTenant();

      const insertEvent = async (type: string, status: string | null, amount: string | null) => {
        if (!tenant) return;
        try {
          await app.cloudDb.insert(billingEvents).values({
            tenantId: tenant.id,
            mpPaymentId: dataId || `synthetic-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type,
            amount,
            status,
            rawPayload: body as unknown as object,
          });
        } catch (err) {
          req.log.warn({ err }, 'No se pudo insertar billingEvent (¿duplicado?)');
        }
      };

      if (!tenant) {
        // No pudimos asociar; igual respondemos 200 para que MP no reintente.
        req.log.warn({ dataId, event }, 'Webhook MP sin tenant asociado');
        return reply.send({ ok: true, tenant: false });
      }

      switch (event) {
        case 'preapproval.authorized': {
          await app.cloudDb
            .update(tenants)
            .set({ status: 'active', failedPayments: '0', updatedAt: new Date() })
            .where(eq(tenants.id, tenant.id));
          const [activeLic] = await app.cloudDb
            .select()
            .from(licenses)
            .where(and(eq(licenses.tenantId, tenant.id), inArray(licenses.status, ['pending', 'active'])))
            .limit(1);
          let licenseKey = activeLic?.licenseKey;
          if (!activeLic) {
            licenseKey = LicenseService.generateLicenseKey();
            await app.cloudDb.insert(licenses).values({ tenantId: tenant.id, licenseKey, status: 'pending' });
          }
          if (licenseKey) {
            await email.sendLicenseEmail(tenant.email, tenant.fullName, licenseKey, tenant.plan);
          }
          await insertEvent('subscription_authorized', 'authorized', null);
          break;
        }
        case 'payment.approved': {
          await app.cloudDb
            .update(tenants)
            .set({
              status: 'active',
              failedPayments: '0',
              nextBillingDate: new Date(Date.now() + ONE_MONTH_MS),
              updatedAt: new Date(),
            })
            .where(eq(tenants.id, tenant.id));
          const amount = typeof body.amount === 'number' ? String(body.amount) : null;
          await insertEvent('payment_approved', 'approved', amount);
          break;
        }
        case 'payment.rejected': {
          const failed = Number(tenant.failedPayments ?? '0') + 1;
          const updates: { failedPayments: string; status?: 'suspended'; updatedAt: Date } = {
            failedPayments: String(failed),
            updatedAt: new Date(),
          };
          if (failed >= 2) updates.status = 'suspended';
          await app.cloudDb.update(tenants).set(updates).where(eq(tenants.id, tenant.id));
          if (failed >= 2) {
            await email.sendSuspendedEmail(tenant.email, tenant.fullName);
          }
          await insertEvent('payment_rejected', 'rejected', null);
          break;
        }
        case 'preapproval.cancelled': {
          await app.cloudDb
            .update(tenants)
            .set({ status: 'cancelled', updatedAt: new Date() })
            .where(eq(tenants.id, tenant.id));
          await app.cloudDb.update(licenses).set({ status: 'revoked' }).where(eq(licenses.tenantId, tenant.id));
          await email.sendCancelledEmail(tenant.email, tenant.fullName);
          await insertEvent('subscription_cancelled', 'cancelled', null);
          break;
        }
        default: {
          await insertEvent('unknown', resourceStatus ?? null, null);
          break;
        }
      }

      return reply.send({ ok: true });
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /api/billing/status/:tenantId                                */
  /* ---------------------------------------------------------------- */
  app.get(
    '/api/billing/status/:tenantId',
    async (req: FastifyRequest<{ Params: { tenantId: string } }>, reply: FastifyReply) => {
      const [tenant] = await app.cloudDb
        .select({ status: tenants.status })
        .from(tenants)
        .where(eq(tenants.id, req.params.tenantId))
        .limit(1);
      if (!tenant) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      return reply.send({ status: tenant.status });
    },
  );
}
