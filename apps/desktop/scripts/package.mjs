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
import { existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const desktopDir = resolve(here, '..');

const symlinkDirs = [
  join(repoRoot, 'packages', 'shared', 'node_modules', '@stockflow'),
  join(repoRoot, 'packages', 'db', 'node_modules', '@stockflow'),
];

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
try {
  execSync(`pnpm exec electron-builder ${args}`, {
    stdio: 'inherit',
    cwd: desktopDir,
  });
} finally {
  restore();
}
