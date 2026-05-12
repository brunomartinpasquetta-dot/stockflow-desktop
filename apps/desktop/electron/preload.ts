import { contextBridge } from 'electron';

// Stub de API expuesta al renderer. Se completa en prompts posteriores
// (IPC para licencias, sync, impresión, etc.).
contextBridge.exposeInMainWorld('stockflow', {
  platform: process.platform,
  ping: (): string => 'pong',
});

export type StockflowBridge = {
  platform: NodeJS.Platform;
  ping: () => string;
};
