/**
 * Servicio de balanza serial (RS232 o USB-Serial).
 *
 * Soporta dos modos:
 *  - 'continuous': la balanza emite continuamente. Cada línea recibida se
 *    parsea y se emite por los callbacks registrados.
 *  - 'request': el caller pide una lectura con `requestWeight()`. Se envía el
 *    comando del protocolo y se espera UNA respuesta (timeout 2s).
 *
 * Lazy import de `serialport` y `@serialport/parser-readline` para no fallar el
 * arranque si la dep nativa no está disponible.
 */
import type { ScaleConfig, ScaleProtocol, SerialPortInfo, WeightReading } from './types';

type WeightCallback = (reading: WeightReading) => void;
// Tipos mínimos para no depender estáticamente del módulo.
interface SerialPortInstance {
  on: (ev: string, cb: (...args: unknown[]) => void) => void;
  write: (data: string | Buffer, cb?: (err?: Error | null) => void) => void;
  close: (cb?: (err?: Error | null) => void) => void;
  pipe: <T>(parser: T) => T;
  isOpen: boolean;
}

interface ParserInstance {
  on: (ev: 'data', cb: (line: string) => void) => void;
  removeListener: (ev: 'data', cb: (line: string) => void) => void;
}

function commandFor(protocol: ScaleProtocol): string | Buffer {
  switch (protocol) {
    case 'kretz': return 'P\r\n';
    case 'systel': return Buffer.from([0x05]);
    case 'magris': return 'K\r';
    case 'generic': return 'P\r\n';
  }
}

function parseLine(protocol: ScaleProtocol, raw: string): WeightReading {
  const trimmed = raw.trim();
  let match: RegExpMatchArray | null;
  switch (protocol) {
    case 'kretz': {
      match = trimmed.match(/(ST|US)[,\s]+(GS|NT)[,\s]+(\d+[.,]\d+)\s*kg/i);
      if (match) {
        const value = match[3]!.replace(',', '.');
        return { value: Number(value).toFixed(3), unit: 'kg', stable: match[1]!.toUpperCase() === 'ST', raw };
      }
      break;
    }
    case 'systel': {
      match = trimmed.match(/S\s+(\d+[.,]\d+)\s*kg/i);
      if (match) {
        const value = match[1]!.replace(',', '.');
        return { value: Number(value).toFixed(3), unit: 'kg', stable: true, raw };
      }
      break;
    }
    case 'magris': {
      match = trimmed.match(/(\d+)\s*g/i);
      if (match) {
        const grams = parseInt(match[1]!, 10);
        return { value: (grams / 1000).toFixed(3), unit: 'kg', stable: true, raw };
      }
      break;
    }
    case 'generic': {
      match = trimmed.match(/(\d+[.,]\d+)\s*(kg|g)/i);
      if (match) {
        const v = parseFloat(match[1]!.replace(',', '.'));
        const unit = (match[2] ?? 'kg').toLowerCase();
        return { value: (unit === 'g' ? v / 1000 : v).toFixed(3), unit: 'kg', stable: true, raw };
      }
      break;
    }
  }
  return { value: '0.000', unit: 'kg', stable: false, raw };
}

export class ScaleService {
  private cfg: ScaleConfig;
  private port: SerialPortInstance | null = null;
  private parser: ParserInstance | null = null;
  private listeners: WeightCallback[] = [];
  private dataHandler: ((line: string) => void) | null = null;

  constructor(cfg: ScaleConfig) {
    this.cfg = cfg;
  }

  getConfig(): ScaleConfig {
    return this.cfg;
  }

  async connect(): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spMod: any = await import('serialport');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rlMod: any = await import('@serialport/parser-readline');
      const SerialPort = spMod.SerialPort ?? spMod.default ?? spMod;
      const ReadlineParser = rlMod.ReadlineParser ?? rlMod.default ?? rlMod;
      this.port = new SerialPort({ path: this.cfg.portPath, baudRate: this.cfg.baudRate }) as SerialPortInstance;
      this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\r\n' }) as ParserInstance);
      if (this.cfg.mode === 'continuous') {
        this.dataHandler = (line: string) => {
          const reading = parseLine(this.cfg.protocol, line);
          for (const cb of this.listeners) cb(reading);
        };
        this.parser?.on('data', this.dataHandler);
      }
      return true;
    } catch (err) {
      throw new Error('No se pudo conectar a la balanza', { cause: err });
    }
  }

  async disconnect(): Promise<void> {
    if (this.port && this.port.isOpen) {
      await new Promise<void>((resolve) => {
        this.port?.close(() => resolve());
      });
    }
    this.port = null;
    this.parser = null;
    this.listeners = [];
    this.dataHandler = null;
  }

  onWeight(cb: WeightCallback): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  async requestWeight(): Promise<WeightReading> {
    if (!this.port || !this.parser) {
      throw new Error('Balanza no conectada');
    }
    const cmd = commandFor(this.cfg.protocol);
    const parser = this.parser;
    const port = this.port;
    return new Promise<WeightReading>((resolve, reject) => {
      const timeout = setTimeout(() => {
        parser.removeListener('data', onData);
        reject(new Error('Timeout leyendo la balanza'));
      }, 2000);
      const onData = (line: string): void => {
        clearTimeout(timeout);
        parser.removeListener('data', onData);
        resolve(parseLine(this.cfg.protocol, line));
      };
      parser.on('data', onData);
      port.write(cmd, (err) => {
        if (err) {
          clearTimeout(timeout);
          parser.removeListener('data', onData);
          reject(new Error('Error escribiendo a la balanza', { cause: err }));
        }
      });
    });
  }

  static async listPorts(): Promise<SerialPortInfo[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spMod: any = await import('serialport');
      const SerialPort = spMod.SerialPort ?? spMod.default ?? spMod;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: any[] = await SerialPort.list();
      return list.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        vendorId: p.vendorId,
        productId: p.productId,
      }));
    } catch {
      return [];
    }
  }
}
