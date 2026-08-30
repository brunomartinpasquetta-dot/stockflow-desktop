/**
 * Carga en RUNTIME los JSON de conocimiento del asistente (intents + manual).
 *
 * NO se importan estáticamente: esbuild los inlinearía como literales gigantes
 * (~600 KB c/u) dentro de main.mjs, y V8 crashea (SIGTRAP en TurboFan) al
 * compilar ese bundle en la app empaquetada. `JSON.parse` en runtime evita el
 * compilador por completo y además arranca más rápido.
 *
 * Rutas: bundleado, los archivos viven junto a main.mjs (los copia
 * build-electron.mjs); corriendo el fuente con tsx (tests), junto a este .ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Si algo de la KB no cargó, acá queda el motivo. Una KB rota NO debe impedir
 * arrancar StockFlow: el asistente se degrada (responde que no está disponible)
 * y el resto de la app sigue — antes el throw en top-level brickeaba el main.
 */
export let kbLoadError: string | null = null;

function loadJson(candidates: string[], what: string, fallback: unknown): unknown {
  const intentos: string[] = [];
  for (const rel of candidates) {
    try {
      return JSON.parse(readFileSync(join(HERE, rel), 'utf8'));
    } catch (e) {
      intentos.push(`${rel}: ${(e as Error).message}`);
    }
  }
  kbLoadError = `[assistant] no pude cargar ${what} — ${intentos.join(' | ')}`;
  console.error(`${kbLoadError}\n[assistant] el asistente queda deshabilitado; StockFlow sigue funcionando.`);
  return fallback;
}

export const intentsData: unknown = loadJson(['assistant-intents.json', 'intents.json'], 'intents', { areas: [] });
export const manualData: unknown = loadJson(
  ['manual-sections.json', join('..', '..', 'manual-src', 'sections.json')],
  'manual',
  { sections: [] },
);
