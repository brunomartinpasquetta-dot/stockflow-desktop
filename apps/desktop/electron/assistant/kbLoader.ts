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

function loadJson(candidates: string[]): unknown {
  for (const rel of candidates) {
    try {
      return JSON.parse(readFileSync(join(HERE, rel), 'utf8'));
    } catch {
      /* probar la siguiente ruta */
    }
  }
  throw new Error(`[assistant] no pude cargar ${candidates.join(' ni ')}`);
}

export const intentsData: unknown = loadJson(['assistant-intents.json', 'intents.json']);
export const manualData: unknown = loadJson(['manual-sections.json', join('..', '..', 'manual-src', 'sections.json')]);
