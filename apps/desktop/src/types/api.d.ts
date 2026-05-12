/**
 * Tipos de la API IPC expuesta en `window.stockflow` (ver electron/preload.ts).
 * Re-exporta también los DTOs y la forma de respuesta para uso en el renderer.
 */
import type { ApiSurface } from '../../electron/ipc/types';

declare global {
  interface Window {
    stockflow: ApiSurface;
  }
}

export type {
  ApiSurface,
  IpcResponse,
  IpcErr,
  IpcOk,
  IpcErrorCode,
} from '../../electron/ipc/types';
export {};
