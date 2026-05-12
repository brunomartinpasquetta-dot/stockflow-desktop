import { defineConfig } from 'drizzle-kit';

/**
 * Config dual de Drizzle:
 *  - sqliteConfig  -> base local del desktop (better-sqlite3), schema en src/schema/local.ts,
 *                     migraciones versionadas en ./migrations/local
 *  - pgConfig      -> base cloud (Postgres), schema en src/schema/cloud.ts (se completa más adelante)
 *
 * Por defecto exportamos sqliteConfig (operación local).
 * NOTA: `drizzle-kit push` solo para dev; en producción se aplican las migraciones generadas.
 */
export const sqliteConfig = defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/local.ts',
  out: './migrations/local',
  dbCredentials: {
    url: process.env.SQLITE_PATH ?? './data/stockflow.db',
  },
});

export const pgConfig = defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/cloud.ts',
  out: './migrations/cloud',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/stockflow',
  },
});

export default sqliteConfig;
