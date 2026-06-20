/**
 * Bootstrap de la base SQLite local.
 *  - getDatabasePath(): {userData}/stockflow.db (cross-platform).
 *  - initialize(): crea/migra/seedea la DB y arma los repositorios.
 *  - shutdown(): cierra la conexión (idempotente).
 */
import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeLocalDb, createRepositories, initLocalDb, roleAreaAccess, type LocalDatabase, type Repositories } from '@stockflow/db';
import { applyAreaConfig } from '@stockflow/core';

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
  const repos = createRepositories(db);

  // Cargar la configuración de permisos por rol/área en el motor de @stockflow/core.
  // Si la tabla está vacía (DB recién migrada sin seed), `applyAreaConfig([])`
  // recompone manager/seller como vacío salvo lo que diga la config; pero el seed
  // ya la pobló, así que en la práctica siempre hay filas. admin nunca depende de esto.
  try {
    const rows = db
      .select({
        role: roleAreaAccess.role,
        area: roleAreaAccess.area,
        allowed: roleAreaAccess.allowed,
      })
      .from(roleAreaAccess)
      .all();
    if (rows.length > 0) {
      applyAreaConfig(rows);
    }
  } catch (err) {
    // Si la tabla no existiera por algún motivo, dejamos el DEFAULT (PERMISSION_MATRIX).
    console.error('[bootstrap/db] No se pudo cargar role_area_access:', err);
  }

  return { db, repos, dbPath };
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
