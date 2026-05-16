/**
 * Servicio de impresora térmica ESC/POS.
 *
 * Implementación pragmática: armamos los bytes ESC/POS a mano (sin depender de
 * la abstracción USB de node-thermal-printer, que es frágil) y los enviamos
 * según el `kind`:
 *  - 'file'    → append al archivo (útil para tests y debugging).
 *  - 'network' → TCP socket al `ip:port` (típicamente 9100).
 *  - 'usb'     → bulk transfer al endpoint OUT del device, vía paquete `usb`.
 *  - 'system'  → bytes RAW al spooler del SO (CUPS / Windows print spooler)
 *                via `lp -o raw` en macOS/Linux o `@thiagoelg/node-printer`
 *                (opcional, lazy require) en Windows.
 *
 * Si la dep nativa (`usb`) falla al cargar, los métodos degradan a `Error` con
 * `cause`. El caller (renderer) lo convierte en un toast warning y cae a
 * `window.print()`.
 */
import { appendFile, writeFile } from 'node:fs/promises';
import net from 'node:net';

import type {
  CashCloseReportData,
  PrinterConfig,
  PrinterWidth,
  SaleTicketData,
  SystemPrinterInfo,
} from './types';

// ESC/POS bytes
const ESC = 0x1b;
const GS = 0x1d;
const INIT = Buffer.from([ESC, 0x40]); // ESC @
const LF = Buffer.from([0x0a]);
const ALIGN_LEFT = Buffer.from([ESC, 0x61, 0x00]);
const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
const BOLD_ON = Buffer.from([ESC, 0x45, 0x01]);
const BOLD_OFF = Buffer.from([ESC, 0x45, 0x00]);
const DOUBLE_ON = Buffer.from([GS, 0x21, 0x11]); // doble alto y ancho
const DOUBLE_OFF = Buffer.from([GS, 0x21, 0x00]);
const CUT = Buffer.from([GS, 0x56, 0x42, 0x00]); // partial cut
const DRAWER_KICK = Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]); // pin 2, 25ms, 250ms

const CODEPAGE_PC858 = Buffer.from([ESC, 0x74, 0x13]); // page 19 = PC858 Euro

// Paths absolutos de binarios del sistema. Electron en producción NO hereda
// el PATH del shell del usuario en macOS, por lo que `execFile('lpstat', …)`
// falla silenciosamente con ENOENT. Resolver a path absoluto fuerza el lookup
// correcto en /usr/bin (CUPS estándar en macOS y la mayoría de distros Linux).
const LPSTAT_PATH = process.platform === 'darwin' || process.platform === 'linux' ? '/usr/bin/lpstat' : 'lpstat';
const LP_PATH = process.platform === 'darwin' || process.platform === 'linux' ? '/usr/bin/lp' : 'lp';

function widthCols(w: PrinterWidth): number {
  return w === 80 ? 48 : 32;
}

function leftRight(left: string, right: string, cols: number): string {
  if (left.length + right.length + 1 > cols) {
    const avail = cols - right.length - 1;
    return `${left.slice(0, Math.max(0, avail))} ${right}`;
  }
  return `${left}${' '.repeat(cols - left.length - right.length)}${right}`;
}

function center(text: string, cols: number): string {
  if (text.length >= cols) return text.slice(0, cols);
  const padN = Math.floor((cols - text.length) / 2);
  return ' '.repeat(padN) + text;
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export class PrinterService {
  private cfg: PrinterConfig;
  private cols: number;

  constructor(cfg: PrinterConfig) {
    this.cfg = cfg;
    this.cols = widthCols(cfg.width);
  }

  getConfig(): PrinterConfig {
    return this.cfg;
  }

  /**
   * Si la impresora está configurada con `paperFormat: 'A4'`, no podemos
   * mandar ESC/POS — el caller (renderer) tiene que usar `window.print()`.
   * Devuelve `true` cuando el caller debe encargarse.
   */
  isA4(): boolean {
    return this.cfg.paperFormat === 'A4';
  }

  async connect(): Promise<boolean> {
    // Sin estado persistente: la conexión la abrimos por print.
    if (this.cfg.kind === 'file') return true;
    if (this.cfg.kind === 'network') {
      // Probar el socket
      try {
        await this.sendBytes(INIT);
        return true;
      } catch {
        return false;
      }
    }
    if (this.cfg.kind === 'usb') {
      try {
        await this.sendBytes(INIT);
        return true;
      } catch {
        return false;
      }
    }
    if (this.cfg.kind === 'system') {
      // No abrimos canal persistente; el spooler maneja la cola.
      return true;
    }
    return false;
  }

  async disconnect(): Promise<void> {
    // Sin estado persistente.
  }

  /** Envía bytes crudos al device. */
  private async sendBytes(data: Buffer): Promise<void> {
    if (this.cfg.kind === 'file') {
      // Si no existe el archivo, lo crea (writeFile en flag 'a').
      await appendFile(this.cfg.interface, data);
      return;
    }
    if (this.cfg.kind === 'network') {
      const [ip, portStr] = this.cfg.interface.split(':');
      const port = Number(portStr ?? '9100');
      if (!ip) throw new Error('Interface de red inválida; esperado "ip:port"');
      await new Promise<void>((resolve, reject) => {
        const sock = new net.Socket();
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error('Timeout conectando a la impresora de red'));
        }, 5000);
        sock.connect(port, ip, () => {
          clearTimeout(timer);
          sock.write(data, (err) => {
            if (err) {
              sock.destroy();
              reject(err);
              return;
            }
            sock.end();
            resolve();
          });
        });
        sock.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      return;
    }
    if (this.cfg.kind === 'usb') {
      try {
        const usbMod = (await import('usb')) as typeof import('usb');
        const [vidStr, pidStr] = this.cfg.interface.split(':');
        const vid = parseInt(vidStr ?? '', 16) || Number(vidStr) || 0;
        const pid = parseInt(pidStr ?? '', 16) || Number(pidStr) || 0;
        // Soporte ambas variantes de API.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usb: any = usbMod;
        const device = usb.findByIds
          ? usb.findByIds(vid, pid)
          : usb.getDeviceList().find((d: { deviceDescriptor: { idVendor: number; idProduct: number } }) =>
              d.deviceDescriptor.idVendor === vid && d.deviceDescriptor.idProduct === pid,
            );
        if (!device) throw new Error(`Impresora USB ${vid}:${pid} no encontrada`);
        device.open();
        const iface = device.interfaces[0];
        if (iface.isKernelDriverActive && iface.isKernelDriverActive()) {
          try { iface.detachKernelDriver(); } catch { /* ignore */ }
        }
        iface.claim();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outEp = iface.endpoints.find((e: any) => e.direction === 'out');
        if (!outEp) throw new Error('Endpoint OUT no encontrado en la impresora USB');
        await new Promise<void>((resolve, reject) => {
          outEp.transfer(data, (err: Error | null) => (err ? reject(err) : resolve()));
        });
        try { iface.release(true, () => { /* ignore */ }); } catch { /* ignore */ }
        try { device.close(); } catch { /* ignore */ }
      } catch (err) {
        throw new Error('No se pudo enviar a la impresora USB', { cause: err });
      }
      return;
    }
    if (this.cfg.kind === 'system') {
      await PrinterService.sendRawToSystemPrinter(this.cfg.interface, data);
      return;
    }
  }

  /**
   * Envía bytes RAW (ESC/POS) a una impresora ya configurada en el SO.
   *  - macOS/Linux: `lp -d <name> -o raw <tmpFile>` (CUPS).
   *  - Windows: opcionalmente vía `@thiagoelg/node-printer` (lazy require);
   *    si no está instalada, lanza error legible.
   */
  static async sendRawToSystemPrinter(printerName: string, data: Buffer): Promise<void> {
    if (!printerName || !printerName.trim()) {
      throw new Error('Nombre de impresora del sistema vacío');
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const { execFile } = await import('node:child_process');
      const { writeFile: writeTmp, unlink } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tmpFile = join(tmpdir(), `stockflow-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
      await writeTmp(tmpFile, data);
      await new Promise<void>((resolve, reject) => {
        execFile(LP_PATH, ['-d', printerName, '-o', 'raw', tmpFile], (err) => {
          unlink(tmpFile).catch(() => { /* ignore */ });
          if (err) reject(new Error(`No se pudo enviar a la impresora del sistema "${printerName}": ${err.message}`, { cause: err }));
          else resolve();
        });
      });
      return;
    }
    if (process.platform === 'win32') {
      try {
        // Dep opcional — sólo se carga si el usuario la instaló manualmente.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const printerMod: any = await (
          new Function('return import("@thiagoelg/node-printer").catch(() => null)') as () => Promise<unknown>
        )();
        const printer = printerMod?.default ?? printerMod;
        if (printer && typeof printer.printDirect === 'function') {
          await new Promise<void>((resolve, reject) => {
            printer.printDirect({
              data,
              printer: printerName,
              type: 'RAW',
              success: () => resolve(),
              error: (err: Error) => reject(err),
            });
          });
          return;
        }
      } catch (err) {
        throw new Error('Falló la impresión RAW en Windows', { cause: err });
      }
      throw new Error('Impresión RAW en Windows requiere instalar la dependencia opcional @thiagoelg/node-printer');
    }
    throw new Error(`Plataforma no soportada para impresión del sistema: ${process.platform}`);
  }

  /**
   * Enumera impresoras instaladas en el SO.
   *  - macOS/Linux: `lpstat -p -d`.
   *  - Windows: PowerShell `Get-Printer` (fallback a `wmic` legacy).
   */
  static async listSystemPrinters(): Promise<SystemPrinterInfo[]> {
    const { execFile } = await import('node:child_process');
    function run(cmd: string, args: string[]): Promise<string> {
      return new Promise((resolve) => {
        // LANG=C fuerza output en inglés y locale-independent para parseo estable.
        const env = { ...process.env, LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/usr/local/bin:/usr/sbin:/sbin' };
        execFile(cmd, args, { timeout: 5000, env }, (err, stdout) => {
          if (err) resolve('');
          else resolve(stdout || '');
        });
      });
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      // -e devuelve solo nombres, una por línea, sin texto descriptivo localizado.
      const namesOut = await run(LPSTAT_PATH, ['-e']);
      const names = namesOut.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (names.length === 0) return [];
      // Default destination: con LANG=C dice "system default destination: NAME".
      // Como fallback, parseamos cualquier "destination" o "omisión" o "por omisión".
      let defaultName: string | null = null;
      const defOut = await run(LPSTAT_PATH, ['-d']);
      if (defOut) {
        const m = defOut.match(/(?:destination|destino[^:]*):\s*(\S+)/i);
        if (m && m[1]) defaultName = m[1];
      }
      return names.map((name) => ({
        name,
        isDefault: name === defaultName,
      }));
    }
    if (process.platform === 'win32') {
      // Intento 1: PowerShell Get-Printer (JSON)
      const ps = await run('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-Printer | Select-Object Name,Default | ConvertTo-Json -Compress',
      ]);
      if (ps) {
        try {
          const parsed = JSON.parse(ps) as
            | { Name: string; Default?: boolean }
            | { Name: string; Default?: boolean }[];
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          return arr
            .filter((p) => p && typeof p.Name === 'string')
            .map((p) => ({ name: p.Name, isDefault: Boolean(p.Default) }));
        } catch {
          // sigue al fallback
        }
      }
      // Fallback: wmic
      const wmic = await run('wmic', ['printer', 'get', 'Name,Default', '/format:csv']);
      if (!wmic) return [];
      const lines = wmic.split('\n').map((l) => l.trim()).filter(Boolean);
      const out: SystemPrinterInfo[] = [];
      for (const line of lines) {
        // CSV: Node,Default,Name
        const cols = line.split(',');
        if (cols.length < 3) continue;
        if (/^node$/i.test(cols[0] ?? '')) continue;
        const isDefault = /true/i.test(cols[1] ?? '');
        const name = cols[2];
        if (!name) continue;
        out.push({ name, isDefault });
      }
      return out;
    }
    return [];
  }

  /** Permite construir un comprobante completo en memoria y enviarlo de una. */
  private async sendAll(parts: Buffer[]): Promise<void> {
    const buf = Buffer.concat(parts);
    if (this.cfg.kind === 'file') {
      // En modo file, escribimos atómicamente el ticket completo (append).
      await appendFile(this.cfg.interface, buf);
      return;
    }
    await this.sendBytes(buf);
  }

  async printSaleTicket(sale: SaleTicketData): Promise<void> {
    if (this.isA4()) {
      // El renderer debe imprimir vía browser print (window.print()).
      throw new Error('A4_BROWSER_PRINT_REQUIRED');
    }
    const cols = this.cols;
    const parts: Buffer[] = [];
    const push = (s: string) => parts.push(Buffer.from(s, 'latin1'));
    parts.push(INIT, CODEPAGE_PC858);

    parts.push(ALIGN_CENTER, BOLD_ON, DOUBLE_ON);
    push(`${sale.company.name}\n`);
    parts.push(DOUBLE_OFF, BOLD_OFF);
    if (sale.company.cuit) push(`CUIT: ${sale.company.cuit}\n`);
    if (sale.company.address) push(`${sale.company.address}\n`);
    if (sale.company.phone) push(`Tel: ${sale.company.phone}\n`);
    if (sale.company.ingBrutos) push(`IIBB: ${sale.company.ingBrutos}\n`);
    parts.push(LF);

    parts.push(BOLD_ON);
    push(`${center(`COMPROBANTE ${sale.voucherType}  N° ${sale.number}`, cols)}\n`);
    parts.push(BOLD_OFF, ALIGN_LEFT);
    push(`${formatDateTime(sale.createdAt)}\n`);
    if (sale.customer) {
      push(`Cliente: ${sale.customer.name}\n`);
      if (sale.customer.docNumber) push(`Doc: ${sale.customer.docNumber}\n`);
    }
    push(`${'-'.repeat(cols)}\n`);

    for (const l of sale.lines) {
      push(`${l.description.slice(0, cols)}\n`);
      const qtyPart = `${l.quantity} x ${l.unitPrice}`;
      push(`${leftRight(qtyPart, l.total, cols)}\n`);
    }

    push(`${'-'.repeat(cols)}\n`);
    push(`${leftRight('Subtotal', sale.subtotal, cols)}\n`);
    push(`${leftRight('IVA', sale.vatTotal, cols)}\n`);
    parts.push(BOLD_ON, DOUBLE_ON);
    push(`${leftRight('TOTAL', sale.total, Math.floor(cols / 2))}\n`);
    parts.push(DOUBLE_OFF, BOLD_OFF);

    if (sale.accountSale) {
      push(`${center('** CUENTA CORRIENTE **', cols)}\n`);
    } else if (sale.payments.length > 0) {
      push(`${'-'.repeat(cols)}\n`);
      for (const p of sale.payments) push(`${leftRight(p.method, p.amount, cols)}\n`);
    }

    parts.push(LF);
    parts.push(ALIGN_CENTER);
    push('¡Gracias por su compra!\n');
    parts.push(LF, LF, LF, CUT);

    await this.sendAll(parts);
  }

  async printCashCloseReport(report: CashCloseReportData): Promise<void> {
    if (this.isA4()) {
      throw new Error('A4_BROWSER_PRINT_REQUIRED');
    }
    const cols = this.cols;
    const parts: Buffer[] = [];
    const push = (s: string) => parts.push(Buffer.from(s, 'latin1'));
    parts.push(INIT, CODEPAGE_PC858);
    parts.push(ALIGN_CENTER, BOLD_ON, DOUBLE_ON);
    push(`${report.company.name}\n`);
    parts.push(DOUBLE_OFF);
    push(`${center('CIERRE DE CAJA', cols)}\n`);
    parts.push(BOLD_OFF, ALIGN_LEFT);
    push(`${'-'.repeat(cols)}\n`);
    push(`Caja N° ${report.registerNumber}\n`);
    push(`Apertura: ${formatDateTime(report.openDate)}\n`);
    push(`Cierre:   ${formatDateTime(report.closeDate)}\n`);
    push(`${'-'.repeat(cols)}\n`);
    push(`${leftRight('Saldo apertura', report.openingAmount, cols)}\n`);
    push(`${leftRight(`Ventas (${report.salesCount})`, report.salesTotal, cols)}\n`);
    push(`${leftRight('Otros ingresos', report.incomeMovements, cols)}\n`);
    push(`${leftRight('Egresos', report.expenseMovements, cols)}\n`);
    push(`${'-'.repeat(cols)}\n`);
    push('Medios de pago:\n');
    for (const m of report.paymentBreakdown) {
      push(`  ${leftRight(m.method, m.amount, cols - 2)}\n`);
    }
    push(`${'-'.repeat(cols)}\n`);
    parts.push(BOLD_ON);
    push(`${leftRight('Esperado', report.expectedClosing, cols)}\n`);
    push(`${leftRight('Declarado', report.declaredClosing, cols)}\n`);
    push(`${leftRight('Diferencia', report.difference, cols)}\n`);
    parts.push(BOLD_OFF, LF, LF, LF, CUT);
    await this.sendAll(parts);
  }

  async openCashDrawer(): Promise<void> {
    await this.sendBytes(Buffer.concat([INIT, DRAWER_KICK]));
  }

  async testPrint(): Promise<void> {
    if (this.isA4()) {
      throw new Error('A4_BROWSER_PRINT_REQUIRED');
    }
    const cols = this.cols;
    const parts: Buffer[] = [];
    const push = (s: string) => parts.push(Buffer.from(s, 'latin1'));
    parts.push(INIT, CODEPAGE_PC858);
    parts.push(ALIGN_CENTER, BOLD_ON, DOUBLE_ON);
    push('PRUEBA DE IMPRESION\n');
    parts.push(DOUBLE_OFF, BOLD_OFF, ALIGN_LEFT);
    push(`${'-'.repeat(cols)}\n`);
    push('ABCDEFGHIJKLMNOPQRSTUVWXYZ\n');
    push('abcdefghijklmnopqrstuvwxyz\n');
    push('0 1 2 3 4 5 6 7 8 9\n');
    push('Acentos: á é í ó ú ñ Ñ ¿ ¡ €\n');
    push(`Ancho: ${cols} columnas (${this.cfg.width}mm)\n`);
    push(`${'-'.repeat(cols)}\n`);
    parts.push(ALIGN_LEFT);
    push(`${leftRight('Producto Ñoqui', '$ 1.234,56', cols)}\n`);
    push(`${leftRight('IVA 21%', '$    259,26', cols)}\n`);
    parts.push(BOLD_ON);
    push(`${leftRight('TOTAL', '$ 1.493,82', cols)}\n`);
    parts.push(BOLD_OFF);
    push(`${'-'.repeat(cols)}\n`);
    parts.push(ALIGN_CENTER);
    push('Centrado\n');
    parts.push(ALIGN_LEFT);
    push('Izquierda\n');
    push(`${formatDateTime(Date.now())}\n`);
    parts.push(LF, LF, LF, CUT);
    await this.sendAll(parts);
  }

  /** Si la impresora está en kind=file, devuelve la ruta (para los tests). */
  getFilePath(): string | null {
    return this.cfg.kind === 'file' ? this.cfg.interface : null;
  }

  /** Para tests: limpia el archivo si kind=file. */
  async resetFile(): Promise<void> {
    if (this.cfg.kind === 'file') await writeFile(this.cfg.interface, Buffer.alloc(0));
  }
}
