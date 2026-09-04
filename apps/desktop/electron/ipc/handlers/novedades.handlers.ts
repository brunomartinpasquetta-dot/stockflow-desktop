/**
 * NOVEDADES POST-ACTUALIZACIÓN — canales IPC.
 *
 * `novedades:pendientes` decide si corresponde mostrar la ventana tras el
 * login; `novedades:vistas` persiste el "ya la vi" (por máquina).
 */
import { app } from 'electron';
import Database from 'better-sqlite3';

import { computarPendientes, leerNotas, marcarVista, versionVista, type NovedadesPendientes } from '../../novedades/novedades';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';

function hayEmpresa(dbPath: string): boolean {
  // Si la base local no se puede consultar (p.ej. un puesto en red), se asume
  // instalación en uso: mejor mostrar novedades de más que ocultarlas.
  try {
    const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return (raw.prepare('SELECT COUNT(*) n FROM companies').get() as { n: number }).n > 0;
    } finally {
      raw.close();
    }
  } catch {
    return true;
  }
}

export function buildNovedadesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'novedades:pendientes': withSession(deps, async (): Promise<NovedadesPendientes> => {
      const actual = app.getVersion();
      // Instalación virgen (sin empresa): no tiene sentido contarle "qué
      // cambió" a quien recién llega — se marca visto en silencio para que
      // tampoco vea novedades viejas cuando termine de configurar.
      if (!hayEmpresa(deps.dbPath)) {
        marcarVista(deps.userDataDir, actual);
        return { hidden: true, versionActual: actual, items: [], internas: false };
      }
      return computarPendientes(actual, versionVista(deps.userDataDir), leerNotas());
    }),

    'novedades:vistas': withSession(deps, async (): Promise<{ ok: true }> => {
      marcarVista(deps.userDataDir, app.getVersion());
      return { ok: true };
    }),
  };
}
