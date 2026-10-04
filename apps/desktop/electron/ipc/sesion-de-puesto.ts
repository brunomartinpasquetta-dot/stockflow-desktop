/**
 * Handlers LOCALES de "estado del puesto" (novedades vistas, guía de primeros
 * pasos): archivos en el userData de ESTA PC, sin datos del negocio.
 *
 * Problema (visto en el sandbox de dos locales, oct-2026): en una TERMINAL
 * (modo client) el inicio de sesión va al servidor; el proceso main de la
 * terminal nunca tiene sesión propia. Con `withSession`, `guia:estado` y
 * `novedades:pendientes` respondían UNAUTHENTICATED, el manejador global de la
 * interfaz lo tomaba como "sesión vencida" y devolvía al login apenas se
 * entraba: la terminal instalada no podía pasar de la pantalla de ingreso.
 * Pasaba desde la 1.5.0 (novedades/guía) en cualquier terminal de red local.
 *
 * Regla: en modo client se atienden sin sesión local (la sesión vive en el
 * servidor y estos datos son sólo de la PC); en 1 PC y en el servidor siguen
 * exigiendo sesión como siempre. Estos canales no viajan por la red (no están
 * en LAN_ROUTED_GROUPS), así que nadie de afuera llega a ellos.
 */
import { LanManager } from '../lan/LanManager';
import { type HandlerDeps, type HandlerFn, unguarded, withSession } from './handler-context';

/** ¿Esta PC es una terminal (su sesión vive en el servidor)? */
export function esTerminal(deps: Pick<HandlerDeps, 'userDataDir'>): boolean {
  try {
    return new LanManager(deps.userDataDir).getConfig().mode === 'client';
  } catch {
    return false;
  }
}

/**
 * Como `withSession`, salvo en una terminal, donde corre sin sesión local.
 * La función no recibe contexto de servicio: sólo puede tocar el userData.
 */
export function deSesionOPuesto<P, R>(deps: HandlerDeps, fn: (payload: P) => Promise<R> | R): HandlerFn {
  const conSesion = withSession<P, R>(deps, (payload) => fn(payload));
  const sinSesion = unguarded<P, R>(deps, (payload) => fn(payload));
  return (payload, event) => (esTerminal(deps) ? sinSesion(payload, event) : conSesion(payload, event));
}
