/**
 * Gestor de ventanas nativas del SO (v0.1.17).
 *
 * Cada "pantalla" de StockFlow (Artículos, Ventas, Caja, etc.) se abre como una
 * `BrowserWindow` nativa independiente: se mueve por toda la pantalla, a otro
 * monitor, se minimiza a la barra del SO. Reemplaza el viejo MDI in-app.
 *
 * - Una instancia por `pageKey` (la `windowKey` es el `pageKey`). Si ya existe
 *   se enfoca/restaura en vez de duplicar.
 * - Todas las ventanas comparten la `session` default (cookies/storage) con la
 *   ventana principal: NO se setea `partition`.
 * - Las child windows cargan la app en modo "embedded": `#/embedded/<pageKey>`.
 */
import { BrowserWindow } from 'electron';

export interface DesktopWindowOpenInput {
  /** pageKey del registry (también es la windowKey). */
  pageKey: string;
  /** Título de la barra nativa (del registry). */
  title?: string;
  /** Params serializables que se pasan como querystring a la ruta embedded. */
  params?: Record<string, unknown>;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

export interface DesktopWindowInfo {
  windowKey: string;
  title: string;
  minimized: boolean;
  focused: boolean;
}

export interface DesktopWindowsConfig {
  /** Path absoluto al preload.cjs (el mismo que usa la ventana principal). */
  preloadPath: string;
  /** Args extra (LAN) que recibe la ventana principal — se replican acá. */
  extraArgs: string[];
  /** true en desarrollo (carga desde el dev server de Vite). */
  isDev: boolean;
  /** URL del dev server (ej. http://localhost:5173). */
  devServerUrl: string;
  /** Path absoluto al index.html empaquetado (modo prod). */
  prodIndexHtml: string;
  /** Path absoluto al icono de la app (opcional). */
  iconPath?: string;
  /** Path absoluto al manual de usuario (PDF) que renderiza Chromium. */
  manualPdfPath: string;
  /** Devuelve la ventana principal (para `focusMain`). */
  getMainWindow: () => BrowserWindow | null;
}

/**
 * Construye la URL de la ruta embedded para un pageKey + params.
 * En dev: `http://localhost:5173/#/embedded/<pageKey>?<qs>`
 * En prod se usa `loadFile` con la opción `hash` (ver `openDesktopWindow`).
 */
function buildEmbeddedHash(pageKey: string, params?: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      qs.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }
  const query = qs.toString();
  return `/embedded/${encodeURIComponent(pageKey)}${query ? `?${query}` : ''}`;
}

export class DesktopWindowsManager {
  private readonly windows = new Map<string, BrowserWindow>();

  constructor(private readonly config: DesktopWindowsConfig) {}

  /** Abre (o enfoca si ya existe) la ventana nativa para un pageKey. */
  open(input: DesktopWindowOpenInput): { windowKey: string; created: boolean } {
    const windowKey = input.pageKey;
    const existing = this.windows.get(windowKey);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { windowKey, created: false };
    }

    const win = new BrowserWindow({
      width: input.width ?? 1100,
      height: input.height ?? 720,
      minWidth: input.minWidth ?? 480,
      minHeight: input.minHeight ?? 360,
      title: input.title ?? 'StockFlow',
      show: false,
      autoHideMenuBar: true,
      ...(this.config.iconPath ? { icon: this.config.iconPath } : {}),
      webPreferences: {
        preload: this.config.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: this.config.extraArgs,
      },
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('closed', () => {
      this.windows.delete(windowKey);
    });

    const hash = buildEmbeddedHash(input.pageKey, input.params);
    if (this.config.isDev) {
      void win.loadURL(`${this.config.devServerUrl}/#${hash}`);
    } else {
      void win.loadFile(this.config.prodIndexHtml, { hash });
    }

    this.windows.set(windowKey, win);
    return { windowKey, created: true };
  }

  /** Cierra la ventana nativa indicada (si existe). */
  close(windowKey: string): boolean {
    const win = this.windows.get(windowKey);
    if (!win || win.isDestroyed()) return false;
    win.close();
    return true;
  }

  /** Enfoca/restaura una ventana nativa. */
  focus(windowKey: string): boolean {
    const win = this.windows.get(windowKey);
    if (!win || win.isDestroyed()) return false;
    if (win.isMinimized()) win.restore();
    win.focus();
    return true;
  }

  /** Lista las ventanas nativas abiertas. */
  list(): DesktopWindowInfo[] {
    const result: DesktopWindowInfo[] = [];
    for (const [windowKey, win] of this.windows.entries()) {
      if (win.isDestroyed()) continue;
      result.push({
        windowKey,
        title: win.getTitle(),
        minimized: win.isMinimized(),
        focused: win.isFocused(),
      });
    }
    return result;
  }

  /**
   * Abre (o enfoca si ya existe) la ventana del manual de usuario: un visor de
   * PDF nativo de Chromium. No necesita preload (es sólo el PDF).
   */
  openManual(): { created: boolean } {
    const existing = this.windows.get('__manual__');
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { created: false };
    }

    const win = new BrowserWindow({
      width: 1000,
      height: 800,
      title: 'Manual de usuario - StockFlow',
      show: false,
      autoHideMenuBar: true,
      ...(this.config.iconPath ? { icon: this.config.iconPath } : {}),
    });

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    win.on('closed', () => {
      this.windows.delete('__manual__');
    });

    void win.loadFile(this.config.manualPdfPath);

    this.windows.set('__manual__', win);
    return { created: true };
  }

  /** Enfoca la ventana principal de la app. */
  focusMain(): void {
    const main = this.config.getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.focus();
    }
  }

  /** Busca la windowKey de una ventana dada su `webContents.id`. */
  private keyForWebContents(webContentsId: number): string | null {
    for (const [windowKey, win] of this.windows.entries()) {
      if (!win.isDestroyed() && win.webContents.id === webContentsId) return windowKey;
    }
    return null;
  }

  /** Cierra la ventana nativa que originó un evento IPC (por su webContents). */
  closeForWebContents(webContentsId: number): boolean {
    const key = this.keyForWebContents(webContentsId);
    if (!key) return false;
    return this.close(key);
  }

  /** Minimiza la ventana nativa que originó un evento IPC. */
  minimizeForWebContents(webContentsId: number): boolean {
    const key = this.keyForWebContents(webContentsId);
    if (!key) return false;
    const win = this.windows.get(key);
    if (!win || win.isDestroyed()) return false;
    win.minimize();
    return true;
  }

  /** Cierra todas las child windows (al cerrar la principal). */
  closeAll(): void {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.close();
    }
    this.windows.clear();
  }
}
