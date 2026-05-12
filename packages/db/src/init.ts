/**
 * Inicialización completa de la base SQLite local:
 *   1. crea el directorio/archivo si no existe,
 *   2. abre la conexión con WAL + FK,
 *   3. aplica todas las migraciones versionadas de `migrations/local` en orden,
 *   4. ejecuta el seed idempotente,
 *   5. devuelve la instancia Drizzle lista para usar.
 *
 * Pensado para ser invocado una vez al arranque del proceso main de Electron.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { createLocalDb, type LocalDatabase } from './local/client';
import { seedLocalDb, type SeedResult } from './seed';

/** Carpeta de migraciones generadas por drizzle-kit (packages/db/migrations/local). */
export const LOCAL_MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../migrations/local', import.meta.url),
);

export interface InitResult {
  db: LocalDatabase;
  seed: SeedResult;
}

export interface InitLocalDbOptions {
  /** Override de la carpeta de migraciones (útil cuando la app va empaquetada). */
  migrationsFolder?: string;
  /** Si es `false`, no corre el seed. Default `true`. */
  seed?: boolean;
}

export function initLocalDb(
  dbPath: string,
  options: InitLocalDbOptions = {},
): InitResult {
  const { migrationsFolder = LOCAL_MIGRATIONS_FOLDER, seed = true } = options;

  // 1) Asegurar que el directorio contenedor existe (better-sqlite3 crea el archivo,
  //    pero no los directorios intermedios).
  const dir = dirname(dbPath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 2) Abrir conexión.
  const db = createLocalDb(dbPath);

  // 3) Aplicar migraciones.
  //    Algunas migraciones recrean tablas (patrón estándar de SQLite para DROP/ALTER
  //    de columnas con constraints). `migrate()` corre dentro de una transacción, donde
  //    `PRAGMA foreign_keys` es no-op; por eso desactivamos la verificación de FKs
  //    *antes* de la transacción y la restauramos al terminar.
  db.$client.pragma('foreign_keys = OFF');
  try {
    migrate(db, { migrationsFolder });
  } finally {
    db.$client.pragma('foreign_keys = ON');
  }

  // 4) Seed.
  const seedResult: SeedResult = seed
    ? seedLocalDb(db)
    : {
        adminCreated: false,
        consumidorFinalCreated: false,
        defaultFamilyCreated: false,
        companyCreated: false,
        paymentMethodsCreated: 0,
      };

  return { db, seed: seedResult };
}
