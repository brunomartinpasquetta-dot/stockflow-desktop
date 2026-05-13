/**
 * Helper de conexión a la base Postgres de la nube de licencias.
 *
 * Recibe el connection string (DATABASE_URL) y devuelve la instancia Drizzle
 * sobre postgres-js, ya tipada con `cloudSchema`.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import { cloudSchema } from '../schema/cloud';

export type CloudDatabase = PostgresJsDatabase<typeof cloudSchema> & { $client: Sql };

export interface CloudDbHandle {
  db: CloudDatabase;
  /** Cierra la conexión subyacente (drena el pool). */
  close: () => Promise<void>;
}

/** Abre una conexión Postgres y devuelve la instancia Drizzle + un `close()`. */
export function createCloudDb(connectionString: string, options?: { max?: number }): CloudDbHandle {
  const sql = postgres(connectionString, { max: options?.max ?? 10 });
  const db = drizzle(sql, { schema: cloudSchema }) as CloudDatabase;
  return {
    db,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
