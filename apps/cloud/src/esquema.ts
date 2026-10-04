/**
 * Chequeo del esquema al arrancar el cloud.
 *
 * Las migraciones del cloud se aplican a mano con psql en el VPS. El código
 * nombra todas las columnas del schema de Drizzle en cada `select().from(...)`
 * e `insert`: si se despliega el código antes que el SQL, Postgres contesta
 * "column ... does not exist" en /activate, /heartbeat, la prueba gratis y el
 * alta del acceso remoto. Le pegaría a TODOS los clientes: el que tuvo la PC
 * apagada más de 7 días no podría renovar el JWT y caería en Activación.
 *
 * Por eso, antes de atender pedidos, el cloud verifica las columnas que sumó
 * esta versión y aplica sus migraciones ADITIVAS e idempotentes si faltan
 * (las mismas sentencias del .sql). Si no puede (permisos), NO arranca y dice
 * qué correr: mejor un deploy que no levanta que uno que rompe las licencias.
 *
 * Columnas cubiertas:
 *   - tenants.edicion (0003_tenant_edicion.sql)
 */
import { sql } from 'drizzle-orm';

import type { CloudDatabase } from '@stockflow/db';

/** Filas de `db.execute` (postgres-js devuelve un array; pglite, `{ rows }`). */
function filas(r: unknown): Record<string, unknown>[] {
  if (Array.isArray(r)) return r as Record<string, unknown>[];
  const rows = (r as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function existeColumna(db: CloudDatabase, tabla: string, columna: string): Promise<boolean> {
  const r = await db.execute(
    sql`SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${tabla} AND column_name = ${columna} LIMIT 1`,
  );
  return filas(r).length > 0;
}

export interface ResultadoEsquema {
  /** Migraciones que se aplicaron en este arranque (vacío si ya estaba todo). */
  aplicadas: string[];
}

/** Verifica y completa el esquema. Tira un Error con instrucciones si no puede. */
export async function asegurarEsquema(
  db: CloudDatabase,
  log: { info: (m: string) => void } = { info: () => {} },
): Promise<ResultadoEsquema> {
  const aplicadas: string[] = [];
  if (!(await existeColumna(db, 'tenants', 'edicion'))) {
    try {
      // Mismas sentencias que packages/db/migrations/cloud/0003_tenant_edicion.sql.
      await db.execute(sql`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS edicion varchar(16) NOT NULL DEFAULT 'comun'`);
      await db.execute(sql`ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_edicion_check`);
      await db.execute(
        sql`ALTER TABLE tenants ADD CONSTRAINT tenants_edicion_check CHECK (edicion IN ('comun', 'multisucursal'))`,
      );
    } catch (err) {
      throw new Error(
        'Falta la columna tenants.edicion y no se pudo agregar sola ' +
          `(${err instanceof Error ? err.message : String(err)}). Corra antes de arrancar: ` +
          'psql "$DATABASE_URL" -f packages/db/migrations/cloud/0003_tenant_edicion.sql',
      );
    }
    if (!(await existeColumna(db, 'tenants', 'edicion'))) {
      throw new Error(
        'Falta la columna tenants.edicion. Corra: psql "$DATABASE_URL" -f packages/db/migrations/cloud/0003_tenant_edicion.sql',
      );
    }
    aplicadas.push('0003_tenant_edicion');
    log.info('esquema: se aplicó 0003_tenant_edicion (tenants.edicion)');
  }
  return { aplicadas };
}
