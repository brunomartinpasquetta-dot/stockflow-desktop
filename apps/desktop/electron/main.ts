import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BackupService } from './backup/BackupService';
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
import { setupLogger } from './logger';
import { setupAutoUpdater, type UpdaterController } from './updater';

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER_URL = 'http://localhost:5173';
const HERE = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let dbHandle: DbHandle | null = null;
let licenseManager: LicenseManager | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let hardwareManager: HardwareManager | null = null;
let backupService: BackupService | null = null;
let lanServer: LanServer | null = null;
let updaterController: UpdaterController | null = null;
let quittingForBackup = false;

function createWindow(extraArgs: string[]): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: extraArgs,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
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
    apiUrl: process.env.CLOUD_API_URL ?? 'http://localhost:3009',
    publicKeyPem: process.env.CLOUD_JWT_PUBLIC_KEY ?? '',
  });
  hardwareManager = new HardwareManager({ userDataDir });
  backupService = new BackupService({
    dbPath,
    backupDir: hardwareManager.getConfig().backup.destination,
    appVersion: app.getVersion(),
  });
  const importService = new ExcelImportService();

  // Updater (no-op en dev / sin empaquetar)
  updaterController = setupAutoUpdater({
    userDataDir,
    getWindow: () => mainWindow,
    isPackaged: app.isPackaged,
    isDev,
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
    emit: (channel: string, payload: unknown) => {
      mainWindow?.webContents.send(channel, payload);
    },
    updater: updaterController,
    lanExtras: {
      applyAndRestart,
      getConnectedClients: () => lanServer?.getConnectedClients() ?? [],
    },
  };

  const channels = registerIpcHandlers(ipcMain, deps);
  console.info(`[main] StockFlow listo — DB: ${dbPath} — ${channels.length} canales IPC registrados`);

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
  void licenseManager.heartbeat();
  heartbeatTimer = setInterval(() => {
    void licenseManager?.heartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app
    .whenReady()
    .then(() => {
      const { lanArgs } = bootstrap();
      createWindow(lanArgs);
      hardwareManager?.setEmitter((channel, payload) => {
        mainWindow?.webContents.send(channel, payload);
      });
      mainWindow?.once('ready-to-show', () => startLicenseHeartbeat());
      app.on('activate', () => {
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
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (lanServer) {
      void lanServer.stop();
      lanServer = null;
    }
    if (
      !quittingForBackup &&
      hardwareManager?.getConfig().backup.autoOnAppQuit &&
      backupService
    ) {
      event.preventDefault();
      quittingForBackup = true;
      void backupService
        .createBackup()
        .catch((err) => console.error('[main] backup pre-quit falló:', err))
        .finally(() => {
          shutdown(dbHandle);
          app.exit(0);
        });
      return;
    }
    shutdown(dbHandle);
  });
}
