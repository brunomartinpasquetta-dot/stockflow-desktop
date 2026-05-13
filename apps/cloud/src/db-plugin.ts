/**
 * Registro de la base Postgres de la nube en la instancia Fastify.
 *
 * No usamos `fastify-plugin` (no está instalado): simplemente decoramos la
 * instancia con `cloudDb` y registramos un hook `onClose` para drenar el pool.
 *
 * En tests (NODE_ENV=test) se puede inyectar una base alternativa (pglite) para
 * no requerir un Postgres real.
 */
import type { FastifyInstance } from 'fastify';
import { createCloudDb, type CloudDatabase } from '@stockflow/db';

import { DATABASE_URL } from './config';

declare module 'fastify' {
  interface FastifyInstance {
    cloudDb: CloudDatabase;
  }
}

export async function registerDb(app: FastifyInstance, db?: CloudDatabase): Promise<void> {
  if (db) {
    app.decorate('cloudDb', db);
    return;
  }
  const handle = createCloudDb(DATABASE_URL);
  app.decorate('cloudDb', handle.db);
  app.addHook('onClose', async () => {
    await handle.close();
  });
}
