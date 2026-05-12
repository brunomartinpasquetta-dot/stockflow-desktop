/**
 * Bootstrap de la base SQLite local.
 *  - getDatabasePath(): {userData}/stockflow.db (cross-platform).
 *  - initialize(): crea/migra/seedea la DB y arma los repositorios.
 *  - shutdown(): cierra la conexión (idempotente).
 */
import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeLocalDb, createRepositories, initLocalDb, type LocalDatabase, type Repositories } from '@stockflow/db';

export interface DbHandle {
  db: LocalDatabase;
  repos: Repositories;
  dbPath: string;
}

/** Carpeta de migraciones empaquetadas junto al bundle (ver scripts/build-electron.mjs). */
const MIGRATIONS_FOLDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
  'local',
);

/** Ruta absoluta del archivo de base de datos en el directorio de datos del usuario. */
export function getDatabasePath(): string {
  return path.join(app.getPath('userData'), 'stockflow.db');
}

let closed = false;

export function initialize(dbPath: string): DbHandle {
  closed = false;
  const { db } = initLocalDb(dbPath, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, repos: createRepositories(db), dbPath };
}

export function shutdown(handle: DbHandle | null): void {
  if (!handle || closed) return;
  closed = true;
  try {
    closeLocalDb(handle.db);
  } catch {
    // ya cerrada o nunca abierta: nada que hacer.
  }
}
