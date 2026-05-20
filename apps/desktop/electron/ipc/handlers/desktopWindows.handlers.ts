/**
 * Handlers IPC del gestor de ventanas nativas del SO (v0.1.17).
 *
 * El renderer (WindowManagerContext) pide abrir/cerrar/listar ventanas; el main
 * process las materializa como `BrowserWindow`. El gestor real (`desktopWindows`)
 * se inyecta desde main.ts; ausente en los tests de integración, donde estos
 * canales devuelven un error controlado.
 *
 * Los canales `:closeSelf` / `:minimizeSelf` / `:focusMain` usan el `webContents`
 * emisor del evento IPC para identificar la ventana que los disparó.
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';

interface OpenPayload {
  pageKey: string;
  title?: string;
  params?: Record<string, unknown>;
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
}

export function buildDesktopWindowsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'desktopWindow:open': unguarded(
      deps,
      async (payload: OpenPayload): Promise<{ windowKey: string; created: boolean }> => {
        if (!deps.desktopWindows) {
          throw new Error('Gestor de ventanas no disponible');
        }
        if (!payload?.pageKey) {
          throw new Error('desktopWindow:open requiere pageKey');
        }
        return deps.desktopWindows.open(payload);
      },
    ),
    'desktopWindow:close': unguarded(
      deps,
      async (payload: { windowKey: string }): Promise<{ closed: boolean }> => {
        if (!deps.desktopWindows) throw new Error('Gestor de ventanas no disponible');
        return { closed: deps.desktopWindows.close(payload?.windowKey ?? '') };
      },
    ),
    'desktopWindow:focus': unguarded(
      deps,
      async (payload: { windowKey: string }): Promise<{ focused: boolean }> => {
        if (!deps.desktopWindows) throw new Error('Gestor de ventanas no disponible');
        return { focused: deps.desktopWindows.focus(payload?.windowKey ?? '') };
      },
    ),
    'desktopWindow:list': unguarded(
      deps,
      async (): Promise<{ windows: { windowKey: string; title: string; minimized: boolean; focused: boolean }[] }> => {
        if (!deps.desktopWindows) return { windows: [] };
        return { windows: deps.desktopWindows.list() };
      },
    ),
    'desktopWindow:closeSelf': unguarded(
      deps,
      async (_payload, _d, event): Promise<{ closed: boolean }> => {
        if (!deps.desktopWindows || !event) return { closed: false };
        return { closed: deps.desktopWindows.closeForWebContents(event.webContentsId) };
      },
    ),
    'desktopWindow:minimizeSelf': unguarded(
      deps,
      async (_payload, _d, event): Promise<{ minimized: boolean }> => {
        if (!deps.desktopWindows || !event) return { minimized: false };
        return { minimized: deps.desktopWindows.minimizeForWebContents(event.webContentsId) };
      },
    ),
    'desktopWindow:focusMain': unguarded(deps, async (): Promise<{ ok: true }> => {
      deps.desktopWindows?.focusMain();
      return { ok: true };
    }),
  };
}
