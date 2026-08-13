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
const SESION_KEY = 'stockflow.web.sesion';
/**
 * Marca de "esta corrida del navegador". Vive en sessionStorage, así que
 * desaparece al cerrar la ventana pero sobrevive a las recargas y al abrir
 * módulos. Sirve para distinguir "recargué" de "abrí el acceso de nuevo".
 */
const CORRIDA_KEY = 'stockflow.web.corrida';

/**
 * Versión del servidor. Se pide una sola vez al ping y se guarda la PROMESA,
 * no el valor: la pantalla de ingreso la pide apenas monta y si guardáramos
 * sólo el valor llegaría tarde y mostraría un guion.
 */
let versionServidor: Promise<string> | null = null;

function pedirVersion(ip: string, puerto: number): Promise<string> {
  versionServidor ??= fetch(`http://${ip}:${puerto}/lan/ping`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { version?: string | null } | null) => d?.version ?? 'servidor')
    .catch(() => 'servidor');
  return versionServidor;
}
const IMPRESORA_KEY = 'stockflow.web.impresora';

/**
 * Ancho de papel de ESTA terminal. Cada puesto puede tener su impresora (una
 * de 58mm en el mostrador, una A4 en la oficina), así que la configuración es
 * de la máquina y no del sistema: se guarda en el navegador de cada PC.
 */
export function anchoImpresora(): '58mm' | '80mm' | 'A4' {
  const v = localStorage.getItem(IMPRESORA_KEY);
  return v === '58mm' || v === '80mm' || v === 'A4' ? v : '58mm';
}

export function guardarAnchoImpresora(v: '58mm' | '80mm' | 'A4'): void {
  localStorage.setItem(IMPRESORA_KEY, v);
}

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
async function responderLocal(channel: string): Promise<IpcResponse<unknown>> {
  const [grupo, metodo] = channel.split(':');

  if (grupo === 'lan') {
    if (metodo === 'getConfig') {
      const cfg = configDesdeUrl();
      return ok({ mode: 'client', serverIp: cfg.serverIp, serverPort: cfg.serverPort });
    }
    if (metodo === 'getLocalIp') return ok({ ip: null });
    // Idem: la pestaña Red las pide al abrirse. Las terminales conectadas las
    // sabe el servidor, no el puesto.
    if (metodo === 'getConnectedClients') return ok([]);
    if (metodo === 'getStatus') return ok({ running: true, mode: 'client' });
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
    // La pestaña Actualizaciones las pide al abrirse: si se rechazan, no abre.
    // El puesto no se actualiza solo (se actualiza el servidor), pero la
    // pantalla tiene que poder mostrarse.
    if (metodo === 'getAutoCheck') return ok({ autoCheck: true });
    if (metodo === 'getChannel') return ok({ channel: 'stable' });
    if (metodo === 'getPending') return ok(null);
    return noAplica('Las actualizaciones');
  }

  if (grupo === 'print') {
    if (metodo === 'getConfig') return ok({ paperFormat: anchoImpresora(), copies: 1, mode: 'dialog' });
    if (metodo === 'setConfig') return ok({ ok: true });
    // Devuelve ARRAY: la pantalla hace `.length` sobre esto. Un `{ok:true}`
    // ahí no rompe hoy, pero es una bomba de tiempo.
    if (metodo === 'listElectron') return ok([]);
    return ok({ ok: true });
  }

  if (grupo === 'hardware') {
    // El ancho de papel es de ESTA terminal, no del servidor: cada puesto
    // puede tener su impresora. Lo guarda el propio navegador de esa PC.
    if (channel === 'hardware:printer:get-config') {
      // La forma tiene que estar COMPLETA. Devolverla a medias rompía la
      // pantalla de Configuración Hardware: `interface` llegaba undefined y el
      // componente hace `systemName.trim()` -> "Cannot read properties of
      // undefined". No alcanza con que las consultas no fallen; los datos
      // tienen que tener la forma que la pantalla espera.
      const ancho = anchoImpresora();
      return ok({
        kind: 'system',
        interface: '',
        width: ancho === '58mm' ? 58 : 80,
        characterSet: 'PC858_EURO',
        autoOpenDrawer: false,
        paperFormat: ancho,
        copies: 1,
        silentPrint: false,      // en el navegador siempre sale por el diálogo
        autoPrintOnSale: true,
      });
    }
    if (channel === 'hardware:printer:set-config') return ok({ ok: true });
    // Imprimir sale por el diálogo del navegador + driver de Windows, igual
    // que la factura A4 en la app. Lo que NO hay es el envío directo de
    // comandos a la térmica (necesita acceso al puerto).
    if (channel.startsWith('hardware:printer:print')) {
      return noAplica('La impresión directa a la térmica');
    }
    if (channel === 'hardware:printer:list-system') return ok([]);
    // Estas tres las pide la pestaña Hardware AL ABRIRSE. Si se rechazan, la
    // pestaña entera no abre —era el bug: "no puedo entrar a Configuración
    // Hardware desde la terminal"—. Se contestan vacías: el puesto no tiene
    // puerto serie ni balanza propios, y así la pantalla abre y muestra lo que
    // sí le sirve (el ancho de papel de ESTA terminal).
    if (channel === 'hardware:printer:list-serial') return ok([]);
    if (channel === 'hardware:printer:list-usb') return ok([]);
    if (channel === 'hardware:scale:get-config') {
      return ok({ portPath: '', baudRate: 9600, protocol: 'generic', mode: 'request' });
    }
    // Lo que SÍ toca un aparato (probar impresora, abrir cajón, leer balanza)
    // se rechaza con un mensaje claro: son acciones que dispara el usuario, no
    // datos que la pantalla necesite para abrir.
    return noAplica('El manejo directo de impresora, cajón y balanza');
  }

  if (grupo === 'desktopWindow' || grupo === 'windows') {
    return ok({ ok: true });   // abrir ventanas: en web se ignora
  }

  if (grupo === 'system') {
    // La versión la sabe el servidor y la manda en el ping: en una pestaña no
    // hay proceso de Electron al que preguntarle. Se muestra en la pantalla de
    // ingreso para que el comercio sepa con qué versión está trabajando.
    if (metodo === 'getVersion') {
      const cfg = configDesdeUrl();
      return ok({ version: await pedirVersion(cfg.serverIp, cfg.serverPort) });
    }
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

  // ¿Es una corrida NUEVA del navegador (se abrió el acceso) o una recarga?
  // sessionStorage muere al cerrar la ventana y sobrevive a las recargas, así
  // que su ausencia significa "recién abierto" → se cierra la sesión anterior
  // y la terminal arranca siempre en el ingreso.
  try {
    if (!sessionStorage.getItem(CORRIDA_KEY)) {
      sessionStorage.setItem(CORRIDA_KEY, String(Date.now()));
      localStorage.removeItem(SESION_KEY);
    }
  } catch {
    /* navegador sin almacenamiento: se pide ingreso igual */
  }

  // Se dispara ya, así está lista cuando la pantalla de ingreso la pida.
  void pedirVersion(lanCfg.serverIp, lanCfg.serverPort);
  const io: BridgeIO = {
    invoke: (channel) => responderLocal(channel),
    listeners: crearListeners(),
    fetch: (input, init) => window.fetch(input, init),
    httpTimeoutMs: 15_000,
    // La sesión se comparte entre pestañas: si no, cada módulo que se abre
    // pediría iniciar sesión otra vez. Pero NO sobrevive a cerrar el acceso:
    // al abrirlo de nuevo se pide usuario y contraseña. En un mostrador con
    // varios cajeros, dejar la sesión del turno anterior abierta hace que las
    // ventas queden a nombre de quien no las hizo.
    session: {
      load: () => localStorage.getItem(SESION_KEY),
      save: (t) => {
        if (t) localStorage.setItem(SESION_KEY, t);
        else localStorage.removeItem(SESION_KEY);
      },
    },
  };
  const api = createApiBridge('client', lanCfg, io);
  (window as unknown as { stockflow: unknown }).stockflow = api;
  (window as unknown as { __stockflowWeb: boolean }).__stockflowWeb = true;
}
