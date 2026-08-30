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
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const outDir = join(appRoot, 'dist-electron');
const repoRoot = resolve(appRoot, '..', '..');
const dbMigrations = join(repoRoot, 'packages', 'db', 'migrations');

// La KB de Flowy se valida ANTES de compilar: un intents.json roto o con
// imágenes inexistentes no debe llegar a un release (falla acá, no en el cliente).
execFileSync(process.execPath, [join(here, 'validate-kb.mjs')], { stdio: 'inherit' });

const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {});
// Estas deps pure-JS se BUNDLEAN en el output (no quedan external) porque con pnpm
// electron-builder no sigue sus deps transitivas symlinkeadas → quedan incompletas en
// el .asar. Ej.: `archiver` se copiaba sin zip-stream/compress-commons/archiver-utils,
// y `import('archiver')` reventaba con MODULE_NOT_FOUND → "No se pudo crear el backup".
// Bundlearlas con esbuild inlinea todo el grafo y evita depender del node_modules empaquetado.
// Se bundlean con esbuild en vez de dejarse como externas: con pnpm,
// electron-builder copia el paquete pero NO sus dependencias transitivas
// symlinkeadas, y en la app empaquetada revientan con MODULE_NOT_FOUND.
// node-forge firma el pedido a ARCA — si falta, no se puede facturar.
const BUNDLE_IN = new Set(['archiver', 'node-forge', 'jspdf', 'jspdf-autotable']);
const external = [
  'electron',
  ...runtimeDeps.filter((d) => !d.startsWith('@stockflow/') && !BUNDLE_IN.has(d)),
];

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
  // Las deps CJS que bundleamos (p.ej. archiver) hacen `require('fs')` interno.
  // En un output ESM esbuild no tiene `require` → "Dynamic require of fs is not
  // supported" (crash). Inyectamos un `require` real vía createRequire. Sólo en el
  // build ESM (main); el preload es CJS y ya tiene `require` nativo.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
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

// JSON de conocimiento del asistente: se cargan en runtime (kbLoader) en vez de
// inlinearse como literales — V8 crasheaba (SIGTRAP) compilando main.mjs empaquetado.
cpSync(join(appRoot, 'electron', 'assistant', 'intents.json'), join(outDir, 'assistant-intents.json'));
cpSync(join(appRoot, 'manual-src', 'sections.json'), join(outDir, 'manual-sections.json'));

// GUARDIA MECÁNICA anti-SIGTRAP: si algún refactor vuelve a importar la KB
// estáticamente (resolveJsonModule lo permite sin error), esbuild la inlinea y
// V8 crashea SOLO en la app empaquetada — invisible para tsx/type-check/CI.
// Se toma un texto centinela de la KB real y se verifica que NO esté en main.mjs.
{
  const mainSrc = readFileSync(join(outDir, 'main.mjs'), 'utf8');
  const kbRaw = JSON.parse(readFileSync(join(appRoot, 'electron', 'assistant', 'intents.json'), 'utf8'));
  const sentinel = kbRaw.areas?.[0]?.intents?.[0]?.answer?.slice(0, 60);
  if (sentinel && mainSrc.includes(sentinel)) {
    console.error(
      '[build-electron] ❌ main.mjs contiene texto de intents.json: la KB quedó INLINEADA en el bundle.\n' +
        'Eso revive el crash SIGTRAP de V8 en la app empaquetada. Los JSON grandes se cargan en runtime vía kbLoader —\n' +
        'buscá y eliminá el import estático de intents.json/sections.json.',
    );
    process.exit(1);
  }
}

console.log(`[build-electron] externals: ${external.join(', ')}`);
console.log('[build-electron] dist-electron/{main.mjs,preload.cjs,migrations,kb} listo');
