/**
 * Publicación de versiones: que una versión de prueba (1.13.0-beta.1) no le
 * llegue a ningún cliente y que las novedades sigan andando con ese sufijo.
 *   pnpm --filter @stockflow/desktop test:publicacion
 *
 *  - Toda versión del package.json tiene su entrada en release-notes.json (la
 *    regla de cada release, ahora comprobada antes de compilar).
 *  - Una versión de prueba no abre la ventana de novedades.
 *  - El sufijo no rompe la comparación (antes daba NaN y, en una PC que tuvo la
 *    beta, las novedades de la versión final no aparecían nunca).
 *  - El workflow publica las versiones con sufijo como BORRADOR y sólo desde el
 *    tag v<versión>; el updater de un cliente en canal estable sólo mira
 *    /releases/latest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cmpVersion, computarPendientes, type VersionNotas } from '../novedades/novedades';
import { compareVersions } from '../updater';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(AQUI, '..', '..');
const RAIZ = join(DESKTOP, '..', '..');

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${detalle ? `  → ${detalle}` : ''}`);
}

// ── Comparación de versiones con sufijo ─────────────────────────────────────
check(cmpVersion('1.13.0-beta.1', '1.12.1') > 0, 'la beta 1.13.0-beta.1 es posterior a la 1.12.1');
check(cmpVersion('1.13.0-beta.1', '1.13.0') < 0, 'la beta es anterior a su versión final');
check(cmpVersion('1.13.0', '1.13.0-beta.1') > 0, 'la final es posterior a su beta (antes daba NaN)');
check(cmpVersion('1.13.0-beta.2', '1.13.0-beta.1') > 0, 'entre betas manda el número');
check(cmpVersion('1.13.0-beta.1', '1.13.0-beta.1') === 0, 'la misma beta es igual a sí misma');
check(cmpVersion('1.12.1', '1.12.1') === 0 && cmpVersion('1.12.10', '1.12.9') > 0, 'las versiones normales comparan igual que antes');
check(
  compareVersions('1.13.0', '1.13.0-beta.1') > 0 && compareVersions('1.12.2', '1.13.0-beta.1') < 0,
  'el updater compara igual: la final reemplaza a la beta, una 1.12.x no la "actualiza" para atrás',
);

// ── Novedades con versiones de prueba ───────────────────────────────────────
const notas: VersionNotas[] = [
  { version: '1.13.0', novedades: ['Sucursales.'], internas: false },
  { version: '1.13.0-beta.1', novedades: [], internas: false },
  { version: '1.12.1', novedades: [], internas: true },
  { version: '1.12.0', novedades: ['Facturas por teléfono.'], internas: false },
];
const instalada = computarPendientes('1.13.0-beta.1', null, notas);
check(instalada.hidden && !instalada.internas, 'PC con la beta recién instalada: no muestra ventana', JSON.stringify(instalada));
const desdeEstable = computarPendientes('1.13.0-beta.1', '1.12.1', notas);
check(desdeEstable.hidden && !desdeEstable.internas, 'de 1.12.1 a la beta: tampoco (la beta no anuncia nada)', JSON.stringify(desdeEstable));
const betaAFinal = computarPendientes('1.13.0', '1.13.0-beta.1', notas);
check(
  !betaAFinal.hidden && betaAFinal.items.map((n) => n.version).join() === '1.13.0',
  'PC que tuvo la beta y pasa a la 1.13.0: ve las novedades de la 1.13.0',
  JSON.stringify(betaAFinal.items.map((n) => n.version)),
);
const clienteAFinal = computarPendientes('1.13.0', '1.12.1', notas);
check(
  !clienteAFinal.hidden && clienteAFinal.items.map((n) => n.version).join() === '1.13.0' && !clienteAFinal.internas,
  'cliente de 1.12.1 a 1.13.0: ve la 1.13.0 y la entrada de la beta no suma nada',
  JSON.stringify(clienteAFinal),
);

// ── release-notes.json real contra la versión del package.json ──────────────
const version = (JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as { version: string }).version;
const reales = (
  JSON.parse(readFileSync(join(DESKTOP, 'electron', 'novedades', 'release-notes.json'), 'utf8')) as {
    versiones: VersionNotas[];
  }
).versiones;
const entrada = reales.find((n) => n.version === version);
check(!!entrada, `la versión ${version} tiene su entrada en release-notes.json (va ANTES del tag)`);
if (version.includes('-')) {
  check(
    !!entrada && entrada.novedades.length === 0 && entrada.internas === false,
    `la versión de prueba ${version} no muestra nada a nadie (novedades vacías, internas false)`,
    JSON.stringify(entrada),
  );
}

// ── Workflow de publicación y updater ───────────────────────────────────────
// Con finales de línea de Windows (el checkout del runner de Windows convierte
// a CRLF): se normaliza antes de mirar el texto, si no `\n\s*fi\n` no casa y el
// job de Windows falla en este paso (pasó en el primer "Run workflow" de la beta).
const sinCR = (texto: string): string => texto.replace(/\r\n/g, '\n');
const workflow = sinCR(readFileSync(join(RAIZ, '.github', 'workflows', 'release.yml'), 'utf8'));
check(
  workflow.includes('echo "EP_DRAFT=true" >> "$GITHUB_ENV"') && workflow.includes('*-*)'),
  'release.yml: una versión con sufijo se publica como BORRADOR',
);
check(
  workflow.includes('"$GITHUB_REF_TYPE" != "tag"') && workflow.includes('"$GITHUB_REF_NAME" != "v$VERSION"'),
  'release.yml: se publica sólo desde el tag v<versión> (nunca desde una rama)',
);
check(!/^\s*EP_PRE_RELEASE:/m.test(workflow), 'release.yml: ya no publica betas como prerelease (les llegaban al canal Beta)');
// Beta SIN tag: "Run workflow" sobre una rama compila y deja el instalador como
// artefacto del run. El tag de un borrador es público y el canal Beta lo vería
// en releases.atom; sin tag ni release no hay nada que ver ni que publicar.
const bloqueRama = /if \[ "\$GITHUB_EVENT_NAME" = "workflow_dispatch" \] && \[ "\$GITHUB_REF_TYPE" = "branch" \]; then([\s\S]*?)\n\s*fi\n/.exec(workflow)?.[1] ?? '';
check(
  /\*-\*\)[\s\S]*SOLO_ARTEFACTO=true[\s\S]*exit 0/.test(bloqueRama) && /\*\)[\s\S]*::error::[\s\S]*exit 1/.test(bloqueRama),
  'release.yml: desde una rama sólo se compila una versión de prueba, sin publicar (una final da error)',
);
const pasos = workflow.split(/\n\s*- (?=name:|run:|uses:)/);
const publica = pasos.filter((p) => /run: pnpm --filter @stockflow\/desktop run publish:(mac|win)/.test(p));
check(
  publica.length === 2 && publica.every((p) => p.includes("env.SOLO_ARTEFACTO != 'true'")),
  'release.yml: los pasos que publican no corren para la versión de prueba sin tag',
);
const sinPublicar = pasos.filter((p) => p.includes("env.SOLO_ARTEFACTO == 'true'") && p.includes('scripts/package.mjs'));
check(
  sinPublicar.length === 2 && sinPublicar.every((p) => p.includes('--publish=never') && !p.includes('GH_TOKEN')),
  'release.yml: la versión de prueba se compila con --publish=never y sin token',
);
check(
  pasos.some((p) => p.includes('actions/upload-artifact@') && p.includes("env.SOLO_ARTEFACTO == 'true'") && p.includes('if-no-files-found: error')),
  'release.yml: el instalador de prueba queda como artefacto del run',
);
const updater = sinCR(readFileSync(join(DESKTOP, 'electron', 'updater.ts'), 'utf8'));
check(
  updater.includes("autoUpdater.allowPrerelease = prefs.channel === 'beta'") &&
    updater.includes('/releases/latest'),
  'updater: en canal estable no acepta versiones de prueba y mira sólo /releases/latest',
);

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
