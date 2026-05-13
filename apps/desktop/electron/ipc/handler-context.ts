/**
 * Infraestructura común de los handlers IPC: dependencias inyectadas, tipo de
 * handler y middlewares `withSession` / `unguarded`.
 */
import type { ServiceContext } from '@stockflow/core';
import type { LocalDatabase, Repositories } from '@stockflow/db';

import type { BackupService } from '../backup/BackupService';
import type { HardwareManager } from '../hardware/HardwareManager';
import type { ExcelImportService } from '../import/ExcelImportService';
import type { LicenseManager } from '../license/LicenseManager';
import { serializeError, unauthenticated } from './errors';
import type { SessionStore } from './session-store';
import type { IpcResponse } from './types';

export interface HandlerDeps {
  db: LocalDatabase;
  repos: Repositories;
  sessionStore: SessionStore;
  machineId: string;
  appVersion: string;
  dbPath: string;
  /** Directorio de datos del usuario (para configs auxiliares como lan.json, updater.json). */
  userDataDir: string;
  licenseManager: LicenseManager;
  hardware: HardwareManager;
  backup: BackupService;
  importService: ExcelImportService;
  emit: (channel: string, payload: unknown) => void;
  /** Solicitar al main process verificar actualizaciones (opcional). */
  updater?: {
    checkNow: () => Promise<{ status: string; version?: string }>;
    quitAndInstall: () => void;
    getAutoCheck: () => boolean;
    setAutoCheck: (v: boolean) => void;
  };
  /** Extras LAN (server-side): inyectados por main.ts cuando hay LanServer. */
  lanExtras?: {
    getConnectedClients?: () => { ip: string; lastSeen: number }[];
    applyAndRestart?: () => void;
  };
}

export type HandlerFn = (payload: unknown) => Promise<IpcResponse<unknown>>;
export type HandlerMap = Record<string, HandlerFn>;
export type HandlerBuilder = (deps: HandlerDeps) => HandlerMap;

function buildContext(deps: HandlerDeps): ServiceContext | null {
  const session = deps.sessionStore.getSession();
  if (!session) return null;
  return {
    db: deps.db,
    repos: deps.repos,
    currentUser: session.user,
    currentCashRegister: deps.sessionStore.getCurrentCashRegister(),
  };
}

/** Handler que requiere sesión activa: la función recibe el `ServiceContext`. */
export function withSession<P, R>(
  deps: HandlerDeps,
  fn: (payload: P, ctx: ServiceContext) => Promise<R> | R,
): HandlerFn {
  return async (payload): Promise<IpcResponse<unknown>> => {
    try {
      const ctx = buildContext(deps);
      if (!ctx) return unauthenticated();
      const data = await fn(payload as P, ctx);
      return { ok: true, data };
    } catch (err) {
      return serializeError(err);
    }
  };
}

/** Handler sin sesión (login, system, ...): la función recibe los `deps` crudos. */
export function unguarded<P, R>(
  deps: HandlerDeps,
  fn: (payload: P, deps: HandlerDeps) => Promise<R> | R,
): HandlerFn {
  return async (payload): Promise<IpcResponse<unknown>> => {
    try {
      const data = await fn(payload as P, deps);
      return { ok: true, data };
    } catch (err) {
      return serializeError(err);
    }
  };
}
