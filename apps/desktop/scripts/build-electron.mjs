/**
 * Build del proceso main + preload de Electron.
 *
 * - `main` → bundle ESM (`dist-electron/main.mjs`): inlinea los workspace
 *   packages (@stockflow/*) y sus deps JS (drizzle-orm, bcryptjs, uuid,
 *   electron-log, electron-store, ...). ESM para que `import.meta.url` funcione.
 * - `preload` → bundle CJS (`dist-electron/preload.cjs`): los preload con
 *   `sandbox: true` deben ser CommonJS.
 * - Externos en ambos: `electron` (lo provee el runtime) y `better-sqlite3`
 *   (módulo nativo: se resuelve desde node_modules en runtime).
 * - Copia las migraciones de @stockflow/db a `dist-electron/migrations/`.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const outDir = join(appRoot, 'dist-electron');
const repoRoot = resolve(appRoot, '..', '..');
const dbMigrations = join(repoRoot, 'packages', 'db', 'migrations');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
};

await build({
  ...common,
  format: 'esm',
  entryPoints: [join(appRoot, 'electron', 'main.ts')],
  outfile: join(outDir, 'main.mjs'),
});

await build({
  ...common,
  format: 'cjs',
  entryPoints: [join(appRoot, 'electron', 'preload.ts')],
  outfile: join(outDir, 'preload.cjs'),
});

if (existsSync(dbMigrations)) {
  cpSync(dbMigrations, join(outDir, 'migrations'), { recursive: true });
}

console.log('[build-electron] dist-electron/{main.mjs,preload.cjs,migrations} listo');
