/**
 * Tipos de la API IPC expuesta en `window.stockflow` (ver electron/preload.ts).
 * Re-exporta todos los DTOs, la forma de respuesta y los enums para uso en el renderer.
 */
import type { ApiSurface } from '../../electron/ipc/types';

declare global {
  interface Window {
    stockflow: ApiSurface;
  }
}

export * from '../../electron/ipc/types';
export {};
