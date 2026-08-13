import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BackupService } from './backup/BackupService';
import { DesktopWindowsManager } from './desktop-windows';
import { getDatabasePath, initialize, shutdown, type DbHandle } from './bootstrap/db';
import { getMachineId } from './bootstrap/machine';
import { applySessionSecret } from './bootstrap/session';
import { HardwareManager } from './hardware/HardwareManager';
import { ExcelImportService } from './import/ExcelImportService';
import { registerIpcHandlers, buildAllHandlers } from './ipc';
import { SessionStore } from './ipc/session-store';
import { LanManager } from './lan/LanManager';
import { LanServer } from './lan/LanServer';
import { DEFAULT_LAN_PORT } from './lan/types';
import { LicenseManager } from './license/LicenseManager';
import { CLOUD_API_URL_DEFAULT, CLOUD_PUBLIC_KEY_PEM } from './license/cloud-public-key';
import { setupLogger } from './logger';
import { MpTokenStore } from './secure/MpTokenStore';
import { MpQrService, createServiceContext } from '@stockflow/core';
import { checkForOutdatedVersion, setupAutoUpdater, type UpdaterController } from './updater';

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER_URL = 'http://localhost:5173';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let dbHandle: DbHandle | null = null;
let licenseManager: LicenseManager | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let mpCronTimer: NodeJS.Timeout | null = null;
let hardwareManager: HardwareManager | null = null;
let backupService: BackupService | null = null;
let lanServer: LanServer | null = null;
let updaterController: UpdaterController | null = null;
let desktopWindows: DesktopWindowsManager | null = null;
let quittingForBackup = false;
/**
 * true mientras se está instalando una actualización. El instalador reemplaza
 * los archivos del programa apenas la app cierra, así que el cierre tiene que
 * ser INMEDIATO: si se demora (backup pre-quit, servidor LAN sin cerrar), el
 * instalador escribe sobre archivos todavía en uso y falla con errores de
 * escritura.
 */
let instalandoActualizacion = false;

/** Cierra lo que retiene archivos/puertos y avisa cuando terminó. */
export async function prepararseParaActualizar(): Promise<void> {
  instalandoActualizacion = true;
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (mpCronTimer) { clearInterval(mpCronTimer); mpCronTimer = null; }
  updaterController?.dispose?.();
  try { desktopWindows?.closeAll(); } catch { /* */ }
  try { await hardwareManager?.dispose(); } catch { /* */ }
  if (lanServer) {
    try { await lanServer.stop(); } catch { /* */ }   // ESPERAR: libera el puerto y suelta la UI servida
    lanServer = null;
  }
  try { shutdown(dbHandle); } catch { /* */ }          // cierra la base
}

const PRELOAD_PATH = path.join(HERE, 'preload.cjs');
const PROD_INDEX_HTML = path.join(HERE, '..', 'dist', 'index.html');

/**
 * Menú nativo del SO. El sistema ya tiene su MenuBar custom de 8 grupos, así que
 * en Windows/Linux se elimina la barra nativa (File/Edit/View/Window/Help).
 * En macOS NO se puede dejar en null sin romper Cmd+C/V/X/Z/Q → se deja un menú
 * mínimo (app + edit + window) con roles estándar. Los atajos custom (F1-F12,
 * Cmd+K) los maneja el renderer y no dependen de este menú.
 */
function setupAppMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }
}

function createWindow(extraArgs: string[]): void {
  // Guarda anti-duplicado: si ya existe una ventana principal viva, NO creamos
  // otra (si la sobrescribiéramos, la anterior quedaría huérfana en pantalla y
  // el usuario vería "dos sistemas"). Solo la traemos al frente.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }
  setupAppMenu();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    // La ventana arranca MAXIMIZADA y no se puede redimensionar/achicar (para que el
    // usuario no la reduzca sin querer). Sí se puede minimizar.
    resizable: false,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    // Barra de título propia (azul) SÓLO en macOS: ocultamos la nativa y dejamos
    // los traffic lights inset; el título lo dibuja el renderer. En Windows/Linux
    // NO se toca (hidden ocultaría los botones min/max/cerrar).
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // POC: panel de WhatsApp Web embebido en el home
      additionalArguments: extraArgs,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.maximize();
    // Respaldo: si con `resizable:false` la plataforma no maximiza, encajamos la
    // ventana al área de trabajo (pantalla menos la barra de tareas).
    if (!mainWindow.isMaximized()) {
      const { workArea } = screen.getPrimaryDisplay();
      mainWindow.setBounds(workArea);
    }
    mainWindow.show();
  });
  mainWindow.on('closed', () => {
    // Al cerrar la ventana principal forzamos el cierre TOTAL. Si quedara alguna
    // ventana OCULTA viva (un print/diagnóstico que no se destruyó),
    // `window-all-closed` NO dispararía y el proceso main quedaría vivo reteniendo
    // el single-instance lock → zombie que impide reabrir. Destruimos todas las
    // ventanas y disparamos el quit explícito.
    desktopWindows?.closeAll();
    mainWindow = null;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        w.destroy();
      } catch {
        /* noop */
      }
    }
    if (process.platform !== 'darwin') app.quit();
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(HERE, '..', 'dist', 'index.html'));
  }
}

function bootstrap(): { lanArgs: string[] } {
  setupLogger();
  applySessionSecret();
  const machineId = getMachineId();
  const dbPath = getDatabasePath();
  const userDataDir = app.getPath('userData');

  // Cargar config LAN (siempre disponible). Si modo === 'client', pasamos los datos
  // de conexión al renderer vía additionalArguments del BrowserWindow.
  const lanManager = new LanManager(userDataDir);
  const lanCfg = lanManager.getConfig();
  const lanArgs: string[] = [];
  if (lanCfg.mode === 'client' && lanCfg.serverIp && lanCfg.token) {
    lanArgs.push(`--lan-mode=client`);
    lanArgs.push(`--lan-server=${lanCfg.serverIp}:${lanCfg.serverPort ?? DEFAULT_LAN_PORT}`);
    lanArgs.push(`--lan-token=${lanCfg.token}`);
  }

  dbHandle = initialize(dbPath);
  const sessionStore = new SessionStore();
  licenseManager = new LicenseManager({
    userDataDir,
    machineId,
    apiUrl: process.env.CLOUD_API_URL ?? CLOUD_API_URL_DEFAULT,
    publicKeyPem: process.env.CLOUD_JWT_PUBLIC_KEY ?? CLOUD_PUBLIC_KEY_PEM,
  });
  hardwareManager = new HardwareManager({ userDataDir });
  backupService = new BackupService({
    dbPath,
    backupDir: hardwareManager.getConfig().backup.destination,
    appVersion: app.getVersion(),
  });
  const importService = new ExcelImportService();
  const mpTokenStore = new MpTokenStore(machineId);

  // Gestor de ventanas nativas del SO (v0.1.17): cada pantalla abre como una
  // BrowserWindow independiente que carga la app en modo embedded.
  desktopWindows = new DesktopWindowsManager({
    preloadPath: PRELOAD_PATH,
    extraArgs: lanArgs,
    isDev,
    devServerUrl: DEV_SERVER_URL,
    prodIndexHtml: PROD_INDEX_HTML,
    manualPdfPath: app.isPackaged ? path.join(process.resourcesPath, 'manual.pdf') : path.join(HERE, '..', 'build', 'manual.pdf'),
    getMainWindow: () => mainWindow,
  });

  // Updater (no-op en dev / sin empaquetar)
  updaterController = setupAutoUpdater({
    userDataDir,
    getWindow: () => mainWindow,
    isPackaged: app.isPackaged,
    isDev,
    appVersion: app.getVersion(),
  });

  // applyAndRestart: usado por lan:applyAndRestart y wizard.
  const applyAndRestart = (): void => {
    try {
      app.relaunch();
      app.exit(0);
    } catch (err) {
      console.error('[main] applyAndRestart falló:', err);
    }
  };

  const deps = {
    db: dbHandle.db,
    repos: dbHandle.repos,
    sessionStore,
    machineId,
    appVersion: app.getVersion(),
    dbPath,
    userDataDir,
    licenseManager,
    hardware: hardwareManager,
    backup: backupService,
    importService,
    mpTokenStore,
    emit: (channel: string, payload: unknown) => {
      // A TODAS las ventanas, no solo a la principal: cada módulo abre su propia
      // BrowserWindow con su cache aislada, así que un cambio hecho en una
      // ventana (p.ej. una devolución) tiene que poder refrescar a las demás.
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send(channel, payload);
      }
    },
    focusMainWindow: () => {
      mainWindow?.show();
      mainWindow?.focus();
    },
    updater: updaterController,
    prepareForUpdate: prepararseParaActualizar,
    desktopWindows,
    lanExtras: {
      applyAndRestart,
      getConnectedClients: () => lanServer?.getConnectedClients() ?? [],
    },
  };

  const channels = registerIpcHandlers(ipcMain, deps);
  console.info(`[main] StockFlow listo — DB: ${dbPath} — ${channels.length} canales IPC registrados`);

  // Cron: expirar órdenes MP vencidas cada 60s. Usa un admin como currentUser.
  // Se guarda la referencia para poder limpiarlo en before-quit (si no, mantiene
  // vivo el proceso y deja un zombie en Windows).
  mpCronTimer = setInterval(() => {
    void (async () => {
      try {
        if (!dbHandle) return;
        const admin = await dbHandle.repos.users.findByUsername('admin').catch(() => null);
        if (!admin) return;
        const { passwordHash: _ph, ...safe } = admin as { passwordHash?: string; id: string; username: string; fullName: string; role: 'admin' | 'manager' | 'seller'; active: boolean; createdAt: number; updatedAt: number };
        void _ph;
        const ctx = createServiceContext(dbHandle.db, safe, null);
        const mpSvc = new MpQrService(ctx, mpTokenStore);
        const res = await mpSvc.expireStaleOrders();
        if (res.expired > 0) console.info(`[mp] expiradas ${res.expired} órdenes pendientes`);
      } catch (e) {
        console.error('[mp] expire cron falló:', e);
      }
    })();
  }, 60_000);

  if (lanCfg.mode === 'server' && lanCfg.token) {
    const handlers = buildAllHandlers(deps);
    const port = lanCfg.port ?? DEFAULT_LAN_PORT;
    const ip = LanManager.getLocalIp() ?? '0.0.0.0';
    lanServer = new LanServer({
      handlers,
      port,
      token: lanCfg.token,
      enableMdns: true,
      sessionStore,
      licenseStatus: () => licenseManager?.getState().status ?? 'unlicensed',
      // La misma interfaz que usa la app, servida para que un puesto entre por
      // navegador (necesario en PC donde Electron ya no corre, ej. Windows 7).
      // getAppPath() apunta al .asar empaquetado y a apps/desktop en
      // desarrollo: la interfaz compilada vive en dist/ en los dos casos.
      appVersion: app.getVersion(),
      webRoot: path.join(app.getAppPath(), 'dist'),
      resolveUser: async (userId: string) => {
        const u = (await dbHandle?.repos.users.findById(userId)) as { passwordHash?: string; id: string; username: string; fullName: string; role: 'admin' | 'manager' | 'seller'; active: boolean; createdAt: number; updatedAt: number } | null | undefined;
        if (!u) return null;
        const { passwordHash: _ph, ...safe } = u;
        void _ph;
        return safe;
      },
    });
    lanServer
      .start()
      .then(() => console.info(`[LAN] modo=server puerto=${port} IP=${ip} PIN=${lanCfg.token}`))
      .catch((err) => console.error('[LAN] no se pudo iniciar el servidor:', err));
  } else if (lanCfg.mode === 'client') {
    console.info(
      `[LAN] modo=client server=${lanCfg.serverIp}:${lanCfg.serverPort ?? DEFAULT_LAN_PORT}`,
    );
  } else {
    console.info('[LAN] modo=single (1 PC)');
  }

  return { lanArgs };
}

function startLicenseHeartbeat(): void {
  if (!licenseManager) return;
  const beat = (): void => {
    // Tras cada heartbeat avisamos al renderer para que refresque el estado de
    // licencia (renovación automática, suspensión o revocación se reflejan al instante).
    void licenseManager?.heartbeat().finally(() => mainWindow?.webContents.send('license:changed'));
  };
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
}

// Nota impresión: la impresión silenciosa de tickets va por ESC/POS crudo al
// spooler del SO (ver PrinterService). El motor de impresión de Electron daba
// hoja en blanco en térmicas. window.print()+diálogo queda sólo como fallback/A4.

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(async () => {
      const { lanArgs } = bootstrap();
      // Si el token de licencia venció estando offline, renovarlo SOLO con la clave
      // guardada ANTES de mostrar la UI (timeout corto para no demorar el arranque
      // si no hay red). Así el cliente nunca tiene que re-ingresar la clave.
      if (licenseManager) {
        await Promise.race([
          licenseManager.attemptSilentReactivation().catch(() => false),
          new Promise<void>((resolve) => setTimeout(resolve, 4000)),
        ]);
      }
      createWindow(lanArgs);
      hardwareManager?.setEmitter((channel, payload) => {
        mainWindow?.webContents.send(channel, payload);
      });
      mainWindow?.once('ready-to-show', () => startLicenseHeartbeat());
      // 10 segundos después de mostrar la ventana, chequear si la versión instalada
      // quedó atrás respecto a GitHub Releases (Squirrel.Mac falla sin firma).
      // SÓLO EN MAC. En Windows la actualización se baja e instala sola con un
      // clic; mostrar además "bajá el instalador" y mandar al usuario a una
      // página de GitHub es confuso y contradice el camino bueno. En mac es el
      // único aviso posible: Squirrel.Mac no puede aplicar un update sin firma.
      if (process.platform === 'darwin') {
        mainWindow?.once('ready-to-show', () => {
          setTimeout(() => {
            void checkForOutdatedVersion({
              appVersion: app.getVersion(),
              isPackaged: app.isPackaged,
              onOutdated: (info) => {
                mainWindow?.webContents.send('updater:outdated', info);
              },
            });
          }, 10_000);
        });
      }
      app.on('activate', () => {
        // Clic en el ícono del Dock / barra con la app YA abierta: NO crear otra
        // ventana principal (se veían "dos sistemas"). Si la principal existe,
        // traerla al frente (aunque haya ventanas nativas hijas abiertas). Solo
        // creamos una nueva si de verdad no queda ninguna ventana principal.
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          if (!mainWindow.isVisible()) mainWindow.show();
          mainWindow.focus();
          return;
        }
        if (BrowserWindow.getAllWindows().length === 0) createWindow(lanArgs);
      });
    })
    .catch((err: unknown) => {
      console.error('[main] Error fatal en el arranque:', err);
      shutdown(dbHandle);
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      shutdown(dbHandle);
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    // Liberar el single-instance lock YA: aunque el cierre (backup/dispose) tarde
    // unos segundos, el usuario puede REABRIR la app sin esperar (mata el "no abre").
    try {
      app.releaseSingleInstanceLock();
    } catch {
      /* noop */
    }
    // Cierre limpio de TODO lo que mantiene vivo el proceso (timers, puertos
    // serie, servidor LAN, ventanas ocultas). Idempotente. Si algo de esto queda
    // vivo, en Windows el proceso no muere → zombie que retiene el
    // single-instance lock y impide reabrir la app.
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (mpCronTimer) { clearInterval(mpCronTimer); mpCronTimer = null; }
    updaterController?.dispose?.();
    void hardwareManager?.dispose(); // cierra puertos serie (balanza/impresora)
    if (lanServer) {
      void lanServer.stop(); // libera el puerto LAN (evita EADDRINUSE al reabrir)
      lanServer = null;
    }
    try { desktopWindows?.closeAll(); } catch { /* */ }

    // Backup pre-quit (si está configurado) CON watchdog: una copia que se cuelga
    // no debe impedir el cierre (era otra causa de proceso zombie).
    if (
      !instalandoActualizacion &&      // actualizando: el cierre debe ser inmediato
      !quittingForBackup &&
      hardwareManager?.getConfig().backup.autoOnAppQuit &&
      backupService
    ) {
      event.preventDefault();
      quittingForBackup = true;
      const forceExit = setTimeout(() => {
        console.warn('[lifecycle] backup pre-quit tardó demasiado — salgo igual');
        shutdown(dbHandle);
        app.exit(0);
      }, 8000);
      void backupService
        .createBackup()
        .catch((err) => console.error('[main] backup pre-quit falló:', err))
        .finally(() => {
          clearTimeout(forceExit);
          shutdown(dbHandle);
          app.exit(0);
        });
      return;
    }
    shutdown(dbHandle);
    // Salida FORZADA: garantiza que el proceso y sus subprocesos mueran aunque
    // quede algún handle nativo colgado → libera el lock y permite reabrir.
    app.exit(0);
  });
}
