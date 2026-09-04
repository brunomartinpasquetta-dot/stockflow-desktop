/**
 * GUÍA DE PRIMEROS PASOS — canales IPC del asistente inicial.
 *
 * Estado one-shot POR MÁQUINA en {userData}/guia-inicial.json (mismo patrón
 * que onboarding.json y novedades.json): la guía se auto-muestra una sola vez
 * —en el primer inicio de sesión de una licencia de prueba— y después solo se
 * abre a mano desde Ayuda → "Guía de primeros pasos".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';

const STATE_FILE = 'guia-inicial.json';

export interface GuiaEstado {
  /** true → ya se mostró (completada o salteada): no volver a auto-mostrar. */
  vista: boolean;
  /** Último paso alcanzado, para retomar si quedó a la mitad. */
  paso: number;
}

function leer(userDataDir: string): GuiaEstado {
  try {
    const raw = JSON.parse(readFileSync(join(userDataDir, STATE_FILE), 'utf8')) as Partial<GuiaEstado>;
    return { vista: raw.vista === true, paso: typeof raw.paso === 'number' ? raw.paso : 0 };
  } catch {
    return { vista: false, paso: 0 };
  }
}

export function buildGuiaHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'guia:estado': withSession(deps, async (): Promise<GuiaEstado> => leer(deps.userDataDir)),

    'guia:progreso': withSession(deps, async (payload: { paso: number }): Promise<{ ok: true }> => {
      const st = leer(deps.userDataDir);
      writeFileSync(join(deps.userDataDir, STATE_FILE), JSON.stringify({ ...st, paso: payload.paso }));
      return { ok: true };
    }),

    'guia:vista': withSession(deps, async (): Promise<{ ok: true }> => {
      writeFileSync(join(deps.userDataDir, STATE_FILE), JSON.stringify({ vista: true, paso: 0 }));
      return { ok: true };
    }),
  };
}
