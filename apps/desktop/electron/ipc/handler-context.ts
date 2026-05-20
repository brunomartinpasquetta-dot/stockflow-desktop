/**
 * Infraestructura común de los handlers IPC: dependencias inyectadas, tipo de
 * handler y middlewares `withSession` / `unguarded`.
 */
import type { MpTokenStoreLike, ServiceContext } from '@stockflow/core';
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
  /** Token store seguro para credenciales MercadoPago. */
  mpTokenStore?: MpTokenStoreLike;
  /** Extras LAN (server-side): inyectados por main.ts cuando hay LanServer. */
  lanExtras?: {
    getConnectedClients?: () => { ip: string; lastSeen: number }[];
    applyAndRestart?: () => void;
  };
  /**
   * Gestor de ventanas nativas del SO (v0.1.17). Inyectado por main.ts; ausente
   * en los tests de integración (que corren sin Electron).
   */
  desktopWindows?: DesktopWindowsLike;
}

/**
 * Contrato mínimo del gestor de ventanas nativas que usan los handlers IPC.
 * Replica la superficie pública de `DesktopWindowsManager` (electron/desktop-windows.ts)
 * sin acoplar este módulo a Electron.
 */
export interface DesktopWindowsLike {
  open(input: {
    pageKey: string;
    title?: string;
    params?: Record<string, unknown>;
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
  }): { windowKey: string; created: boolean };
  close(windowKey: string): boolean;
  focus(windowKey: string): boolean;
  list(): { windowKey: string; title: string; minimized: boolean; focused: boolean }[];
  focusMain(): void;
  /** Cierra la ventana nativa que originó el evento IPC. */
  closeForWebContents(webContentsId: number): boolean;
  /** Minimiza la ventana nativa que originó el evento IPC. */
  minimizeForWebContents(webContentsId: number): boolean;
}

/**
 * Contexto opcional del evento IPC. Los handlers "self" (cerrar/minimizar la
 * propia ventana) lo necesitan para identificar el `webContents` emisor.
 */
export interface HandlerEventContext {
  webContentsId: number;
}

export type HandlerFn = (
  payload: unknown,
  event?: HandlerEventContext,
) => Promise<IpcResponse<unknown>>;
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

/**
 * Handler sin sesión (login, system, ...): la función recibe los `deps` crudos.
 * El tercer argumento `event` (contexto del evento IPC) está disponible en el
 * runtime real de Electron; es `undefined` en los tests de integración.
 */
export function unguarded<P, R>(
  deps: HandlerDeps,
  fn: (payload: P, deps: HandlerDeps, event?: HandlerEventContext) => Promise<R> | R,
): HandlerFn {
  return async (payload, event): Promise<IpcResponse<unknown>> => {
    try {
      const data = await fn(payload as P, deps, event);
      return { ok: true, data };
    } catch (err) {
      return serializeError(err);
    }
  };
}
