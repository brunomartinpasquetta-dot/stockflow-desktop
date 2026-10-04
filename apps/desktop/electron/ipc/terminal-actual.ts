/**
 * ¿DESDE QUÉ PC LLEGÓ ESTE PEDIDO?
 *
 * Hasta acá los handlers sólo conocían `deps.machineId`, que es la PC donde
 * corre el proceso: en un pedido que llega por la red (una terminal) o por el
 * túnel (una sucursal) es el ID del SERVIDOR. Por eso todas las terminales
 * abrían "la caja del servidor" y terminaban compartiéndola (Leo Citzia, 3 PC).
 *
 * Ahora la terminal manda su identidad en cada pedido (`x-stockflow-terminal`
 * = su machineId, `x-stockflow-terminal-nombre` = su hostname) y LanServer
 * corre el handler dentro de un contexto `AsyncLocalStorage` con esos datos.
 * Cualquier handler puede preguntar:
 *
 *     const t = obtenerTerminalActual(deps);
 *     // t.id → la PC que hizo el pedido (o la propia si es IPC local)
 *
 * Mismo mecanismo que `SessionStore.runWith`: cada RPC tiene su contexto, los
 * pedidos concurrentes no se pisan y el IPC local (fuera de todo contexto) cae
 * en la PC propia.
 *
 * Confianza: el encabezado lo declara la terminal.
 *  - En la red local eso es lo mismo que hoy (el PIN es compartido).
 *  - Con una PC de sucursal EMPAREJADA, el servidor ignora el encabezado y usa
 *    `disp:<machineId registrado al emparejar>`. El prefijo lo pone sólo el
 *    servidor (`limpiarIdTerminal` rechaza ids que lo traigan), así que una
 *    terminal de la red no puede declararse PC de sucursal ni viceversa, y el
 *    canje no deja reemplazar una PC activa (ver dispositivos.ts).
 *  - Por el TÚNEL sin PC emparejada (dueño desde su casa, o una contraseña
 *    robada) el encabezado se IGNORA: el pedido opera como la PC servidor,
 *    igual que antes de la caja por PC. Si no, cualquiera con una contraseña
 *    podría declarar el id de una caja ajena y cargarle movimientos.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';

export type OrigenTerminal = 'local' | 'lan' | 'tunel';

export interface TerminalActual {
  /**
   * ID estable de la PC que hizo el pedido: su machineId (64 hex) o, desde el
   * navegador, un id propio de ese navegador. Si la terminal no se identificó
   * (versión vieja), es `deps.machineId`, igual que antes: `identificada`
   * queda en false para que quien lo use pueda decidir.
   */
  id: string;
  /** Nombre para mostrar (hostname de la PC, o la IP si no se identificó). */
  nombre: string;
  /** Por dónde entró: IPC de esta PC, red local o túnel (internet). */
  origen: OrigenTerminal;
  /** PC de sucursal emparejada (fila de `dispositivos_sucursal`), o null. */
  dispositivoId: string | null;
  /** false = pedido remoto sin encabezado de terminal (versión vieja). */
  identificada: boolean;
}

const als = new AsyncLocalStorage<TerminalActual>();

/**
 * Corre `fn` como si la hubiera pedido `terminal`. Lo usa LanServer alrededor
 * de cada handler; no hace falta llamarlo desde otro lado.
 */
export function correrComoTerminal<T>(terminal: TerminalActual, fn: () => Promise<T>): Promise<T> {
  return als.run(terminal, fn);
}

let nombreLocal: string | null = null;
function hostnameLocal(): string {
  if (nombreLocal === null) {
    try {
      nombreLocal = os.hostname() || 'Esta PC';
    } catch {
      nombreLocal = 'Esta PC';
    }
  }
  return nombreLocal;
}

/**
 * La terminal que hizo el pedido en curso. Fuera de un pedido de red (IPC de
 * la propia PC, tareas programadas) devuelve esta PC con `origen: 'local'`.
 */
export function obtenerTerminalActual(deps: { machineId: string }): TerminalActual {
  const t = als.getStore();
  if (t) return t;
  return { id: deps.machineId, nombre: hostnameLocal(), origen: 'local', dispositivoId: null, identificada: true };
}

/**
 * Prefijo de la identidad de una PC de sucursal emparejada (`disp:<machineId>`).
 * Lo pone SÓLO el servidor, a partir de la fila del emparejamiento: así una
 * terminal de la red local no puede declarar el id de una PC de sucursal (ni
 * al revés) y quedarse con su caja.
 */
export const PREFIJO_TERMINAL_DISPOSITIVO = 'disp:';

/** Identidad de caja de una PC de sucursal emparejada. */
export function idTerminalDeDispositivo(machineId: string): string {
  return `${PREFIJO_TERMINAL_DISPOSITIVO}${machineId}`;
}

/**
 * Valida el ID que manda la terminal: hex/uuid, acotado. null si no sirve.
 * Un id con el prefijo de PC de sucursal se rechaza: ese lo asigna el servidor.
 */
export function limpiarIdTerminal(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.toLowerCase().startsWith(PREFIJO_TERMINAL_DISPOSITIVO)) return null;
  return /^[A-Za-z0-9._:-]{8,128}$/.test(v) ? v : null;
}

/** Nombre que manda la terminal (viene con encodeURIComponent). */
export function limpiarNombreTerminal(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  let s: string;
  try {
    s = decodeURIComponent(v);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return s || null;
}
