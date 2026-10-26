/**
 * Modo «sin pantalla» SÓLO para las pruebas automáticas de la ventana real.
 *
 * Bruno (26-oct-2026): las pruebas abrían ventanas de StockFlow en su pantalla
 * mientras trabajaba en otra cosa. Con la variable de entorno
 * STOCKFLOW_SIN_PANTALLA=1 la app corre igual (ventanas, pantallas, CDP,
 * capturas), pero invisible: sin ícono en el Dock, sin robar el foco, con las
 * ventanas transparentes, fuera de la pantalla y sin recibir clics.
 *
 * Sin esa variable no hace NADA: los clientes no la tienen y nada cambia.
 */
import { app, BrowserWindow, Notification } from 'electron';

const LEJOS = -32000;

export function aplicarSinPantalla(): void {
  if (process.env.STOCKFLOW_SIN_PANTALLA !== '1') return;

  const esconder = (win: BrowserWindow): void => {
    try {
      if (win.isDestroyed()) return;
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
      win.setSkipTaskbar(true);
      const b = win.getBounds();
      if (b.x !== LEJOS || b.y !== LEJOS) win.setBounds({ x: LEJOS, y: LEJOS, width: b.width, height: b.height });
    } catch {
      /* ventana cerrándose */
    }
  };

  const proto = BrowserWindow.prototype as unknown as Record<string, unknown>;
  const showInactive = BrowserWindow.prototype.showInactive;
  const setBounds = BrowserWindow.prototype.setBounds;
  proto.show = function (this: BrowserWindow) {
    esconder(this);
    showInactive.call(this);
  };
  proto.showInactive = function (this: BrowserWindow) {
    esconder(this);
    showInactive.call(this);
  };
  proto.focus = function () {};
  proto.moveTop = function () {};
  proto.setAlwaysOnTop = function () {};
  proto.maximize = function (this: BrowserWindow) {
    esconder(this);
  };
  proto.center = function (this: BrowserWindow) {
    esconder(this);
  };
  proto.setBounds = function (this: BrowserWindow, bounds: Partial<Electron.Rectangle>, animate?: boolean) {
    setBounds.call(this, { ...bounds, x: LEJOS, y: LEJOS }, animate);
  };
  proto.setPosition = function (this: BrowserWindow) {
    setBounds.call(this, { x: LEJOS, y: LEJOS });
  };
  (Notification.prototype as unknown as Record<string, unknown>).show = function () {};
  (app as unknown as Record<string, unknown>).focus = function () {};

  app.on('browser-window-created', (_e, win) => {
    esconder(win);
    win.on('show', () => esconder(win));
  });

  const sinDock = (): void => {
    if (process.platform !== 'darwin') return;
    try {
      app.setActivationPolicy('accessory');
      app.dock?.hide();
    } catch {
      /* ignorar */
    }
  };
  sinDock();
  void app.whenReady().then(sinDock);
  console.log('[sin-pantalla] activo: ventanas invisibles y sin foco (sólo pruebas)');
}
