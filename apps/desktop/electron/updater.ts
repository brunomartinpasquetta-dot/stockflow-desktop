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
  /**
   * Canal de actualizaciones:
   *  - 'stable' (default): solo releases finales. Es lo que reciben los clientes.
   *  - 'beta': además acepta prereleases (vX.Y.Z-beta.N) para las PCs de prueba.
   * Así se puede publicar y probar sin que le llegue a un cliente en producción.
   */
  channel: 'stable' | 'beta';
}

const FILE_NAME = 'updater.json';
// Cada media hora, no cada 4 horas. El comercio abre el sistema a la mañana y
// lo deja abierto todo el día: con 4 horas, un arreglo publicado al mediodía no
// le llegaba hasta la tarde, y si cerraba antes no le llegaba nunca. Es un
// pedido HTTP diminuto contra GitHub; el costo es cero al lado de tener al
// cliente esperando un fix. (Leo Citzia, 12-ago-2026)
const MEDIA_HORA_MS = 30 * 60 * 1000;
const FIVE_SECONDS_MS = 5_000;

function readPrefs(userDataDir: string): UpdaterPrefs {
  const fp = path.join(userDataDir, FILE_NAME);
  if (!existsSync(fp)) return { autoCheck: true, channel: 'stable' };
  try {
    const raw = readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdaterPrefs>;
    return {
      autoCheck: parsed.autoCheck !== false,
      channel: parsed.channel === 'beta' ? 'beta' : 'stable',
    };
  } catch {
    return { autoCheck: true, channel: 'stable' };
  }
}

function writePrefs(userDataDir: string, prefs: UpdaterPrefs): void {
  const fp = path.join(userDataDir, FILE_NAME);
  writeFileSync(fp, JSON.stringify(prefs, null, 2), 'utf8');
}

const GITHUB_LATEST_URL =
  'https://api.github.com/repos/brunomartinpasquetta-dot/stockflow-desktop/releases/latest';
/** Lista completa (incluye prereleases). Solo se consulta en canal 'beta'. */
const GITHUB_RELEASES_URL =
  'https://api.github.com/repos/brunomartinpasquetta-dot/stockflow-desktop/releases?per_page=10';

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface RemoteRelease {
  latestVersion: string;
  downloadUrl: string;
}

/**
 * Compara versiones SemVer (X.Y.Z y X.Y.Z-beta.N). Devuelve positivo si a > b.
 * Regla SemVer: una prerelease es MENOR que su versión final
 * (0.3.0-beta.2 < 0.3.0), y entre betas manda el número (beta.2 > beta.1).
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-');
    return {
      nums: (core ?? '').split('.').map((n) => Number(n) || 0),
      // sin sufijo → release final; con sufijo → número de beta
      preNum: pre === undefined ? null : Number(pre.replace(/[^0-9]/g, '')) || 0,
    };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.preNum === null && pb.preNum === null) return 0;
  if (pa.preNum === null) return 1; // final > beta
  if (pb.preNum === null) return -1; // beta < final
  return pa.preNum - pb.preNum;
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
export async function checkRemoteVersion(
  channel: 'stable' | 'beta' = 'stable',
): Promise<RemoteRelease | null> {
  try {
    // 'stable' usa /releases/latest, que GitHub ya define como el último release
    // NO-prerelease → un cliente en producción nunca ve una beta.
    // 'beta' lista los últimos releases y toma el más nuevo, sea final o beta.
    const url = channel === 'beta' ? GITHUB_RELEASES_URL : GITHUB_LATEST_URL;
    const res = await fetch(url, {
      headers: { 'user-agent': 'stockflow-desktop-updater' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const data = (Array.isArray(body)
      ? (body as { draft?: boolean; tag_name?: string }[]).find((r) => !r.draft)
      : body) as {
      tag_name?: string;
      html_url?: string;
      assets?: GithubAsset[];
    } | undefined;
    const tag = data?.tag_name?.replace(/^v/, '');
    if (!tag || !data) return null;
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
  channel?: 'stable' | 'beta';
}): Promise<{ outdated: boolean; latestVersion: string | null }> {
  if (!opts.isPackaged) return { outdated: false, latestVersion: null };
  const remote = await checkRemoteVersion(opts.channel ?? 'stable');
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
  /** Actualización ya descargada esperando instalarse (el evento pudo perderse). */
  getPending?: () => { version: string } | null;
  quitAndInstall: () => void;
  getAutoCheck: () => boolean;
  setAutoCheck: (v: boolean) => void;
  getChannel: () => 'stable' | 'beta';
  setChannel: (c: 'stable' | 'beta') => void;
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

  // Chequeo manual contra GitHub Releases. Funciona SIEMPRE: NO depende de
  // electron-updater (que está en devDependencies y NO se empaqueta → en prod el
  // require falla). Es lo mismo que dispara el banner "nueva versión disponible"
  // al arrancar; el botón "Verificar" lo usa para hacer lo mismo on-demand.
  async function manualCheck(): Promise<{ status: string; version?: string }> {
    try {
      const r = await checkForOutdatedVersion({
        appVersion: ctx.appVersion,
        isPackaged: ctx.isPackaged,
        onOutdated: (info) => ctx.getWindow()?.webContents.send('updater:outdated', info),
        channel: prefs.channel,
      });
      return r.outdated
        ? { status: 'outdated', version: r.latestVersion ?? undefined }
        : { status: 'latest', version: r.latestVersion ?? undefined };
    } catch (err) {
      console.warn('[updater] chequeo manual falló:', err instanceof Error ? err.message : err);
      return { status: 'error' };
    }
  }

  if (!ctx.isPackaged || ctx.isDev) {
    return {
      checkNow: async () => ({ status: 'disabled-in-dev' }),
      quitAndInstall: () => { /* no-op */ },
      getAutoCheck: () => prefs.autoCheck,
      setAutoCheck: (v: boolean) => {
        prefs = { ...prefs, autoCheck: v };
        writePrefs(ctx.userDataDir, prefs);
      },
      // El canal se persiste también en dev: así se puede dejar una PC de prueba
      // marcada como 'beta' antes de instalarle una versión empaquetada.
      getChannel: () => prefs.channel,
      setChannel: (c: 'stable' | 'beta') => {
        prefs = { ...prefs, channel: c };
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
    // electron-updater no empaquetado (caso real en prod): igual ofrecemos el
    // chequeo manual → el botón "Verificar" muestra el banner si hay versión nueva.
    return {
      checkNow: manualCheck,
      quitAndInstall: () => { /* no-op */ },
      getAutoCheck: () => prefs.autoCheck,
      setAutoCheck: (v) => {
        prefs = { ...prefs, autoCheck: v };
        writePrefs(ctx.userDataDir, prefs);
      },
      getChannel: () => prefs.channel,
      setChannel: (c) => {
        prefs = { ...prefs, channel: c };
        writePrefs(ctx.userDataDir, prefs);
      },
    };
  }

  // En macOS sin firma/notarización, Squirrel.Mac NO puede reemplazar el .app:
  // `quitAndInstall` falla y el banner "Reiniciar e instalar" no hace nada. Por eso
  // en mac NO auto-descargamos (no se dispara `updater:downloaded`) y dejamos sólo
  // el aviso manual (`updater:outdated` → banner "Bajar instalador" → .dmg, que sí
  // funciona). En Windows el auto-update de un clic queda intacto.
  const isMac = process.platform === 'darwin';
  autoUpdater.autoDownload = !isMac;
  autoUpdater.autoInstallOnAppQuit = false;
  // Solo el canal 'beta' baja prereleases; en 'stable' electron-updater las ignora.
  autoUpdater.allowPrerelease = prefs.channel === 'beta';

  autoUpdater.on('update-available', (info: { version: string }) => {
    ctx.getWindow()?.webContents.send('updater:available', { version: info.version });
  });
  // Se RECUERDA la última descarga lista: el evento puede llegar antes de que
  // la pantalla esté montada (o perderse si se recarga la ventana), y entonces
  // el aviso no aparecía nunca hasta el chequeo siguiente — 4 horas después.
  // Con esto la UI puede preguntar "¿hay algo listo?" al abrir.
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    descargada = { version: info.version };
    ctx.getWindow()?.webContents.send('updater:downloaded', { version: info.version });
  });
  autoUpdater.on('error', (err: Error) => {
    console.warn('[updater] error silencioso:', err?.message ?? err);
  });

  let descargada: { version: string } | null = null;

  function checkInternal(): void {
    if (isMac) return; // en mac sólo vale el chequeo manual (updater:outdated)
    if (!prefs.autoCheck) return;
    autoUpdater.checkForUpdates().catch((err: Error) => {
      console.warn('[updater] checkForUpdates falló:', err?.message ?? err);
    });
  }

  const startupCheck = setTimeout(checkInternal, FIVE_SECONDS_MS);
  const periodicCheck = setInterval(checkInternal, MEDIA_HORA_MS);
  // El chequeo contra la API de GitHub también se repite. Antes sólo corría al
  // arrancar (main.ts) y con el botón "Verificar": si la descarga automática
  // fallaba, el usuario no se enteraba NUNCA de que había versión nueva, que es
  // exactamente lo que pasó con la descarga diferencial rota.
  const periodicManual = setInterval(() => {
    if (!prefs.autoCheck) return;
    void manualCheck();
  }, MEDIA_HORA_MS);

  return {
    checkNow: async () => {
      // Chequeo manual (banner "nueva versión disponible", igual que al arrancar).
      const r = await manualCheck();
      // electron-updater (auto-descarga del .exe en Windows), best-effort. En mac
      // no corre: Squirrel.Mac no puede aplicar el update sin firma.
      if (!isMac) {
        autoUpdater.checkForUpdates().catch((err: Error) => {
          console.warn('[updater] checkForUpdates falló:', err?.message ?? err);
        });
      }
      return r;
    },
    getPending: () => descargada,
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    getAutoCheck: () => prefs.autoCheck,
    setAutoCheck: (v: boolean) => {
      prefs = { ...prefs, autoCheck: v };
      writePrefs(ctx.userDataDir, prefs);
    },
    getChannel: () => prefs.channel,
    setChannel: (c: 'stable' | 'beta') => {
      prefs = { ...prefs, channel: c };
      writePrefs(ctx.userDataDir, prefs);
      autoUpdater.allowPrerelease = c === 'beta';
    },
    dispose: () => {
      clearTimeout(startupCheck);
      clearInterval(periodicCheck);
      clearInterval(periodicManual);
    },
  };
}
