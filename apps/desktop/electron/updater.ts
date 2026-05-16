/**
 * Wrapper sobre `electron-updater`. Activa SÓLO en producción
 * (`app.isPackaged && NODE_ENV !== 'development'`); en dev no hace nada.
 *
 * - Chequea actualizaciones 5 segundos después de iniciar y cada 4 horas.
 * - Emite eventos `updater:available` y `updater:downloaded` al renderer
 *   para mostrar un dialog/toast.
 * - Persiste el toggle "verificar automáticamente" en `{userData}/updater.json`.
 *
 * Detección manual (v0.1.13): en macOS sin firma, Squirrel.Mac no puede
 * reemplazar el `.app` y el auto-update falla silenciosamente. Para que el
 * usuario sepa que está atrasado, contrastamos la versión instalada contra
 * GitHub Releases al iniciar; si hay una más nueva, emitimos `updater:outdated`
 * con el link directo al `.dmg`.
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

const GITHUB_LATEST_URL =
  'https://api.github.com/repos/brunomartinpasquetta-dot/stockflow-desktop/releases/latest';

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface RemoteRelease {
  latestVersion: string;
  downloadUrl: string;
}

/** Compara dos versiones SemVer simples (X.Y.Z). Devuelve positivo si a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Consulta GitHub Releases por la última versión publicada. Devuelve `null`
 * si la red falla o la respuesta no tiene `tag_name`. Elige el asset `.dmg`
 * para la arquitectura del proceso actual cuando está disponible.
 */
export async function checkRemoteVersion(): Promise<RemoteRelease | null> {
  try {
    const res = await fetch(GITHUB_LATEST_URL, {
      headers: { 'user-agent': 'stockflow-desktop-updater' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tag_name?: string;
      html_url?: string;
      assets?: GithubAsset[];
    };
    const tag = data.tag_name?.replace(/^v/, '');
    if (!tag) return null;
    const arch = process.arch; // 'arm64' | 'x64'
    const assets = data.assets ?? [];
    const archAsset =
      assets.find((a) => a.name.endsWith(`-${arch}.dmg`)) ??
      (arch === 'x64'
        ? assets.find((a) => a.name.endsWith('.dmg') && !a.name.includes('arm64'))
        : undefined);
    const fallback = assets.find((a) => a.name.endsWith('.dmg'));
    const downloadUrl =
      archAsset?.browser_download_url ?? fallback?.browser_download_url ?? data.html_url ?? '';
    return { latestVersion: tag, downloadUrl };
  } catch {
    return null;
  }
}

export interface OutdatedInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
}

/**
 * Compara la versión instalada con la última publicada en GitHub Releases.
 * Si la remota es mayor, llama `onOutdated` (típicamente para emitir un evento
 * al renderer). No-op si la app no está empaquetada o si falla la red.
 */
export async function checkForOutdatedVersion(opts: {
  appVersion: string;
  isPackaged: boolean;
  onOutdated: (info: OutdatedInfo) => void;
}): Promise<void> {
  if (!opts.isPackaged) return;
  const remote = await checkRemoteVersion();
  if (!remote) return;
  if (compareVersions(remote.latestVersion, opts.appVersion) > 0) {
    opts.onOutdated({
      currentVersion: opts.appVersion,
      latestVersion: remote.latestVersion,
      downloadUrl: remote.downloadUrl,
    });
  }
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
