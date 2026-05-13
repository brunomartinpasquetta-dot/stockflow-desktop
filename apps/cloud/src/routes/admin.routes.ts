/**
 * Rutas del panel de administración (protegidas con JWT `admin: true`).
 */
import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { licenses, tenants } from '@stockflow/db';

import { ADMIN_EMAIL, ADMIN_PASSWORD_HASH } from '../config';
import type { EmailService } from '../services/EmailService';
import { LicenseService } from '../services/LicenseService';

interface LoginBody {
  email?: string;
  password?: string;
}

export async function adminRoutes(app: FastifyInstance, opts?: { email?: EmailService }): Promise<void> {
  const email = opts?.email;

  /** preHandler: verifica JWT y que tenga `admin: true`. */
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'No autorizado' });
      return;
    }
    if (req.user.admin !== true) {
      await reply.code(403).send({ error: 'Acceso restringido al panel admin' });
    }
  };

  app.post('/api/admin/login', async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    const emailIn = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!ADMIN_PASSWORD_HASH) {
      return reply.code(503).send({ error: 'Panel admin no configurado' });
    }
    if (emailIn !== ADMIN_EMAIL) {
      return reply.code(401).send({ error: 'Credenciales inválidas' });
    }
    const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
    if (!ok) {
      return reply.code(401).send({ error: 'Credenciales inválidas' });
    }
    const token = app.jwt.sign({ admin: true, email: emailIn }, { expiresIn: '12h' });
    return reply.send({ token });
  });

  app.get('/api/admin/tenants', { preHandler: requireAdmin }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const rows = await app.cloudDb.select().from(tenants);
    const lic = await app.cloudDb
      .select({
        tenantId: licenses.tenantId,
        licenseKey: licenses.licenseKey,
        status: licenses.status,
        machineId: licenses.machineId,
      })
      .from(licenses);
    const byTenant = new Map<string, typeof lic>();
    for (const l of lic) {
      const arr = byTenant.get(l.tenantId) ?? [];
      arr.push(l);
      byTenant.set(l.tenantId, arr);
    }
    return reply.send(rows.map((t) => ({ ...t, licenses: byTenant.get(t.id) ?? [] })));
  });

  app.post<{ Params: { id: string } }>(
    '/api/admin/tenants/:id/suspend',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [t] = await app.cloudDb
        .update(tenants)
        .set({ status: 'suspended', updatedAt: new Date() })
        .where(eq(tenants.id, req.params.id))
        .returning();
      if (!t) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      if (email) await email.sendSuspendedEmail(t.email, t.fullName);
      return reply.send({ ok: true, status: t.status });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/tenants/:id/reactivate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [t] = await app.cloudDb
        .update(tenants)
        .set({ status: 'active', failedPayments: '0', updatedAt: new Date() })
        .where(eq(tenants.id, req.params.id))
        .returning();
      if (!t) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      return reply.send({ ok: true, status: t.status });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/tenants/:id/license/release',
    { preHandler: requireAdmin },
    async (req, reply) => {
      await app.cloudDb.update(licenses).set({ machineId: null }).where(eq(licenses.tenantId, req.params.id));
      return reply.send({ ok: true });
    },
  );

  app.patch<{ Params: { id: string }; Body: { licensesQuota?: number } }>(
    '/api/admin/tenants/:id/quota',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const quota = Number(req.body?.licensesQuota);
      if (!Number.isInteger(quota) || quota < 1 || quota > 1000) {
        return reply.code(400).send({ error: 'licensesQuota debe ser un entero entre 1 y 1000.' });
      }
      const [t] = await app.cloudDb
        .update(tenants)
        .set({ licensesQuota: quota, updatedAt: new Date() })
        .where(eq(tenants.id, req.params.id))
        .returning();
      if (!t) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      return reply.send({ ok: true, licensesQuota: t.licensesQuota });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/tenants/:id/regenerate-license',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const [t] = await app.cloudDb
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, req.params.id))
        .limit(1);
      if (!t) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      await app.cloudDb.update(licenses).set({ status: 'revoked' }).where(eq(licenses.tenantId, req.params.id));
      const licenseKey = LicenseService.generateLicenseKey();
      await app.cloudDb.insert(licenses).values({ tenantId: req.params.id, licenseKey, status: 'pending' });
      return reply.send({ ok: true, licenseKey });
    },
  );
}
