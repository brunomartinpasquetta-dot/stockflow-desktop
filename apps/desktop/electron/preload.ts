/**
 * Preload (sandbox: true, contextBridge).
 *
 * Lee `process.argv` para detectar el modo LAN (`--lan-mode`, `--lan-server`,
 * `--lan-token`) y construye el bridge enrutando cada canal a IPC local o a
 * HTTP RPC contra el servidor LAN según corresponda. Ver `preload-bridge.ts`.
 */
import { contextBridge, ipcRenderer } from 'electron';

import { createApiBridge, parseLanArgs, type BridgeIO, type IdentidadTerminal } from './preload-bridge';

const { mode, lanCfg } = parseLanArgs(process.argv);

const io: BridgeIO = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // Quién es esta PC (machineId, nombre y, si es PC de sucursal emparejada,
  // su token): lo pide el puente y lo manda en cada pedido al servidor. Lo
  // responde el main (`lan:identidadTerminal`), que en una PC de sucursal
  // antes comprueba que la dirección sea SU casa central; no se expone a la
  // interfaz.
  identidad: async (opciones) => {
    if (mode !== 'client') return null;
    const r = (await ipcRenderer.invoke('lan:identidadTerminal', opciones)) as
      | { ok: true; data: IdentidadTerminal }
      | { ok: false };
    return r && r.ok ? r.data : null;
  },
  // Los encabezados de identidad viajan sólo si el servidor avisa que los
  // admite: desde file:// pasan por la consulta previa de CORS y un servidor
  // todavía sin actualizar los rechazaría (ver BridgeIO.sondearIdentidad).
  sondearIdentidad: true,
  listeners: {
    on: (channel, listener) => {
      const wrapped = (_event: unknown, payload: unknown): void => listener(payload);
      // Guardamos el wrapper en el listener (id por referencia) para off()
      (listener as { __wrapped?: typeof wrapped }).__wrapped = wrapped;
      ipcRenderer.on(channel, wrapped);
    },
    off: (channel, listener) => {
      const wrapped = (listener as { __wrapped?: (_e: unknown, p: unknown) => void }).__wrapped;
      if (wrapped) ipcRenderer.removeListener(channel, wrapped);
    },
  },
};

const api = createApiBridge(mode, lanCfg, io);

contextBridge.exposeInMainWorld('stockflow', api);
