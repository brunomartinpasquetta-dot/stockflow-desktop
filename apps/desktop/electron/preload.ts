/**
 * Preload (sandbox: true, contextBridge).
 *
 * Lee `process.argv` para detectar el modo LAN (`--lan-mode`, `--lan-server`,
 * `--lan-token`) y construye el bridge enrutando cada canal a IPC local o a
 * HTTP RPC contra el servidor LAN según corresponda. Ver `preload-bridge.ts`.
 */
import { contextBridge, ipcRenderer } from 'electron';

import { createApiBridge, parseLanArgs, type BridgeIO } from './preload-bridge';

const { mode, lanCfg } = parseLanArgs(process.argv);

const io: BridgeIO = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
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
