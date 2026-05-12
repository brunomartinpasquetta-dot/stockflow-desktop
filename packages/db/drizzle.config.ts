import { defineConfig } from 'drizzle-kit';

/**
 * Config dual de Drizzle:
 *  - sqliteConfig  -> base local del desktop (better-sqlite3), schema en src/schema/local.ts
 *  - pgConfig      -> base cloud (Postgres), schema en src/schema/cloud.ts
 *
 * Los schemas todavía están vacíos; se completan en P02.
 * Por defecto exportamos sqliteConfig (operación local).
 */
export const sqliteConfig = defineConfig({
  dialect: 'sqlite',
  schema: './src/schema/local.ts',
  out: './drizzle/local',
  dbCredentials: {
    url: process.env.SQLITE_PATH ?? './data/stockflow.db',
  },
});

export const pgConfig = defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/cloud.ts',
  out: './drizzle/cloud',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/stockflow',
  },
});

export default sqliteConfig;
