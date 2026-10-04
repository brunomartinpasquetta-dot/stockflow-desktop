/**
 * Funciones que dependen de la EDICIÓN de la licencia (común / multisucursal).
 *
 * Fuente única del backend para preguntar "¿este comercio tiene
 * multisucursal?". La edición viaja en el JWT de licencia firmado por el cloud
 * (claim `edicion`); un token sin el claim —todos los de hoy— es edición común.
 *
 * Override de DESARROLLO: con la app SIN empaquetar (`!app.isPackaged`) y la
 * variable `STOCKFLOW_PLAN=multisucursal`, se fuerza la edición multisucursal
 * para probar en el sandbox sin tocar el cloud. En un build empaquetado la
 * variable se ignora SIEMPRE (lo garantiza license.smoke.ts), y tampoco se
 * puede cambiar la clave pública con que se verifica el token de licencia ni
 * usar el bypass de NODE_ENV=development (ver `configCloud` en
 * cloud-public-key.ts y LicenseManager.getState): si no, la edición se
 * conseguiría firmando un token propio.
 *
 *   STOCKFLOW_PLAN=multisucursal pnpm --filter @stockflow/desktop dev
 *
 * Interruptor de PRUEBA ("Edición Multisucursal (versión de prueba)"): para
 * evaluar Multisucursal en PC reales con una versión de prueba instalada
 * (1.13.0-beta.1) sin tocar el servidor de licencias. Regla dura:
 *  - Existe ÚNICAMENTE si la versión de la app (`app.getVersion()`) lleva
 *    sufijo de prueba: -alpha, -beta o -rc. En una versión final (1.13.0,
 *    1.12.1…) `esVersionDePrueba` es false y el archivo se ignora aunque
 *    exista: la edición vuelve a depender sólo del token.
 *  - Se guarda en `userData/edicion-prueba.json`
 *    (`{"edicion":"multisucursal","activadaEl":…}`), el archivo de la PC que
 *    tiene la base. Una terminal nunca lo necesita.
 *  - Sólo SUBE a multisucursal: nunca baja una edición real del token.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Edicion } from './types';

/** Variable de entorno del override de desarrollo. */
export const VAR_PLAN_DESARROLLO = 'STOCKFLOW_PLAN';

/** Archivo del interruptor de prueba, dentro del userData de la PC. */
export const ARCHIVO_EDICION_PRUEBA = 'edicion-prueba.json';

/** Contenido de `edicion-prueba.json`. */
export interface EdicionPruebaArchivo {
  edicion: string;
  /** Cuándo se activó (epoch ms). */
  activadaEl: number;
}

/** Cualquier valor que no sea exactamente 'multisucursal' es edición común. */
export function normalizarEdicion(valor: unknown): Edicion {
  return valor === 'multisucursal' ? 'multisucursal' : 'comun';
}

/**
 * Versión con sufijo de prueba: `1.13.0-beta.1`, `2.0.0-rc.2`, `1.14.0-alpha`.
 * Una final (`1.13.0`) o cualquier cosa que no sea una versión → false.
 */
const VERSION_DE_PRUEBA = /^\d+\.\d+\.\d+-(?:alpha|beta|rc)(?:[.-]?\d+)*(?:\+[0-9A-Za-z.-]+)?$/i;

/** ¿Es una versión de prueba (-alpha / -beta / -rc)? */
export function esVersionDePrueba(version: string | null | undefined): boolean {
  return typeof version === 'string' && VERSION_DE_PRUEBA.test(version.trim());
}

/**
 * ¿Rige el interruptor de prueba? Las dos cosas a la vez: versión de prueba Y
 * un archivo que pide 'multisucursal'. En una versión final el archivo no
 * cuenta, exista o no.
 */
export function interruptorDePruebaActivo(
  version: string | null | undefined,
  archivo: EdicionPruebaArchivo | null | undefined,
): boolean {
  return esVersionDePrueba(version) && normalizarEdicion(archivo?.edicion) === 'multisucursal';
}

/** Lo que `edicionEfectiva` necesita saber de esta PC. */
export interface EntornoEdicion {
  /** `app.isPackaged`. */
  empaquetada: boolean;
  env: Record<string, string | undefined>;
  /** `app.getVersion()`. Sin versión no existe el interruptor de prueba. */
  version?: string;
  /** Contenido de `edicion-prueba.json` (null si no existe). */
  edicionPrueba?: EdicionPruebaArchivo | null;
}

/**
 * Edición que rige de verdad: la del token, salvo el override de desarrollo
 * (sólo con la app sin empaquetar) o el interruptor de prueba (sólo en una
 * versión de prueba, y sólo para subir a multisucursal).
 */
export function edicionEfectiva(edicionDelToken: unknown, entorno: EntornoEdicion): Edicion {
  if (!entorno.empaquetada && entorno.env[VAR_PLAN_DESARROLLO] === 'multisucursal') return 'multisucursal';
  const delToken = normalizarEdicion(edicionDelToken);
  if (delToken === 'multisucursal') return 'multisucursal';
  if (interruptorDePruebaActivo(entorno.version, entorno.edicionPrueba)) return 'multisucursal';
  return delToken;
}

/** Lee `edicion-prueba.json`. null si no existe o no se entiende (nunca rompe). */
export function leerEdicionPrueba(userDataDir: string): EdicionPruebaArchivo | null {
  try {
    const ruta = path.join(userDataDir, ARCHIVO_EDICION_PRUEBA);
    if (!existsSync(ruta)) return null;
    const crudo = JSON.parse(readFileSync(ruta, 'utf8')) as Partial<EdicionPruebaArchivo> | null;
    if (!crudo || typeof crudo !== 'object' || typeof crudo.edicion !== 'string') return null;
    return { edicion: crudo.edicion, activadaEl: typeof crudo.activadaEl === 'number' ? crudo.activadaEl : 0 };
  } catch {
    return null;
  }
}

/**
 * Escribe el archivo del interruptor (activar) o lo borra (desactivar).
 * No mira la versión: eso lo decide quien llama (LicenseManager.setEdicionPrueba).
 */
export function guardarEdicionPrueba(userDataDir: string, activa: boolean, ahora = Date.now()): EdicionPruebaArchivo | null {
  const ruta = path.join(userDataDir, ARCHIVO_EDICION_PRUEBA);
  if (!activa) {
    if (existsSync(ruta)) rmSync(ruta);
    return null;
  }
  mkdirSync(userDataDir, { recursive: true });
  const contenido: EdicionPruebaArchivo = { edicion: 'multisucursal', activadaEl: ahora };
  writeFileSync(ruta, `${JSON.stringify(contenido, null, 2)}\n`);
  return contenido;
}

/** Lo que el backend necesita para preguntar por la edición. */
export interface DepsConLicencia {
  licenseManager: { getState(): { edicion?: Edicion } };
}

/** ¿Este comercio tiene la edición Multisucursal? (helper del backend). */
export function tieneMultisucursal(deps: DepsConLicencia): boolean {
  try {
    return deps.licenseManager.getState().edicion === 'multisucursal';
  } catch {
    return false; // ante cualquier duda, edición común: nada nuevo a la vista
  }
}
