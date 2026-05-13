/**
 * Servidor Fastify de la API de licencias en la nube de StockFlow.
 *
 * Plugins: helmet, cors, rate-limit, jwt (RS256), static (landing).
 * Rutas: /api/billing/*, /api/licenses/*, /api/me, /api/admin/*, /health.
 *
 * `buildServer({ db })` permite inyectar una base alternativa (pglite) en tests.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { CloudDatabase } from '@stockflow/db';

import {
  CORS_ORIGINS,
  HOST,
  IS_TEST,
  MP_ACCESS_TOKEN,
  MP_WEBHOOK_SECRET,
  PORT,
  SMTP_FROM,
  SMTP_HOST,
  SMTP_PASS,
  SMTP_USER,
} from './config';
import { registerCronJobs } from './cron';
import { registerDb } from './db-plugin';
import { getJwtKeys } from './jwt-keys';
import { adminRoutes } from './routes/admin.routes';
import { billingRoutes } from './routes/billing.routes';
import { licenseRoutes } from './routes/license.routes';
import { EmailService } from './services/EmailService';
import { MercadoPagoService } from './services/MercadoPagoService';

declare module 'fastify' {
  interface FastifyInstance {
    // `cloudDb` se declara también en db-plugin.ts (las augmentaciones se fusionan).
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // Lo que aceptamos al firmar (tokens de licencia o de admin).
    payload: {
      sub?: string;
      tid?: string;
      plan?: string;
      lk?: string;
      admin?: boolean;
      email?: string;
    };
    // Lo que obtenemos al verificar (tokens de licencia: sub/tid/plan/lk siempre presentes).
    user: {
      sub: string;
      tid: string;
      plan: string;
      lk: string;
      admin?: boolean;
      email?: string;
      iat: number;
      exp: number;
    };
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', 'public');

export interface BuildServerOptions {
  db?: CloudDatabase;
}

export async function buildServer(opts?: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: !IS_TEST && process.env.NODE_ENV !== 'test' });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: CORS_ORIGINS ? CORS_ORIGINS.split(',').map((s) => s.trim()) : true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  const keys = getJwtKeys();
  await app.register(jwt, {
    secret: { private: keys.privateKey, public: keys.publicKey },
    sign: { algorithm: 'RS256', expiresIn: '7d' },
  });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'No autorizado' });
    }
  });

  // Base de datos (inyectada en tests, real en producción).
  await registerDb(app, opts?.db);

  // Archivos estáticos (landing).
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  // Servicios.
  const mp = new MercadoPagoService(MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET);
  const email = new EmailService({ host: SMTP_HOST, user: SMTP_USER, pass: SMTP_PASS, from: SMTP_FROM });

  // Rutas.
  await app.register(async (a) => billingRoutes(a, { mp, email }));
  await app.register(licenseRoutes);
  await app.register(async (a) => adminRoutes(a, { email }));

  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // Nota: `IS_TEST` se evalúa al importar `config`; los imports ESM se hoisteán,
  // así que volvemos a chequear `NODE_ENV` en runtime para no agendar crons en tests.
  if (!IS_TEST && process.env.NODE_ENV !== 'test') registerCronJobs(app.cloudDb);

  return app;
}

export async function start(): Promise<void> {
  const app = await buildServer();
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Arranca el servidor sólo cuando se ejecuta directamente (no al importarlo en tests).
const entry = process.argv[1] ?? '';
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void start();
}
