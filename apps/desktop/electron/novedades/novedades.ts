/**
 * NOVEDADES POST-ACTUALIZACIÓN — qué se le muestra al cliente tras un update.
 *
 * Las notas viven en release-notes.json (redactadas a mano por release, en
 * lenguaje de comerciante). Acá va la mecánica:
 *  - `{userData}/novedades.json` guarda la última versión CUYAS novedades ya
 *    se mostraron (por máquina, como onboarding.json — una vez y no molesta más).
 *  - Al pedir pendientes se devuelven las versiones posteriores a la vista y
 *    hasta la actual, acumuladas (por si el cliente salteó versiones).
 *  - Sin registro previo (estreno de la función o instalación que ya venía
 *    andando) se muestran solo las de la versión actual: nunca un historial.
 *  - El JSON se carga en RUNTIME (mismo motivo que la KB de Flowy: nada de
 *    JSON inlineado en main.mjs).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = 'novedades.json';

export interface VersionNotas {
  version: string;
  novedades: string[];
  internas: boolean;
}

export interface NovedadesPendientes {
  /** true → no hay nada para mostrar. */
  hidden: boolean;
  versionActual: string;
  /** Versiones con novedades visibles, de la más nueva a la más vieja. */
  items: VersionNotas[];
  /** Alguna de las versiones del rango trajo correcciones internas. */
  internas: boolean;
}

let cache: VersionNotas[] | null = null;

/** Bundleado, el JSON vive junto a main.mjs; con tsx (tests), junto a este .ts. */
export function leerNotas(): VersionNotas[] {
  if (cache) return cache;
  for (const rel of ['novedades-release-notes.json', 'release-notes.json']) {
    try {
      const raw = JSON.parse(readFileSync(join(HERE, rel), 'utf8')) as { versiones: VersionNotas[] };
      cache = raw.versiones ?? [];
      return cache;
    } catch {
      /* siguiente candidato */
    }
  }
  // Sin notas no se rompe nada: simplemente no hay ventana de novedades.
  console.error('[novedades] no pude cargar release-notes.json — no se mostrarán novedades.');
  cache = [];
  return cache;
}

export function versionVista(userDataDir: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(userDataDir, STATE_FILE), 'utf8')) as { ultimaVersionVista?: string })
      .ultimaVersionVista;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function marcarVista(userDataDir: string, version: string): void {
  writeFileSync(join(userDataDir, STATE_FILE), JSON.stringify({ ultimaVersionVista: version }));
}

/**
 * Comparación de versiones x.y.z (devuelve <0, 0, >0 como un comparator).
 * Acepta versiones de prueba (1.13.0-beta.1): son MENORES que su versión final
 * y entre ellas manda el número (misma regla que `compareVersions` del
 * updater). Antes el sufijo daba NaN: en una PC que tuvo una beta, las
 * novedades de la versión final no se mostraban nunca.
 */
export function cmpVersion(a: string, b: string): number {
  const partes = (v: string) => {
    const [nucleo = '', prueba] = v.split('-', 2);
    return {
      nums: nucleo.split('.').map((n) => Number(n) || 0),
      prueba: prueba === undefined ? null : Number(prueba.replace(/[^0-9]/g, '')) || 0,
    };
  };
  const pa = partes(a);
  const pb = partes(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.prueba === null && pb.prueba === null) return 0;
  if (pa.prueba === null) return 1; // final > prueba
  if (pb.prueba === null) return -1;
  return pa.prueba - pb.prueba;
}

export function computarPendientes(actual: string, vista: string | null, notas: VersionNotas[]): NovedadesPendientes {
  // Rango a mostrar: (vista, actual]; sin registro previo, solo la actual.
  const enRango = notas.filter((n) =>
    vista == null
      ? cmpVersion(n.version, actual) === 0
      : cmpVersion(n.version, vista) > 0 && cmpVersion(n.version, actual) <= 0,
  );
  const items = enRango
    .filter((n) => n.novedades.length > 0)
    .sort((a, b) => cmpVersion(b.version, a.version));
  const internas = enRango.some((n) => n.internas);
  // Solo correcciones internas en el rango → no se molesta al cliente.
  return { hidden: items.length === 0, versionActual: actual, items, internas };
}
