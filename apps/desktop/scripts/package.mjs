/**
 * Wrapper de electron-builder que sortea el ciclo de symlinks pnpm
 * (packages/shared/node_modules/@stockflow/db ↔ packages/db/node_modules/@stockflow/shared)
 * que hace que `app-builder` recurse infinitamente.
 *
 * Uso:
 *   node scripts/package.mjs --mac --dir     → .app sin firma
 *   node scripts/package.mjs --mac dmg       → .dmg sin firma
 *   node scripts/package.mjs --win           → .exe (requiere Windows o wine)
 *
 * Los workspace packages ya están bundleados en dist-electron/main.mjs por esbuild,
 * por lo que esos symlinks no se usan en runtime — sólo molestan al collector.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const desktopDir = resolve(here, '..');

const symlinkDirs = [
  join(repoRoot, 'packages', 'shared', 'node_modules', '@stockflow'),
  join(repoRoot, 'packages', 'db', 'node_modules', '@stockflow'),
];

// Deps transitivas que el collector de electron-builder NO encuentra en el layout
// virtual de pnpm (.pnpm/...). Las copiamos físicamente a apps/desktop/node_modules/
// antes del build y las borramos al terminar. Lista derivada de `require()`s reales
// de los runtime natives (better-sqlite3, usb, serialport, archiver, etc.).
const transitiveDeps = [
  'bindings',
  'file-uri-to-path',
  'prebuild-install',
  'node-addon-api',
  'node-gyp-build',
  'detect-libc',
  'napi-build-utils',
  'simple-get',
  'tar-fs',
];

function copyTransitives() {
  const pnpmStore = join(repoRoot, 'node_modules', '.pnpm');
  const desktopNm = join(desktopDir, 'node_modules');
  const copied = [];
  for (const dep of transitiveDeps) {
    const target = join(desktopNm, dep);
    if (existsSync(target)) continue; // ya está (raro pero por las dudas)
    // Encontrar la última versión disponible en .pnpm para esta dep.
    const candidates = readdirSync(pnpmStore).filter((d) => d.startsWith(`${dep}@`));
    if (candidates.length === 0) {
      console.warn(`  ⚠ transitive '${dep}' no encontrada en .pnpm (saltada)`);
      continue;
    }
    const pick = candidates.sort().pop();
    const src = join(pnpmStore, pick, 'node_modules', dep);
    if (!existsSync(src)) continue;
    cpSync(src, target, { recursive: true, dereference: true });
    copied.push(target);
    console.log(`  + ${dep}@${pick.split('@').pop()}`);
  }
  return copied;
}
function removeCopied(copied) {
  for (const path of copied) {
    rmSync(path, { recursive: true, force: true });
    console.log(`  - cleaned ${path.replace(desktopDir, '.')}`);
  }
}

function backup() {
  for (const dir of symlinkDirs) {
    if (existsSync(dir)) {
      renameSync(dir, `${dir}.bak`);
      console.log(`  ⏸ moved aside: ${dir}`);
    }
  }
}
function restore() {
  for (const dir of symlinkDirs) {
    const bak = `${dir}.bak`;
    if (existsSync(bak)) {
      renameSync(bak, dir);
      console.log(`  ▶ restored: ${dir}`);
    }
  }
}

const args = process.argv.slice(2).join(' ');
console.log(`Packaging StockFlow — args: ${args || '(default)'}`);

backup();
const copied = copyTransitives();
try {
  execSync(`pnpm exec electron-builder ${args}`, {
    stdio: 'inherit',
    cwd: desktopDir,
  });
} finally {
  removeCopied(copied);
  restore();
}
