import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDatabasePath, initialize, shutdown, type DbHandle } from './bootstrap/db';
import { getMachineId } from './bootstrap/machine';
import { applySessionSecret } from './bootstrap/session';
import { registerIpcHandlers } from './ipc';
import { SessionStore } from './ipc/session-store';
import { setupLogger } from './logger';

const isDev = process.env.NODE_ENV === 'development';
// Vite escucha en `localhost` (puede resolver a ::1 / IPv6): usar el nombre, no 127.0.0.1.
const DEV_SERVER_URL = 'http://localhost:5173';
/** Directorio del bundle (dist-electron/). */
const HERE = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let dbHandle: DbHandle | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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

function bootstrap(): void {
  setupLogger();
  applySessionSecret();
  const machineId = getMachineId();
  const dbPath = getDatabasePath();
  dbHandle = initialize(dbPath);
  const sessionStore = new SessionStore();
  const channels = registerIpcHandlers(ipcMain, {
    db: dbHandle.db,
    repos: dbHandle.repos,
    sessionStore,
    machineId,
    appVersion: app.getVersion(),
    dbPath,
  });
  console.info(`[main] StockFlow listo — DB: ${dbPath} — ${channels.length} canales IPC registrados`);
}

// Una sola instancia: si ya hay otra corriendo, ceder y enfocar la existente.
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
      bootstrap();
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

  app.on('before-quit', () => {
    shutdown(dbHandle);
  });
}
