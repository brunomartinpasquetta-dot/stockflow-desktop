/**
 * PUENTE WEB — hace que StockFlow funcione en una pestaña del navegador.
 *
 * Nació porque las terminales de un cliente son Windows 7 y Electron dejó de
 * soportarlo en la v23: ahí la app no puede ni arrancar. En vez de mantener
 * una compilación vieja en paralelo, el servidor sirve la misma interfaz y el
 * puesto entra con el navegador.
 *
 * No hay nada nuevo del lado de la lógica: el modo terminal YA hablaba con el
 * servidor por HTTP (`POST /lan/rpc`), así que se reusa `createApiBridge` tal
 * cual, pasándole el `fetch` del navegador en vez del de Electron.
 *
 * Lo único que hay que resolver son los canales que en la app instalada se
 * responden LOCALMENTE (impresora, licencia, updater, ventanas). Acá no existe
 * un proceso principal que los atienda, así que se responden con valores
 * seguros para que la interfaz no se rompa. Ver `responderLocal`.
 */
import {
  createApiBridge,
  type BridgeIO,
  type LanClientConfig,
} from '../../electron/preload-bridge';
import type { IpcResponse } from '../../electron/ipc/types';

const PIN_KEY = 'stockflow.web.pin';

/** El servidor es quien sirvió esta página. */
function configDesdeUrl(): LanClientConfig {
  const url = new URL(window.location.href);
  const pinDeUrl = url.searchParams.get('pin');
  if (pinDeUrl) {
    localStorage.setItem(PIN_KEY, pinDeUrl);
    url.searchParams.delete('pin');           // no dejarlo a la vista
    window.history.replaceState({}, '', url.toString());
  }
  return {
    serverIp: url.hostname,
    serverPort: Number(url.port) || 7777,
    token: pinDeUrl ?? localStorage.getItem(PIN_KEY) ?? '',
  };
}

/** true si todavía no tenemos el PIN del servidor. */
export function faltaPin(): boolean {
  return !localStorage.getItem(PIN_KEY);
}

export function guardarPin(pin: string): void {
  localStorage.setItem(PIN_KEY, pin.trim());
}

const ok = <T,>(data: T): IpcResponse<T> => ({ ok: true, data });
const noAplica = (que: string): IpcResponse<never> => ({
  ok: false,
  code: 'BUSINESS_RULE',
  message: `${que} no está disponible desde el navegador`,
});

/**
 * Respuestas para los canales que en la app instalada atiende el proceso
 * principal. Se responde de forma que la interfaz siga funcionando:
 *
 *  - `license`: la maneja el servidor; el puesto trabaja con la de él.
 *  - `print`: imprimir sigue funcionando, porque el ticket y la factura se
 *    arman con `window.print()` y el driver del sistema (ver printService).
 *    Lo único que no hay es la impresión térmica silenciosa por comandos
 *    crudos, que necesita acceso directo al puerto de la impresora.
 *  - `updater` / `desktopWindow`: no tienen sentido en una pestaña.
 */
function responderLocal(channel: string): IpcResponse<unknown> {
  const [grupo, metodo] = channel.split(':');

  if (grupo === 'lan') {
    if (metodo === 'getConfig') {
      const cfg = configDesdeUrl();
      return ok({ mode: 'client', serverIp: cfg.serverIp, serverPort: cfg.serverPort });
    }
    if (metodo === 'getLocalIp') return ok({ ip: null });
    return noAplica('La configuración de red');
  }

  if (grupo === 'license') {
    // El servidor ya validó su licencia; si no, /lan/rpc rechazaría todo.
    if (metodo === 'getState') return ok({ status: 'active', plan: 'pro', source: 'servidor' });
    return noAplica('La gestión de licencia');
  }

  if (grupo === 'updater') {
    if (metodo === 'getState' || metodo === 'check') {
      return ok({ status: 'idle', currentVersion: 'web', availableVersion: null });
    }
    return noAplica('Las actualizaciones');
  }

  if (grupo === 'print') {
    // La impresión real la hace el navegador desde el renderer.
    if (metodo === 'getConfig') return ok({ width: '80', copies: 1, mode: 'dialog' });
    return ok({ ok: true });
  }

  if (grupo === 'hardware') {
    if (metodo === 'listPrinters') return ok([]);
    return noAplica('El manejo directo de impresora y cajón');
  }

  if (grupo === 'desktopWindow' || grupo === 'windows') {
    return ok({ ok: true });   // abrir ventanas: en web se ignora
  }

  if (grupo === 'system') {
    return ok({ ok: true });
  }

  return noAplica(`"${channel}"`);
}

/**
 * Avisos de cambios entre puestos. En la app instalada llegan por IPC desde el
 * proceso principal; acá se consultan al servidor cada pocos segundos para que
 * la pantalla se refresque igual cuando otro puesto carga una venta.
 */
function crearListeners(): BridgeIO['listeners'] {
  const subs = new Map<string, Set<(p: unknown) => void>>();
  let ultimo = Date.now();

  const revisar = async (): Promise<void> => {
    const cbs = subs.get('data:changed');
    if (!cbs?.size) return;
    try {
      const cfg = configDesdeUrl();
      const res = await fetch(
        `http://${cfg.serverIp}:${cfg.serverPort}/lan/changes?since=${ultimo}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as { changed?: boolean; at?: number };
      if (body.changed) {
        ultimo = body.at ?? Date.now();
        for (const cb of cbs) cb({ channel: 'remoto', group: 'todos' });
      }
    } catch {
      /* si el servidor no responde, el indicador de conexión ya lo muestra */
    }
  };
  setInterval(() => void revisar(), 4000);

  return {
    on: (channel, listener) => {
      if (!subs.has(channel)) subs.set(channel, new Set());
      subs.get(channel)!.add(listener);
    },
    off: (channel, listener) => {
      subs.get(channel)?.delete(listener);
    },
  };
}

/** Monta `window.stockflow` en el navegador. Se llama antes de renderizar. */
export function instalarPuenteWeb(): void {
  const lanCfg = configDesdeUrl();
  const io: BridgeIO = {
    invoke: async (channel) => responderLocal(channel),
    listeners: crearListeners(),
    fetch: (input, init) => window.fetch(input, init),
    httpTimeoutMs: 15_000,
  };
  const api = createApiBridge('client', lanCfg, io);
  (window as unknown as { stockflow: unknown }).stockflow = api;
  (window as unknown as { __stockflowWeb: boolean }).__stockflowWeb = true;
}
