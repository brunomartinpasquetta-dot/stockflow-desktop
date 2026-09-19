/**
 * Helper de conexión a la base SQLite local del PDV.
 *
 * En runtime la DB vive en `{app.getPath('userData')}/stockflow.db` (Electron),
 * pero esta función es agnóstica del path: recibe `dbPath` y devuelve la instancia
 * Drizzle ya configurada con WAL + FK habilitadas.
 */
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { localSchema } from '../schema/local';

export type LocalDatabase = BetterSQLite3Database<typeof localSchema> & {
  $client: Database.Database;
};

/** Aplica los PRAGMAs recomendados a una conexión better-sqlite3. */
export function applyLocalPragmas(sqlite: Database.Database): void {
  sqlite.pragma('journal_mode = WAL');
  // FULL: cada commit llega al disco antes de responder. Con NORMAL en WAL, un
  // corte de luz justo después de cobrar podía perder la última venta aunque el
  // ticket ya estuviera impreso (auditoría sep-2026). Cuesta ~1 ms por commit.
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
}

/**
 * Abre (o crea) la base SQLite en `dbPath` y devuelve la instancia Drizzle.
 * Síncrono — el driver better-sqlite3 lo es.
 */
export function createLocalDb(dbPath: string): LocalDatabase {
  const sqlite = new Database(dbPath);
  applyLocalPragmas(sqlite);
  return drizzle(sqlite, { schema: localSchema }) as LocalDatabase;
}

/** Cierra correctamente la conexión subyacente. */
export function closeLocalDb(db: LocalDatabase): void {
  db.$client.close();
}
