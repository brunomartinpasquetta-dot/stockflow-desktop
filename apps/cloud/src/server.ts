import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';

const PORT = Number(process.env.CLOUD_PORT ?? 3009);
const HOST = process.env.CLOUD_HOST ?? '0.0.0.0';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'changeme' });

  app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() } as const;
  });

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

// Arranca el servidor solo cuando se ejecuta directamente (no al importarlo en tests).
const entry = process.argv[1] ?? '';
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void start();
}
