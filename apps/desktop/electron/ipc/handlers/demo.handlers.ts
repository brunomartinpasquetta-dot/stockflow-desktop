/**
 * MODO DEMO (E5) — canales para cargar y quitar los datos de ejemplo
 * "Ferretería del Litoral".
 *
 * Seguridad y reversibilidad:
 *  - Solo admin. Cargar exige base VIRGEN (jamás se siembra sobre datos
 *    reales); quitar exige la contraseña del admin (mismo criterio que
 *    "Reiniciar datos operativos").
 *  - Antes de sembrar: snapshot byte-exacto de la base (stockflow.db.pre-demo).
 *    "Quitar" restaura ese snapshot en el próximo arranque y conserva la base
 *    demo renombrada — nada se pierde de forma irreversible.
 *  - En red LAN el canal viaja al puesto servidor (la base real del negocio).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PermissionDeniedError, ValidationError } from '@stockflow/core';

import { isDbVirgin, readDemoState, requestDemoDiscard, snapshotBeforeDemo } from '../../demo/DemoManager';
import { seedDemoData } from '../../demo/seedDemoData';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Empaquetado: junto a main.mjs (lo copia build-electron); dev (tsx): en marketing/. */
function resolveXlsx(): string | null {
  const candidates = [
    join(HERE, 'demo-articulos.xlsx'),
    join(HERE, '..', '..', '..', '..', '..', 'marketing', 'demo-data', 'StockFlow-demo-articulos.xlsx'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export interface DemoStatus {
  active: boolean;
  loadedAt?: number;
  canLoad: boolean;
  reason?: string;
}

function soloAdmin(role: string | undefined, accion: string): void {
  if (role !== 'admin') throw new PermissionDeniedError(accion, 'Solo un administrador puede administrar los datos de ejemplo');
}

export function buildDemoHandlers(deps: HandlerDeps, allHandlers: HandlerMap): HandlerMap {
  return {
    'demo:status': withSession(deps, async (): Promise<DemoStatus> => {
      const st = readDemoState(deps.userDataDir);
      if (st.active) return { active: true, loadedAt: st.loadedAt, canLoad: false };
      let canLoad = false;
      let reason: string | undefined;
      if (!resolveXlsx()) reason = 'faltan los datos de ejemplo en esta instalación';
      else {
        try {
          canLoad = isDbVirgin(deps.dbPath);
          if (!canLoad) reason = 'la base ya tiene datos cargados — los datos de ejemplo solo se cargan con la base vacía';
        } catch {
          reason = 'no se pudo verificar el estado de la base';
        }
      }
      return { active: false, canLoad, reason };
    }),

    'demo:load': withSession(deps, async (_p, ctx): Promise<{ ok: true; ventas: number; compras: number }> => {
      soloAdmin(ctx.currentUser?.role, 'demo_load');
      const st = readDemoState(deps.userDataDir);
      if (st.active) throw new ValidationError('demo', 'Los datos de ejemplo ya están cargados');
      if (!isDbVirgin(deps.dbPath)) {
        throw new ValidationError(
          'demo',
          'La base ya tiene datos cargados. Los datos de ejemplo solo se cargan con la base vacía, para no mezclarse jamás con datos reales.',
        );
      }
      const xlsx = resolveXlsx();
      if (!xlsx) throw new ValidationError('demo', 'No se encontraron los datos de ejemplo en esta instalación');

      // Snapshot ANTES de tocar nada: la reversa es byte-exacta.
      snapshotBeforeDemo(deps.userDataDir, deps.dbPath);
      try {
        const r = await seedDemoData(allHandlers, { dbPath: deps.dbPath, xlsxPath: xlsx });
        if (r.fallas > 0) throw new Error(`la demo no pasó ${r.fallas} verificación(es)`);
        return { ok: true, ventas: r.ventas, compras: r.compras };
      } catch (e) {
        // Sembrado a medias: se marca el descarte — al reiniciar vuelve la base virgen.
        requestDemoDiscard(deps.userDataDir);
        throw new ValidationError(
          'demo',
          `La carga de ejemplo falló y se revierte sola al reiniciar StockFlow. Detalle: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }),

    'demo:remove': withSession(deps, async (payload: { password?: string }, ctx): Promise<{ ok: true; needsRestart: true }> => {
      soloAdmin(ctx.currentUser?.role, 'demo_remove');
      const okPass = await deps.repos.users.verifyPassword(ctx.currentUser.username, payload?.password ?? '');
      if (!okPass) throw new ValidationError('password', 'La contraseña no es correcta');
      const r = requestDemoDiscard(deps.userDataDir);
      if (!r.ok) throw new ValidationError('demo', `No se puede quitar la demo: ${r.motivo}`);
      return { ok: true, needsRestart: true };
    }),

    'demo:restart': withSession(deps, async (_p, ctx): Promise<{ ok: true }> => {
      soloAdmin(ctx.currentUser?.role, 'demo_restart');
      // Import dinámico: este módulo también corre bajo tsx (tests) sin Electron.
      const { app } = await import('electron');
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 300);
      return { ok: true };
    }),
  };
}
