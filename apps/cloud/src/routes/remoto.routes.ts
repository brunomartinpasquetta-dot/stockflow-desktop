/**
 * ACCESO REMOTO — alta y baja automáticas para el sistema del comercio.
 *
 *  - POST /api/remoto/alta  → el comercio pide su acceso remoto y recibe, en el
 *                             momento, su dirección y su credencial.
 *  - POST /api/remoto/baja  → lo apaga y borra su túnel.
 *
 * Se identifica con el MISMO token de licencia que ya usa para el heartbeat:
 * si su licencia no está activa, no hay acceso remoto.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { tenants } from '@stockflow/db';

import {
  REMOTO_CF_ACCOUNT_ID,
  REMOTO_CF_API_TOKEN,
  REMOTO_CF_ZONE_ID,
  REMOTO_DOMINIO,
} from '../config';
import { RemoteAccessService } from '../services/RemoteAccessService';

function servicio(): RemoteAccessService | null {
  if (!REMOTO_CF_API_TOKEN || !REMOTO_CF_ACCOUNT_ID || !REMOTO_CF_ZONE_ID) return null;
  return new RemoteAccessService({
    apiToken: REMOTO_CF_API_TOKEN,
    accountId: REMOTO_CF_ACCOUNT_ID,
    zoneId: REMOTO_CF_ZONE_ID,
    dominio: REMOTO_DOMINIO,
  });
}

export async function remotoRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/remoto/alta',
    { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const svc = servicio();
      if (!svc) {
        return reply.code(503).send({ error: 'El acceso remoto todavía no está habilitado en el servidor.' });
      }
      const user = req.user;
      const [tenant] = await app.cloudDb.select().from(tenants).where(eq(tenants.id, user.tid)).limit(1);
      if (!tenant) return reply.code(404).send({ error: 'Cuenta no encontrada' });
      try {
        const alta = await svc.alta(tenant.id, tenant.companyName);
        req.log.info({ tenant: tenant.companyName, hostname: alta.hostname }, 'acceso remoto dado de alta');
        return reply.send(alta);
      } catch (err) {
        req.log.error({ err }, 'no se pudo dar de alta el acceso remoto');
        return reply.code(502).send({
          error: 'No se pudo configurar el acceso remoto en este momento. Intente de nuevo en unos minutos.',
        });
      }
    },
  );

  app.post(
    '/api/remoto/baja',
    { preHandler: app.authenticate },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const svc = servicio();
      if (!svc) return reply.code(503).send({ error: 'El acceso remoto no está habilitado en el servidor.' });
      const user = req.user;
      try {
        const borrado = await svc.baja(user.tid);
        return reply.send({ ok: true, borrado });
      } catch (err) {
        req.log.error({ err }, 'no se pudo dar de baja el acceso remoto');
        return reply.code(502).send({ error: 'No se pudo dar de baja el acceso remoto.' });
      }
    },
  );
}
