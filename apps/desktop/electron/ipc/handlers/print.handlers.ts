/**
 * Impresión silenciosa (Feature v0.1.13).
 *
 * Renderiza el HTML del ticket en una `BrowserWindow` oculta y lo manda a la
 * impresora vía `webContents.print({ silent:true, deviceName })`, evitando el
 * dialog del SO. El renderer construye el HTML completo (con el CSS inlineado);
 * acá sólo cargamos el data URL y le pegamos un print sincrónico.
 *
 * Si la impresora rechaza o falla el spooler, devolvemos error y el frontend
 * cae al flujo con dialog (`window.print()`).
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';

interface SilentPrintPayload {
  html: string;
  deviceName: string;
  widthMm: 58 | 80;
}

export function buildPrintHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'print:silent': unguarded(deps, async (payload: SilentPrintPayload): Promise<{ ok: true }> => {
      const { html, deviceName, widthMm } = payload ?? ({} as SilentPrintPayload);
      if (!html || !deviceName) {
        throw new Error('print:silent requiere html + deviceName');
      }
      if (widthMm !== 58 && widthMm !== 80) {
        throw new Error(`Ancho inválido: ${String(widthMm)} (esperado 58 o 80)`);
      }

      // Carga perezosa: el smoke test corre con `tsx` sobre Node y no tiene
      // el binding nativo de Electron. Importar acá adentro hace que el módulo
      // se cargue sólo cuando se invoca el canal en el runtime Electron real.
      const { BrowserWindow } = await import('electron');
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          // Sin JS — sólo render del HTML inline (el CSS @media print se aplica solo).
          javascript: false,
        },
      });

      try {
        const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
        await win.loadURL(dataUrl);
        // Damos un frame extra para que el layout @media print quede aplicado.
        await new Promise<void>((r) => setTimeout(r, 120));

        await new Promise<void>((resolve, reject) => {
          win.webContents.print(
            {
              silent: true,
              deviceName,
              printBackground: false,
              color: false,
              margins: { marginType: 'none' },
              pageSize: {
                // Electron usa micrones para pageSize custom.
                width: widthMm * 1000,
                // Alto generoso: el driver térmico corta cuando vuelve el roll.
                height: 600 * 1000,
              },
              scaleFactor: 100,
              copies: 1,
            },
            (success: boolean, failureReason?: string) => {
              if (success) resolve();
              else reject(new Error(failureReason || 'Print failed'));
            },
          );
        });

        return { ok: true };
      } finally {
        try {
          win.destroy();
        } catch {
          /* noop */
        }
      }
    }),
  };
}
