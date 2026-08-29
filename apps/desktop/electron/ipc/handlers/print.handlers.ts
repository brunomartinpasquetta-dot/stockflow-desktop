/**
 * Impresión: enumeración de impresoras del SO + diagnóstico.
 *
 * La impresión de tickets en sí NO vive acá: va por **ESC/POS crudo al spooler**
 * del SO (ver `hardware:printer:*` + `PrinterService` + cerebro [[thermal-print]]).
 * El motor de impresión de Electron (`webContents.print`) daba hoja en blanco en
 * térmicas, así que se descartó. Acá sólo queda:
 *  - `printer:listElectron`: enumera impresoras con `webContents.getPrintersAsync()`
 *    (devuelve el nombre EXACTO del SO que se guarda en la config de impresora).
 *  - `print:diagnose`: reporte de texto (impresoras del SO + impresora configurada)
 *    para depurar sin abrir DevTools.
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';

export function buildPrintHandlers(deps: HandlerDeps): HandlerMap {
  return {
    /**
     * Diagnóstico de impresión: reporte de texto con la plataforma, la impresora
     * configurada y las impresoras que ve el SO. La impresión real es ESC/POS al
     * spooler; este reporte sirve para confirmar nombres de impresora.
     */
    'print:diagnose': unguarded(deps, async (payload: { deviceName?: string }): Promise<{ report: string }> => {
      const { BrowserWindow, app } = await import('electron');
      const lines: string[] = [];
      lines.push(`StockFlow v${app.getVersion()} — diagnóstico de impresión`);
      lines.push(`Plataforma: ${process.platform} ${process.arch} | empaquetado=${app.isPackaged}`);
      lines.push(`Impresora configurada (deviceName): "${payload?.deviceName ?? '(ninguna)'}"`);
      lines.push('Camino de impresión: ESC/POS crudo al spooler del SO (silent real).');
      lines.push('');

      const wins = BrowserWindow.getAllWindows();
      let win = wins[0];
      let temp = false;
      if (!win) {
        win = new BrowserWindow({ show: false });
        temp = true;
      }
      try {
        const printers = await win.webContents.getPrintersAsync();
        lines.push(`Impresoras del SO (${printers.length}):`);
        printers.forEach((p) =>
          lines.push(`  - name="${p.name}" display="${p.displayName}"${p.isDefault ? ' *default' : ''}`),
        );
      } catch (e) {
        lines.push(`getPrintersAsync ERROR: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (temp) {
          try {
            win.destroy();
          } catch {
            /* noop */
          }
        }
      }
      return { report: lines.join('\n') };
    }),

    /**
     * Enumera impresoras del SO con `webContents.getPrintersAsync()` — devuelve el
     * `name` EXACTO que la config de impresora necesita (para `kind:'system'`).
     */
    /**
     * Imprime la VENTANA ACTIVA en silencio, directo a la impresora indicada.
     * Lo usa el camino A4 (facturas/reportes): la página ya está en modo
     * impresión (#print-area + @media print), así que sale idéntica al diálogo
     * pero sin diálogo. El precedente de "hoja en blanco" con print() era con
     * TÉRMICAS; para A4 en impresora común funciona, y ante error el renderer
     * cae solo al diálogo de siempre.
     */
    'print:silentCurrent': unguarded(deps, async (payload: { deviceName: string }) => {
      const { webContents } = await import('electron');
      const wc = webContents.getFocusedWebContents();
      if (!wc) throw new Error('No hay una ventana activa para imprimir');
      await new Promise<void>((resolve, reject) => {
        wc.print(
          { silent: true, deviceName: payload.deviceName, printBackground: true },
          (ok, reason) => (ok ? resolve() : reject(new Error(reason || 'La impresora rechazó el trabajo'))),
        );
      });
      return { printed: true };
    }),
    'printer:listElectron': unguarded(
      deps,
      async (): Promise<{ name: string; isDefault: boolean }[]> => {
        const { BrowserWindow } = await import('electron');
        // Necesitamos un webContents. Si hay una ventana, usamos la primera;
        // si no, creamos una oculta temporal.
        const wins = BrowserWindow.getAllWindows();
        let win = wins[0];
        let temp = false;
        if (!win) {
          win = new BrowserWindow({ show: false });
          temp = true;
        }
        try {
          const printers = await win.webContents.getPrintersAsync();
          return printers.map((p) => ({ name: p.name, isDefault: p.isDefault }));
        } finally {
          if (temp) {
            try {
              win.destroy();
            } catch {
              /* noop */
            }
          }
        }
      },
    ),
  };
}
