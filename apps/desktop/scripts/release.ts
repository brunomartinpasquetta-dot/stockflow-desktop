/**
 * Script de release local para StockFlow Desktop.
 *
 * - Lee la versión desde package.json.
 * - Genera/actualiza CHANGELOG.md con los commits desde el último tag (v*).
 * - Crea el tag `v<version>` si no existe.
 * - Si hay `GH_TOKEN` en el entorno, ejecuta `electron-builder --publish=always`
 *   para subir los instaladores al GitHub Release. Sin token, sólo hace build
 *   local.
 *
 * Uso:
 *   tsx scripts/release.ts            # build local sin publicar
 *   GH_TOKEN=... tsx scripts/release.ts publish
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string };
const version = pkg.version;
const tag = `v${version}`;

function run(cmd: string): string {
  return execSync(cmd, { cwd: appRoot, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function lastTag(): string | null {
  try {
    return run('git describe --tags --abbrev=0 --match "v*"');
  } catch {
    return null;
  }
}

function tagExists(t: string): boolean {
  try {
    run(`git rev-parse ${t}`);
    return true;
  } catch {
    return false;
  }
}

function commitsSince(t: string | null): string {
  const range = t ? `${t}..HEAD` : 'HEAD';
  try {
    return run(`git log ${range} --pretty=format:"- %s (%h)"`);
  } catch {
    return '';
  }
}

function updateChangelog(): void {
  const previous = lastTag();
  const body = commitsSince(previous);
  const header = `## ${tag} — ${new Date().toISOString().slice(0, 10)}\n\n${body || '_sin cambios_'}\n\n`;
  const changelog = join(appRoot, '..', '..', 'CHANGELOG.md');
  const existing = existsSync(changelog) ? readFileSync(changelog, 'utf8') : '# Changelog\n\n';
  writeFileSync(changelog, header + existing, 'utf8');
  console.log(`[release] CHANGELOG.md actualizado con ${tag}.`);
}

function main(): void {
  console.log(`[release] versión: ${version}`);
  updateChangelog();
  if (!tagExists(tag)) {
    run(`git tag -a ${tag} -m "release ${tag}"`);
    console.log(`[release] tag ${tag} creado (no se hace push automático).`);
  } else {
    console.log(`[release] tag ${tag} ya existe.`);
  }

  const wantPublish = process.argv.includes('publish');
  const hasToken = !!process.env.GH_TOKEN;
  if (wantPublish && hasToken) {
    console.log('[release] publicando con electron-builder...');
    run('pnpm exec electron-builder -mw --publish=always');
  } else {
    console.log('[release] build local (sin publicar). Usá `publish` + GH_TOKEN para subir el release.');
  }
}

main();
