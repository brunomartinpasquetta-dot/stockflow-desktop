/**
 * Wrapper sobre `electron-updater`. Activa SÓLO en producción
 * (`app.isPackaged && NODE_ENV !== 'development'`); en dev no hace nada.
 *
 * - Chequea actualizaciones 5 segundos después de iniciar y cada 4 horas.
 * - Emite eventos `updater:available` y `updater:downloaded` al renderer
 *   para mostrar un dialog/toast.
 * - Persiste el toggle "verificar automáticamente" en `{userData}/updater.json`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BrowserWindow } from 'electron';

interface UpdaterPrefs {
  autoCheck: boolean;
}

const FILE_NAME = 'updater.json';
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const FIVE_SECONDS_MS = 5_000;

function readPrefs(userDataDir: string): UpdaterPrefs {
  const fp = path.join(userDataDir, FILE_NAME);
  if (!existsSync(fp)) return { autoCheck: true };
  try {
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdaterPrefs>;
    return { autoCheck: parsed.autoCheck !== false };
  } catch {
    return { autoCheck: true };
  }
}

function writePrefs(userDataDir: string, prefs: UpdaterPrefs): void {
  const fp = path.join(userDataDir, FILE_NAME);
  writeFileSync(fp, JSON.stringify(prefs, null, 2), 'utf8');
}

export interface UpdaterController {
  checkNow: () => Promise<{ status: string; version?: string }>;
  quitAndInstall: () => void;
  getAutoCheck: () => boolean;
  setAutoCheck: (v: boolean) => void;
}

export interface UpdaterContext {
  userDataDir: string;
  getWindow: () => BrowserWindow | null;
  isPackaged: boolean;
  isDev: boolean;
}

/**
 * Inicializa el auto-updater. En entornos no-empaquetados o desarrollo devuelve
 * un controller no-op que persiste el toggle pero nunca contacta GitHub.
 */
export function setupAutoUpdater(ctx: UpdaterContext): UpdaterController {
  let prefs = readPrefs(ctx.userDataDir);

  if (!ctx.isPackaged || ctx.isDev) {
    return {
      checkNow: async () => ({ status: 'disabled-in-dev' }),
      quitAndInstall: () => { /* no-op */ },
      getAutoCheck: () => prefs.autoCheck,
      setAutoCheck: (v: boolean) => {
        prefs = { autoCheck: v };
        writePrefs(ctx.userDataDir, prefs);
      },
    };
  }

  // Carga perezosa: si electron-updater no está presente (build sin firmar / dev),
  // exponemos un controller no-op igualmente.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let autoUpdater: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    autoUpdater = require('electron-updater').autoUpdater;
  } catch {
    return {
      checkNow: async () => ({ status: 'updater-unavailable' }),
      quitAndInstall: () => { /* no-op */ },
      getAutoCheck: () => prefs.autoCheck,
      setAutoCheck: (v) => {
        prefs = { autoCheck: v };
        writePrefs(ctx.userDataDir, prefs);
      },
    };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('update-available', (info: { version: string }) => {
    ctx.getWindow()?.webContents.send('updater:available', { version: info.version });
  });
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    ctx.getWindow()?.webContents.send('updater:downloaded', { version: info.version });
  });
  autoUpdater.on('error', (err: Error) => {
    console.warn('[updater] error silencioso:', err?.message ?? err);
  });

  function checkInternal(): void {
    if (!prefs.autoCheck) return;
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.warn('[updater] checkForUpdates falló:', err?.message ?? err);
    });
  }

  setTimeout(checkInternal, FIVE_SECONDS_MS);
  setInterval(checkInternal, FOUR_HOURS_MS);

  return {
    checkNow: async () => {
      try {
        const r = await autoUpdater.checkForUpdates();
        return { status: 'checking', version: r?.updateInfo?.version };
      } catch (err) {
        return { status: 'error', version: err instanceof Error ? err.message : undefined };
      }
    },
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    getAutoCheck: () => prefs.autoCheck,
    setAutoCheck: (v: boolean) => {
      prefs = { autoCheck: v };
      writePrefs(ctx.userDataDir, prefs);
    },
  };
}
