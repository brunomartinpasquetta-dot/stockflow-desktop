/**
 * Build del proceso main + preload de Electron.
 *
 * - `main` → bundle ESM (`dist-electron/main.mjs`): inlinea los workspace
 *   packages (@stockflow/*) y sus deps JS (drizzle-orm, bcryptjs, uuid).
 *   ESM para que `import.meta.url` funcione.
 * - `preload` → bundle CJS (`dist-electron/preload.cjs`): los preload con
 *   `sandbox: true` deben ser CommonJS.
 * - Externos: `electron` (lo provee el runtime) + TODAS las `dependencies` de
 *   apps/desktop/package.json que NO sean workspace packages (`@stockflow/*`).
 *   Así `electron-log` y cualquier dep CJS la carga Node directamente (con su
 *   propio loader CJS) en vez de bundlearla y romper los `require` dinámicos en
 *   el output ESM; `better-sqlite3` (nativo) queda external por la misma razón.
 * - Copia las migraciones de @stockflow/db a `dist-electron/migrations/`.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const outDir = join(appRoot, 'dist-electron');
const repoRoot = resolve(appRoot, '..', '..');
const dbMigrations = join(repoRoot, 'packages', 'db', 'migrations');

const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
const external = ['electron', ...runtimeDeps.filter((d) => !d.startsWith('@stockflow/'))];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  external,
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

console.log(`[build-electron] externals: ${external.join(', ')}`);
console.log('[build-electron] dist-electron/{main.mjs,preload.cjs,migrations} listo');
