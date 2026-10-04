/**
 * Infraestructura común de los handlers IPC: dependencias inyectadas, tipo de
 * handler y middlewares `withSession` / `unguarded`.
 */
import type { MpTokenStoreLike, ServiceContext } from '@stockflow/core';
import type { LocalDatabase, Repositories } from '@stockflow/db';

import type { FlowyIA } from '../assistant/ia/flowyIA';
import type { InstaladorOllama } from '../assistant/ia/instalador';
import type { FacturasTelefono } from '../facturas/servicio';
import type { BackupService } from '../backup/BackupService';
import type { HardwareManager } from '../hardware/HardwareManager';
import type { ExcelImportService } from '../import/ExcelImportService';
import type { LicenseManager } from '../license/LicenseManager';
import { serializeError, unauthenticated } from './errors';
import type { SessionStore } from './session-store';
import { terminalDelContexto } from './caja-por-pc';
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
  /** Trae al frente la ventana principal (para abrir el chat de WhatsApp ahí). */
  focusMainWindow?: () => void;
  /** Solicitar al main process verificar actualizaciones (opcional). */
  updater?: {
    checkNow: () => Promise<{ status: string; version?: string }>;
    quitAndInstall: () => void;
    /** Actualización ya descargada y esperando instalarse, si la hay. */
    getPending?: () => { version: string } | null;
    getAutoCheck: () => boolean;
    setAutoCheck: (v: boolean) => void;
    getChannel?: () => 'stable' | 'beta';
    setChannel?: (c: 'stable' | 'beta') => void;
  };
  /**
   * Suelta todo lo que tiene archivos/puertos abiertos ANTES de que el
   * instalador reemplace el programa. Sin esto el instalador escribe sobre
   * archivos en uso y la actualización queda a medias.
   */
  prepareForUpdate?: () => Promise<void>;
  /** Token store seguro para credenciales MercadoPago. */
  mpTokenStore?: MpTokenStoreLike;
  /**
   * IA local de Flowy (Ollama). Ausente en los tests que no la usan: Flowy
   * responde con su motor de siempre.
   */
  flowyIA?: FlowyIA;
  /** Descarga y abre el instalador de Ollama (sólo en la PC que responde a Flowy). */
  ollamaInstalador?: Pick<InstaladorOllama, 'estado' | 'iniciar'>;
  /**
   * Facturas de compra por teléfono. Ausente en una terminal de la red (lo
   * atiende el servidor) y en los tests que no lo usan.
   */
  facturas?: FacturasTelefono;
  /** Extras LAN (server-side): inyectados por main.ts cuando hay LanServer. */
  lanExtras?: {
    getConnectedClients?: () => { ip: string; lastSeen: number }[];
    applyAndRestart?: () => void;
    /**
     * Acceso remoto (túnel). Ausente si esta PC no lo tiene disponible (por
     * ejemplo, una terminal en modo cliente): los handlers responden que está
     * apagado en vez de romper.
     */
    tunel?: TunelLike;
  };
  /**
   * Gestor de ventanas nativas del SO (v0.1.17). Inyectado por main.ts; ausente
   * en los tests de integración (que corren sin Electron).
   */
  desktopWindows?: DesktopWindowsLike;
}

/** Contrato mínimo del gestor del túnel de acceso remoto. */
export interface TunelLike {
  estado(): { estado: string; direccion: string | null; ultimoError: string | null; desde: number };
  estaAprovisionado(): boolean;
  tieneBinario(): boolean;
  asegurarBinario(): Promise<void>;
  iniciar(): { estado: string; direccion: string | null; ultimoError: string | null; desde: number };
  detener(): { estado: string; direccion: string | null; ultimoError: string | null; desde: number };
  aprovisionar(credencialJson: string, hostname: string, tunnelId: string): void;
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
    /** La página recibe los `extras` con la ventana abierta, sin recargarla. */
    extrasEnVivo?: boolean;
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
  }): { windowKey: string; created: boolean };
  close(windowKey: string): boolean;
  focus(windowKey: string): boolean;
  list(): { windowKey: string; title: string; minimized: boolean; focused: boolean }[];
  focusMain(): void;
  /** Abre (o enfoca) la ventana del manual de usuario (visor PDF nativo). */
  openManual(): { created: boolean };
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
    // La PC que hizo el pedido, SÓLO si rige la caja por PC (opción del
    // comercio o edición Multisucursal). Apagada: null = la caja abierta del
    // local, exactamente como en la 1.12 (ver caja-por-pc.ts).
    terminalId: terminalDelContexto(deps),
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
