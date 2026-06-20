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
 * Elige el asset de descarga correcto según el SO/arch del PROCESO actual:
 *  - Windows → instalador NSIS `.exe` (excluye `.exe.blockmap`).
 *  - macOS   → `.dmg` de la arquitectura (arm64 / x64).
 *  - Linux   → `.AppImage`.
 * Devuelve undefined si no hay asset para esta plataforma → el caller cae a la
 * página del release. (Bug viejo: siempre servía `.dmg`, incluso en Windows.)
 */
function pickAssetForPlatform(assets: GithubAsset[]): GithubAsset | undefined {
  const arch = process.arch; // 'arm64' | 'x64'
  if (process.platform === 'win32') {
    return assets.find((a) => a.name.toLowerCase().endsWith('.exe'));
  }
  if (process.platform === 'darwin') {
    return (
      assets.find((a) => a.name.endsWith(`-${arch}.dmg`)) ??
      (arch === 'x64'
        ? assets.find((a) => a.name.endsWith('.dmg') && !a.name.includes('arm64'))
        : undefined) ??
      assets.find((a) => a.name.endsWith('.dmg'))
    );
  }
  return assets.find((a) => a.name.toLowerCase().endsWith('.appimage'));
}

/**
 * Consulta GitHub Releases por la última versión publicada. Devuelve `null`
 * si la red falla o la respuesta no tiene `tag_name`. Elige el asset acorde al
 * SO/arch del proceso (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`).
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
    const assets = data.assets ?? [];
    const asset = pickAssetForPlatform(assets);
    // Si no hay asset para este SO, mandamos a la página del release — NUNCA a
    // un instalador de otra plataforma (antes Windows recibía el .dmg).
    const downloadUrl = asset?.browser_download_url ?? data.html_url ?? '';
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
}): Promise<{ outdated: boolean; latestVersion: string | null }> {
  if (!opts.isPackaged) return { outdated: false, latestVersion: null };
  const remote = await checkRemoteVersion();
  if (!remote) return { outdated: false, latestVersion: null };
  if (compareVersions(remote.latestVersion, opts.appVersion) > 0) {
    opts.onOutdated({
      currentVersion: opts.appVersion,
      latestVersion: remote.latestVersion,
      downloadUrl: remote.downloadUrl,
    });
    return { outdated: true, latestVersion: remote.latestVersion };
  }
  return { outdated: false, latestVersion: remote.latestVersion };
}

export interface UpdaterController {
  checkNow: () => Promise<{ status: string; version?: string }>;
  quitAndInstall: () => void;
  getAutoCheck: () => boolean;
  setAutoCheck: (v: boolean) => void;
  /** Limpia los timers del updater (chequeo periódico) para un cierre limpio. */
  dispose?: () => void;
}

export interface UpdaterContext {
  userDataDir: string;
  getWindow: () => BrowserWindow | null;
  isPackaged: boolean;
  isDev: boolean;
  /** Versión instalada, para el chequeo manual de "nueva versión disponible". */
  appVersion: string;
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

  const startupCheck = setTimeout(checkInternal, FIVE_SECONDS_MS);
  const periodicCheck = setInterval(checkInternal, FOUR_HOURS_MS);

  return {
    checkNow: async () => {
      // 1) Chequeo manual contra GitHub Releases (igual que al arrancar): si hay
      //    una versión más nueva, emite `updater:outdated` → aparece el banner
      //    "nueva versión disponible" en la ventana principal. Este es el camino
      //    que el botón "Verificar" debe disparar (autoUpdater por sí solo no lo hace).
      let manual: { outdated: boolean; latestVersion: string | null } = {
        outdated: false,
        latestVersion: null,
      };
      try {
        manual = await checkForOutdatedVersion({
          appVersion: ctx.appVersion,
          isPackaged: ctx.isPackaged,
          onOutdated: (info) => ctx.getWindow()?.webContents.send('updater:outdated', info),
        });
      } catch (err) {
        console.warn('[updater] chequeo manual falló:', err instanceof Error ? err.message : err);
      }
      // 2) electron-updater (auto-descarga del .exe en Windows), best-effort.
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.warn('[updater] checkForUpdates falló:', err?.message ?? err);
      });
      if (manual.outdated) return { status: 'outdated', version: manual.latestVersion ?? undefined };
      return { status: 'latest', version: manual.latestVersion ?? undefined };
    },
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    getAutoCheck: () => prefs.autoCheck,
    setAutoCheck: (v: boolean) => {
      prefs = { autoCheck: v };
      writePrefs(ctx.userDataDir, prefs);
    },
    dispose: () => {
      clearTimeout(startupCheck);
      clearInterval(periodicCheck);
    },
  };
}
