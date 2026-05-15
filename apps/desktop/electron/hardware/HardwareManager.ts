/**
 * Singleton que orquesta la configuración de hardware y expone instancias de
 * PrinterService / ScaleService. Persiste la config en `${userDataDir}/hardware.json`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { PrinterService } from './PrinterService';
import { ScaleService } from './ScaleService';
import type {
  BackupConfig,
  HardwareConfigFile,
  PrinterConfig,
  ScaleConfig,
  SerialPortInfo,
  SystemPrinterInfo,
  UsbDeviceInfo,
  WeightReading,
} from './types';

type Emitter = (channel: string, payload: unknown) => void;

export class HardwareManager {
  private configPath: string;
  private cfg: HardwareConfigFile;
  private printer: PrinterService | null = null;
  private scale: ScaleService | null = null;
  private emitter: Emitter | null = null;
  private scaleUnsub: (() => void) | null = null;

  constructor(opts: { userDataDir: string }) {
    this.configPath = path.join(opts.userDataDir, 'hardware.json');
    this.cfg = this.loadOrDefaults(opts.userDataDir);
    if (this.cfg.printer) this.printer = new PrinterService(this.cfg.printer);
    if (this.cfg.scale) this.tryInitScale();
  }

  private loadOrDefaults(userDataDir: string): HardwareConfigFile {
    const defaults: HardwareConfigFile = {
      printer: null,
      scale: null,
      backup: {
        destination: path.join(userDataDir, 'backups'),
        autoOnCashClose: true,
        autoOnAppQuit: true,
      },
    };
    if (!existsSync(this.configPath)) return defaults;
    try {
      const raw = readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<HardwareConfigFile>;
      return {
        printer: parsed.printer ?? null,
        scale: parsed.scale ?? null,
        backup: { ...defaults.backup, ...(parsed.backup ?? {}) },
      };
    } catch {
      return defaults;
    }
  }

  private persistAtomic(): void {
    const dir = path.dirname(this.configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), 'utf8');
    renameSync(tmp, this.configPath);
  }

  setEmitter(emit: Emitter): void {
    this.emitter = emit;
    // Si la balanza ya está conectada en modo continuo, suscribir el emitter.
    this.bindScaleEmitter();
  }

  private bindScaleEmitter(): void {
    if (this.scaleUnsub) {
      this.scaleUnsub();
      this.scaleUnsub = null;
    }
    if (this.scale && this.emitter && this.cfg.scale?.mode === 'continuous') {
      const emit = this.emitter;
      this.scaleUnsub = this.scale.onWeight((reading: WeightReading) => {
        emit('hardware:scale:weight', reading);
      });
    }
  }

  private tryInitScale(): void {
    if (!this.cfg.scale) return;
    this.scale = new ScaleService(this.cfg.scale);
    // Intentar conectar de forma asíncrona: si falla, queda null pero no crashea.
    void this.scale.connect()
      .then(() => this.bindScaleEmitter())
      .catch(() => {
        this.scale = null;
      });
  }

  getConfig(): HardwareConfigFile {
    return this.cfg;
  }

  async setPrinterConfig(cfg: PrinterConfig | null): Promise<void> {
    this.cfg.printer = cfg;
    this.persistAtomic();
    if (this.printer) await this.printer.disconnect();
    this.printer = cfg ? new PrinterService(cfg) : null;
  }

  async setScaleConfig(cfg: ScaleConfig | null): Promise<void> {
    this.cfg.scale = cfg;
    this.persistAtomic();
    if (this.scale) await this.scale.disconnect();
    this.scale = null;
    if (cfg) this.tryInitScale();
  }

  setBackupConfig(cfg: BackupConfig): void {
    this.cfg.backup = cfg;
    this.persistAtomic();
  }

  getPrinter(): PrinterService | null {
    return this.printer;
  }

  getScale(): ScaleService | null {
    return this.scale;
  }

  async listUsbDevices(): Promise<UsbDeviceInfo[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usb: any = await import('usb');
      const list = usb.getDeviceList ? usb.getDeviceList() : usb.default?.getDeviceList?.() ?? [];
      return list.map((d: { deviceDescriptor: { idVendor: number; idProduct: number } }) => ({
        vendorId: d.deviceDescriptor.idVendor,
        productId: d.deviceDescriptor.idProduct,
      }));
    } catch {
      return [];
    }
  }

  async listSerialPorts(): Promise<SerialPortInfo[]> {
    return ScaleService.listPorts();
  }

  async listSystemPrinters(): Promise<SystemPrinterInfo[]> {
    try {
      return await PrinterService.listSystemPrinters();
    } catch {
      return [];
    }
  }
}
