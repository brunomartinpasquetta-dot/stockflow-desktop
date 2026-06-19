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
  /**
   * Nombre EXACTO de la impresora del SO configurada en StockFlow (CUPS).
   * Si se pasa y existe, tiene prioridad sobre la impresora por defecto del
   * sistema. Si no, se cae a `lpstat -d` / `lpstat -e`.
   */
  deviceName?: string;
}

/**
 * Resuelve la ruta ABSOLUTA del binario SumatraPDF (Windows).
 *  - Producción: copiado por electron-builder a `resources/SumatraPDF.exe`
 *    (FUERA del asar → ejecutable). Camino determinístico (extraResources).
 *  - Dev/no empaquetado: el .exe que trae el paquete pdf-to-printer.
 * Devuelve null si no lo encuentra.
 */
async function resolveSumatraExe(): Promise<string | null> {
  const { existsSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  // 1) Producción: resources/SumatraPDF.exe (extraResources, renombrado). Si el
  //    copiado conservó el nombre versionado, escaneamos resources/ igual.
  try {
    const rp = process.resourcesPath;
    if (rp) {
      const fixed = join(rp, 'SumatraPDF.exe');
      if (existsSync(fixed)) return fixed;
      const scan = existsSync(rp) ? readdirSync(rp).find((f) => /sumatra.*\.exe$/i.test(f)) : undefined;
      if (scan) return join(rp, scan);
    }
  } catch {
    /* process.resourcesPath puede no existir fuera de un build empaquetado */
  }
  // 2) Dev: dist del paquete pdf-to-printer.
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const dist = dirname(req.resolve('pdf-to-printer'));
    const exe = existsSync(dist) ? readdirSync(dist).find((f) => /sumatra.*\.exe$/i.test(f)) : undefined;
    if (exe) return join(dist, exe);
  } catch {
    /* noop */
  }
  return null;
}

/**
 * Imprime un PDF en SILENCIO en Windows ejecutando SumatraPDF DIRECTAMENTE con
 * ruta absoluta (`-print-to <printer> -silent` o `-print-to-default -silent`).
 * No depende del asar ni de la resolución interna de pdf-to-printer (que dejaba
 * el .exe inejecutable dentro del asar). Timeout anti-cuelgue.
 */
async function printPdfWithSumatra(exe: string, file: string, printerName?: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const args = printerName
    ? ['-print-to', printerName, '-silent', file]
    : ['-print-to-default', '-silent', file];
  await run(exe, args, { windowsHide: true, timeout: 20_000 });
}

export function buildPrintHandlers(deps: HandlerDeps): HandlerMap {
  return {
    /**
     * DIAGNÓSTICO de impresión (Windows). Devuelve un reporte de texto con todo
     * lo necesario para entender por qué no imprime, SIN abrir DevTools ni buscar
     * archivos de log: impresoras que ve Electron y pdf-to-printer, si encontró
     * SumatraPDF.exe (y en qué ruta — clave para detectar problemas de empaquetado
     * asar), y el resultado REAL de un intento de impresión con el error exacto.
     */
    'print:diagnose': unguarded(deps, async (payload: { deviceName?: string }): Promise<{ report: string }> => {
      const lines: string[] = [];
      const add = (s: string): void => {
        lines.push(s);
      };
      const { BrowserWindow, app } = await import('electron');
      const { writeFile, unlink } = await import('node:fs/promises');
      const { existsSync, readdirSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join, dirname } = await import('node:path');
      const { createRequire } = await import('node:module');

      add(`StockFlow v${app.getVersion()} — diagnóstico de impresión`);
      add(`Plataforma: ${process.platform} ${process.arch} | empaquetado=${app.isPackaged}`);
      add(`Impresora configurada (deviceName): "${payload?.deviceName ?? '(ninguna)'}"`);
      // CLAVE: el camino real de impresión ahora es window.print() + kiosk-printing.
      // Si está ON, la venta/prueba imprime SIN diálogo a la impresora DEFAULT del SO.
      add(`kiosk-printing (impresión directa sin diálogo): ${app.commandLine.hasSwitch('kiosk-printing') ? 'ON' : 'OFF'}`);
      add('');

      const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
      try {
        await win.loadURL(
          'data:text/html,' +
            encodeURIComponent(
              '<html><body style="font-family:sans-serif;padding:10px"><h3>StockFlow</h3><p>PRUEBA DE IMPRESION (diagnostico)</p></body></html>',
            ),
        );

        // 1) Impresoras que ve Electron.
        try {
          const ep = await win.webContents.getPrintersAsync();
          add(`Electron ve ${ep.length} impresora(s):`);
          ep.forEach((p) =>
            add(`  - name="${p.name}" display="${p.displayName}"${(p as { isDefault?: boolean }).isDefault ? ' *default' : ''}`),
          );
        } catch (e) {
          add(`Electron getPrintersAsync ERROR: ${e instanceof Error ? e.message : String(e)}`);
        }
        add('');

        if (process.platform !== 'win32') {
          add('No es Windows → impresión por lp/CUPS (pdf-to-printer no aplica).');
          return { report: lines.join('\n') };
        }

        // 2) Módulo pdf-to-printer + ubicación de SumatraPDF.exe.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ptp: any = null;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ns: any = await import('pdf-to-printer');
          ptp = ns.default ?? ns;
          add('pdf-to-printer: módulo cargado OK');
        } catch (e) {
          add(`pdf-to-printer: NO se pudo cargar: ${e instanceof Error ? e.message : String(e)}`);
        }
        // SECUNDARIO (SumatraPDF): ya NO es el camino principal de impresión —
        // ahora se usa window.print()+kiosk-printing. Se deja como diagnóstico.
        add(`resourcesPath: ${process.resourcesPath}`);
        const sumatraExe = await resolveSumatraExe();
        if (sumatraExe) {
          add(`(secundario) SumatraPDF: ${sumatraExe}`);
        } else {
          add('(secundario) SumatraPDF: no encontrado.');
        }
        // Diagnóstico extra: dónde lo busca pdf-to-printer dentro del paquete.
        try {
          const req = createRequire(import.meta.url);
          const dist = dirname(req.resolve('pdf-to-printer'));
          const exes = existsSync(dist)
            ? readdirSync(dist).filter((f) => /sumatra/i.test(f) && f.toLowerCase().endsWith('.exe'))
            : [];
          add(`(pdf-to-printer dist: ${dist} → ${exes.join(', ') || 'sin .exe'})`);
        } catch {
          /* noop */
        }

        // 3) Impresoras que ve pdf-to-printer.
        if (ptp?.getPrinters) {
          try {
            const pp = (await ptp.getPrinters()) as { name: string }[];
            add(`pdf-to-printer ve ${pp.length} impresora(s): ${pp.map((p) => `"${p.name}"`).join(', ') || '(ninguna)'}`);
          } catch (e) {
            add(`pdf-to-printer getPrinters ERROR: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        add('');

        // 4) Prueba SECUNDARIA (SumatraPDF directo). El camino PRINCIPAL es
        // window.print()+kiosk — esto es sólo para ver si SumatraPDF imprime algo.
        let tmpFile = '';
        try {
          const pdf = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: { width: 58 * 1000, height: 60 * 1000 },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          });
          tmpFile = join(tmpdir(), `stockflow-diag-${process.pid}.pdf`);
          await writeFile(tmpFile, pdf);
          add(`PDF de prueba: ${pdf.length} bytes`);
          if (sumatraExe) {
            try {
              await printPdfWithSumatra(sumatraExe, tmpFile, payload?.deviceName || undefined);
              add(`(secundario) prueba SumatraPDF: ejecutó OK (impresora=${payload?.deviceName ?? 'default del SO'})`);
            } catch (e) {
              add(`(secundario) prueba SumatraPDF: FALLÓ → ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            add('(secundario) prueba SumatraPDF: omitida (no se encontró SumatraPDF.exe).');
          }
        } catch (e) {
          add(`PDF de prueba ERROR: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          if (tmpFile) await unlink(tmpFile).catch(() => undefined);
        }
      } finally {
        try {
          win.destroy();
        } catch {
          /* noop */
        }
      }
      return { report: lines.join('\n') };
    }),

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
        await new Promise<void>((resolve, reject) => {
          // SIN pageSize custom: forzar dimensiones rompe los drivers térmicos
          // genéricos → "basura infinita" (lección del cerebro). Dejamos el papel
          // del driver, igual que el diálogo (window.print), que en esta PC SÍ
          // imprime bien — esto es ese mismo render, pero sin el diálogo.
          wc.print(
            {
              silent: true,
              ...(payload?.deviceName ? { deviceName: payload.deviceName } : {}),
              printBackground: true,
              color: false,
              margins: { marginType: 'none' },
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
     * Impresión automática del ticket SIN diálogo (Feature v0.1.22, robusto v0.1.25).
     *
     * En vez del `webContents.print({ silent:true })` —que con drivers
     * genéricos de CUPS produce basura infinita en térmicas— renderizamos el
     * ticket a un PDF real con `printToPDF()` y se lo mandamos a la impresora
     * vía `lp` (CUPS). CUPS rasteriza ese PDF con el driver real, igual que el
     * diálogo del SO, pero sin diálogo.
     *
     * Resultado:
     *  - `{ printed:true }`  → salió por la impresora.
     *  - `{ printed:false, pdfPath }` → NO hay ninguna impresora → PDF al Escritorio.
     *  - THROW → hay impresora pero falló el render del PDF o `lp` la rechazó.
     *    El renderer cae al diálogo del SO (`window.print()`) para que el
     *    ticket SIEMPRE salga.
     *
     * Loguea cada paso por consola: en el `.app` empaquetado se ven con
     * Console.app filtrando por "StockFlow print".
     */
    'print:ticketAuto': unguarded(
      deps,
      async (
        payload: PrintTicketAutoPayload,
      ): Promise<{ printed: boolean; pdfPath: string | null }> => {
        const { html, widthMm, fileName, deviceName } = payload ?? ({} as PrintTicketAutoPayload);
        const log = (msg: string): void => console.log(`[StockFlow print] ${msg}`);
        if (!html || !fileName) {
          throw new Error('print:ticketAuto requiere html + fileName');
        }
        if (widthMm !== 58 && widthMm !== 80) {
          throw new Error(`Ancho inválido: ${String(widthMm)} (esperado 58 o 80)`);
        }
        const isWindows = process.platform === 'win32';

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
        log(`render PDF (ancho=${widthMm}mm, archivo=${fileName})`);
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

          // Alto del PDF: en Windows lo ajustamos al CONTENIDO (+8mm de feed)
          // para no escupir ~30cm de papel por ticket. En mac/linux dejamos
          // 297mm (lp + el driver cortan al contenido, ya validado).
          let pageHeightMicrons = 297 * 1000;
          if (isWindows) {
            try {
              const px = (await win.webContents.executeJavaScript('document.body.scrollHeight')) as number;
              // 1px @96dpi ≈ 264.58 micrones.
              pageHeightMicrons = Math.max(40 * 1000, Math.round(px * 264.58) + 8 * 1000);
              log(`alto contenido=${px}px → ${Math.round(pageHeightMicrons / 1000)}mm`);
            } catch {
              /* usa el default 297mm */
            }
          }
          // pageSize en MICRONES. Ancho = rollo.
          pdf = await win.webContents.printToPDF({
            printBackground: true,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            pageSize: { width: widthMm * 1000, height: pageHeightMicrons },
          });
          log(`PDF generado: ${pdf.length} bytes`);
        } catch (err) {
          console.error('[StockFlow print] printToPDF falló', err);
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

        // 2a) WINDOWS: imprimir el PDF en SILENCIO ejecutando SumatraPDF DIRECTO
        // con ruta absoluta (copiado a resources/ vía extraResources, FUERA del
        // asar → ejecutable). Reemplaza pdf-to-printer.print(), que dejaba el .exe
        // inejecutable dentro del asar (diagnóstico v0.1.39). Evita los DOS
        // caminos rotos del historial: ESC/POS crudo y webContents.print silent.
        if (isWindows) {
          const tmpFile = join(tmpdir(), `stockflow-${fileName}-${Date.now()}.pdf`);
          await writeFile(tmpFile, pdf);
          try {
            // Resolver el nombre que entiende SumatraPDF (nombre de Windows). Si
            // el guardado no matchea exacto, probamos parcial; si no, default.
            let printerName = deviceName;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ptpNs: any = await import('pdf-to-printer');
              const ptp = ptpNs.default ?? ptpNs;
              const printers = (await ptp.getPrinters()) as { name: string }[];
              log(`impresoras: ${printers.map((p) => p.name).join(' | ') || '(ninguna)'}`);
              if (printerName && !printers.find((p) => p.name === printerName)) {
                const t = printerName;
                const partial = printers.find((p) => p.name.includes(t) || t.includes(p.name));
                printerName = partial?.name ?? printerName;
                log(`deviceName "${t}" no exacto → uso "${printerName}"`);
              }
            } catch (e) {
              log(`getPrinters falló (sigo con el deviceName configurado): ${e instanceof Error ? e.message : String(e)}`);
            }
            const sumatra = await resolveSumatraExe();
            if (!sumatra) throw new Error('no se encontró SumatraPDF.exe (resources/ ni paquete)');
            log(`SumatraPDF: ${sumatra}`);
            await printPdfWithSumatra(sumatra, tmpFile, printerName ?? undefined);
            log(`impresión OK (impresora=${printerName ?? 'default del SO'})`);
            return { printed: true, pdfPath: null };
          } catch (err) {
            console.error('[StockFlow print] impresión Windows falló', err);
            // Lanzamos → el renderer cae al diálogo del SO (no se pierde el ticket).
            throw new Error(`impresión Windows falló: ${err instanceof Error ? err.message : String(err)}`, {
              cause: err,
            });
          } finally {
            unlink(tmpFile).catch(() => {
              /* noop */
            });
          }
        }

        // 2) Resolver la impresora. macOS/Linux vía CUPS.
        const LPSTAT = '/usr/bin/lpstat';
        const LP = '/usr/bin/lp';
        const env = { ...process.env, LANG: 'C', LC_ALL: 'C' };
        const isUnix = process.platform === 'darwin' || process.platform === 'linux';
        let printerName: string | null = null;
        if (isUnix) {
          // 2a) La impresora configurada en StockFlow tiene prioridad: el
          // ticket debe salir por ESA, no por la default del SO (pueden diferir).
          if (deviceName) {
            try {
              await execFileP(LPSTAT, ['-p', deviceName], { env });
              printerName = deviceName;
              log(`impresora configurada OK: ${deviceName}`);
            } catch {
              log(`impresora configurada "${deviceName}" no existe en CUPS — busco default`);
            }
          }
          // 2b) Default del sistema.
          if (!printerName) {
            try {
              const { stdout: dOut } = await execFileP(LPSTAT, ['-d'], { env });
              const m = dOut.match(/:\s*(\S+)/);
              if (m) printerName = m[1] ?? null;
            } catch {
              /* sin default */
            }
          }
          // 2c) Primera impresora disponible.
          if (!printerName) {
            try {
              const { stdout: eOut } = await execFileP(LPSTAT, ['-e'], { env });
              printerName =
                eOut
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)[0] ?? null;
            } catch {
              /* sin impresoras */
            }
          }
        }
        log(`impresora resuelta: ${printerName ?? '(ninguna)'}`);

        // 3a) Hay impresora → imprimir el PDF con lp.
        if (printerName && isUnix) {
          const tmpFile = join(tmpdir(), `stockflow-${fileName}-${Date.now()}.pdf`);
          await writeFile(tmpFile, pdf);
          try {
            // Probamos el media custom del rollo; si el driver lo rechaza,
            // reintentamos con `lp` simple (papel por defecto de la cola).
            const media = `Custom.${widthMm}x297mm`;
            try {
              const { stdout } = await execFileP(
                LP,
                ['-d', printerName, '-o', `media=${media}`, '-o', 'fit-to-page', tmpFile],
                { env },
              );
              log(`lp OK (media=${media}): ${stdout.trim()}`);
              return { printed: true, pdfPath: null };
            } catch (errMedia) {
              log(
                `lp con media falló (${errMedia instanceof Error ? errMedia.message : String(errMedia)}) — reintento simple`,
              );
              const { stdout } = await execFileP(LP, ['-d', printerName, tmpFile], { env });
              log(`lp OK (simple): ${stdout.trim()}`);
              return { printed: true, pdfPath: null };
            }
          } catch (err) {
            // Los dos intentos de lp fallaron. NO guardamos en Escritorio en
            // silencio: lanzamos para que el renderer caiga al diálogo del SO
            // y el ticket salga igual.
            console.error('[StockFlow print] lp falló', err);
            throw new Error(
              `La impresora "${printerName}" rechazó el trabajo: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          } finally {
            unlink(tmpFile).catch(() => {
              /* noop */
            });
          }
        }

        // 3b) No hay NINGUNA impresora (o Windows) → guardar PDF en el Escritorio.
        const desktopPath = join(homedir(), 'Desktop', `${fileName}.pdf`);
        await writeFile(desktopPath, pdf);
        log(`sin impresora → PDF guardado en ${desktopPath}`);
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
