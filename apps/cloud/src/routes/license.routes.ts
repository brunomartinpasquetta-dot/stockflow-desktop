/**
 * Rutas de licencias usadas por el desktop:
 *  - POST /api/licenses/activate   → activa y devuelve JWT (7 días).
 *  - POST /api/licenses/heartbeat  → ping periódico; renueva el JWT si está por vencer.
 *  - GET  /api/me                  → datos del tenant + features del plan.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { licenses, tenants } from '@stockflow/db';

import { PLAN_FEATURES, type PlanId } from '../config';
import { LicenseService } from '../services/LicenseService';

interface ActivateBody {
  licenseKey?: string;
  machineId?: string;
}

function statusOf(err: unknown): number {
  if (err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  return 400;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Error desconocido';
}

export async function licenseRoutes(app: FastifyInstance): Promise<void> {
  const licenseService = new LicenseService();

  app.post(
    '/api/licenses/activate',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req: FastifyRequest<{ Body: ActivateBody }>, reply: FastifyReply) => {
      const licenseKey = typeof req.body?.licenseKey === 'string' ? req.body.licenseKey.trim() : '';
      const machineId = typeof req.body?.machineId === 'string' ? req.body.machineId.trim() : '';
      if (!licenseKey || !machineId) {
        return reply.code(400).send({ error: 'licenseKey y machineId son obligatorios.' });
      }
      try {
        const result = await licenseService.activateLicense(
          app.cloudDb,
          licenseKey,
          machineId,
          (payload) => app.jwt.sign(payload),
        );
        return reply.send({ jwt: result.jwt, expiresAt: result.expiresAt, plan: result.plan });
      } catch (err) {
        return reply.code(statusOf(err)).send({ error: messageOf(err) });
      }
    },
  );

  app.post(
    '/api/licenses/heartbeat',
    { preHandler: app.authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = req.user;
      try {
        const result = await licenseService.heartbeat(
          app.cloudDb,
          user.sub,
          user.exp * 1000,
          user.plan,
          user.lk,
          user.tid,
          (p) => app.jwt.sign(p),
        );
        return reply.send({ jwt: result.jwt });
      } catch (err) {
        const code = statusOf(err);
        return reply.code(code === 400 ? 401 : code).send({ error: messageOf(err) });
      }
    },
  );

  app.get('/api/me', { preHandler: app.authenticate }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user;
    const [tenant] = await app.cloudDb.select().from(tenants).where(eq(tenants.id, user.tid)).limit(1);
    if (!tenant) return reply.code(404).send({ error: 'Cuenta no encontrada' });
    const [license] = await app.cloudDb.select().from(licenses).where(eq(licenses.id, user.sub)).limit(1);
    return reply.send({
      tenant: { name: tenant.companyName, plan: tenant.plan },
      license: { key: license?.licenseKey ?? user.lk, expiresAt: user.exp * 1000 },
      features: PLAN_FEATURES[tenant.plan as PlanId] ?? PLAN_FEATURES.basic,
    });
  });
}
