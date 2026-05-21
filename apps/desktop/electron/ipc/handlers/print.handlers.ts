/**
 * Impresión silenciosa (Feature v0.1.13, patrón canónico v0.1.15).
 *
 * Renderiza el HTML del ticket en una `BrowserWindow` oculta y lo manda a la
 * impresora vía `webContents.print({ silent:true, deviceName })`, evitando el
 * dialog del SO. El renderer construye el HTML completo (con el CSS inlineado);
 * acá sólo cargamos el data URL y le pegamos un print sincrónico.
 *
 * Si la impresora rechaza o falla el spooler, devolvemos error y el frontend
 * cae al flujo con dialog (`window.print()`).
 *
 * `printer:listElectron` enumera impresoras con `webContents.getPrintersAsync()`
 * — devuelve el `deviceName` EXACTO que `webContents.print({ deviceName })`
 * necesita. `lpstat` puede dar nombres que no matchean (espacios vs guiones
 * bajos, etc.) y entonces el print silencioso falla o cae a la default.
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';

interface SilentPrintPayload {
  html: string;
  deviceName: string;
  widthMm: 58 | 80;
}

interface PrintCurrentPayload {
  deviceName?: string;
  widthMm?: number;
}

interface PrintTicketAutoPayload {
  /** Documento HTML completo del ticket (standalone, con CSS inline). */
  html: string;
  /** Ancho del rollo en mm (58 u 80). */
  widthMm: number;
  /** Nombre base del archivo, p.ej. "ticket-venta-B-00000123". */
  fileName: string;
}

export function buildPrintHandlers(deps: HandlerDeps): HandlerMap {
  return {
    /**
     * Imprime la VENTANA ACTUAL (la que disparó el IPC) en silencio, sin
     * abrir el diálogo del SO. El renderer ya montó el ticket en `#print-area`
     * y activó las clases `@media print` — acá sólo imprimimos esa misma
     * ventana con `silent:true`. No re-renderiza nada: misma estructura que
     * `window.print()`, sólo que sin diálogo de vista previa.
     */
    'print:current': unguarded(
      deps,
      async (payload: PrintCurrentPayload, _d, event): Promise<{ ok: true }> => {
        const { webContents } = await import('electron');
        const id = event?.webContentsId;
        if (id == null) throw new Error('print:current sin webContents emisor');
        const wc = webContents.fromId(id);
        if (!wc) throw new Error('webContents no encontrado');
        const widthMm = payload?.widthMm ?? 58;
        await new Promise<void>((resolve, reject) => {
          wc.print(
            {
              silent: true,
              ...(payload?.deviceName ? { deviceName: payload.deviceName } : {}),
              printBackground: true,
              color: false,
              margins: { marginType: 'none' },
              pageSize: { width: widthMm * 1000, height: 297000 },
            },
            (success: boolean, failureReason?: string) => {
              if (success) resolve();
              else reject(new Error(failureReason || 'Print failed'));
            },
          );
        });
        return { ok: true };
      },
    ),

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
        // Esperar el `did-finish-load` explícito: sin el load completo el
        // webContents.print() imprime en blanco.
        await new Promise<void>((resolve) => {
          if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', () => resolve());
          } else {
            resolve();
          }
        });
        // Damos un frame extra para que el layout @media print quede aplicado.
        await new Promise<void>((r) => setTimeout(r, 120));

        await new Promise<void>((resolve, reject) => {
          win.webContents.print(
            {
              silent: true,
              deviceName,
              // Algunas impresoras/drivers necesitan que el fondo blanco se
              // rasterice; sin esto pueden salir tickets vacíos.
              printBackground: true,
              color: false,
              margins: { marginType: 'none' },
              pageSize: {
                // Electron usa micrones para pageSize custom.
                width: widthMm * 1000,
                // Alto A4 (297mm): suficiente, el driver térmico corta donde corresponde.
                height: 297000,
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

    /**
     * Impresión automática del ticket SIN diálogo (Feature v0.1.22).
     *
     * En vez del `webContents.print({ silent:true })` —que con drivers
     * genéricos de CUPS produce basura infinita en térmicas— renderizamos el
     * ticket a un PDF real con `printToPDF()` y se lo mandamos a la impresora
     * vía `lp` (CUPS). CUPS rasteriza ese PDF con el driver real, igual que el
     * diálogo del SO, pero sin diálogo.
     *
     * Si no hay impresora (o `lp` falla, o estamos en Windows), el PDF se
     * guarda en el Escritorio del usuario y se avisa devolviendo `printed:false`.
     */
    'print:ticketAuto': unguarded(
      deps,
      async (
        payload: PrintTicketAutoPayload,
      ): Promise<{ printed: boolean; pdfPath: string | null }> => {
        const { html, widthMm, fileName } = payload ?? ({} as PrintTicketAutoPayload);
        if (!html || !fileName) {
          throw new Error('print:ticketAuto requiere html + fileName');
        }
        if (widthMm !== 58 && widthMm !== 80) {
          throw new Error(`Ancho inválido: ${String(widthMm)} (esperado 58 o 80)`);
        }

        const { BrowserWindow } = await import('electron');
        const { writeFile, unlink } = await import('node:fs/promises');
        const { tmpdir, homedir } = await import('node:os');
        const { join } = await import('node:path');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileP = promisify(execFile);

        // 1) Render del HTML a PDF con una BrowserWindow oculta.
        // NO deshabilitar JS ni usar sandbox: `printToPDF` puede fallar/colgar
        // con `javascript:false`. La ventana sólo carga nuestro HTML de
        // confianza (data URL), sin preload ni scripts → es seguro.
        const win = new BrowserWindow({
          show: false,
          webPreferences: { contextIsolation: true },
        });
        let pdf: Buffer;
        try {
          const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
          await win.loadURL(dataUrl);
          await new Promise<void>((resolve) => {
            if (win.webContents.isLoading()) {
              win.webContents.once('did-finish-load', () => resolve());
            } else {
              resolve();
            }
          });
          // Frame extra para que el layout quede aplicado.
          await new Promise<void>((r) => setTimeout(r, 200));
          // pageSize en MICRONES. Ancho = rollo; alto = 297mm (el driver corta).
          pdf = await win.webContents.printToPDF({
            printBackground: true,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            pageSize: { width: widthMm * 1000, height: 297 * 1000 },
          });
        } catch (err) {
          throw new Error(
            `No se pudo generar el PDF del ticket: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        } finally {
          try {
            win.destroy();
          } catch {
            /* noop */
          }
        }

        // 2) ¿Hay impresora? Resolver vía lpstat (LANG=C). macOS/Linux.
        const LPSTAT = '/usr/bin/lpstat';
        const LP = '/usr/bin/lp';
        const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
        const isUnix = process.platform === 'darwin' || process.platform === 'linux';
        let printerName: string | null = null;
        if (isUnix) {
          try {
            // Impresora por defecto.
            const { stdout: dOut } = await execFileP(LPSTAT, ['-d'], { env });
            const m = dOut.match(/:\s*(\S+)/);
            if (m) printerName = m[1] ?? null;
            if (!printerName) {
              const { stdout: eOut } = await execFileP(LPSTAT, ['-e'], { env });
              printerName =
                eOut
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)[0] ?? null;
            }
          } catch {
            printerName = null;
          }
        }

        // 3a) Hay impresora → imprimir el PDF con lp.
        if (printerName && isUnix) {
          const tmpFile = join(tmpdir(), `stockflow-${fileName}-${Date.now()}.pdf`);
          await writeFile(tmpFile, pdf);
          try {
            // CUPS usa el papel POR DEFECTO de la cola si no le pasamos `-o
            // media`. En las térmicas con rollo custom (48×297mm) ese default
            // NO matchea el tamaño real → el job nunca sale. Le pasamos el
            // media custom explícito: `Custom.{ancho}x297mm` + `fit-to-page`.
            const media = `Custom.${widthMm}x297mm`;
            try {
              await execFileP(
                LP,
                ['-d', printerName, '-o', `media=${media}`, '-o', 'fit-to-page', tmpFile],
                { env },
              );
              return { printed: true, pdfPath: null };
            } catch {
              // Algunas impresoras/drivers rechazan el media Custom. Reintento
              // UNA vez con `lp` simple (usa el papel por defecto de la cola).
              await execFileP(LP, ['-d', printerName, tmpFile], { env });
              return { printed: true, pdfPath: null };
            }
          } catch {
            // Si los dos intentos de lp fallan, caemos al guardado en Escritorio (3b).
          } finally {
            unlink(tmpFile).catch(() => {
              /* noop */
            });
          }
        }

        // 3b) Sin impresora (o lp falló, o Windows) → guardar PDF en el Escritorio.
        const desktopPath = join(homedir(), 'Desktop', `${fileName}.pdf`);
        await writeFile(desktopPath, pdf);
        return { printed: false, pdfPath: desktopPath };
      },
    ),

    /**
     * Lista las impresoras vistas por Electron vía `webContents.getPrintersAsync()`.
     * Es el origen primario para el select de impresoras: el `name` que devuelve
     * es EXACTAMENTE el que `webContents.print({ deviceName })` espera.
     */
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
