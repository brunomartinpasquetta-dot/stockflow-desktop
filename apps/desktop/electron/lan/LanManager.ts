/**
 * Gestión del archivo de configuración LAN (`{userData}/lan.json`).
 *
 * Persistencia atómica: escribe a `lan.json.tmp` y luego `rename` para evitar
 * archivos corruptos si el proceso muere a mitad de escritura.
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_LAN_PORT, type LanConfig, type LanMode } from './types';

const FILE_NAME = 'lan.json';

export class LanManager {
  private readonly filePath: string;
  private cache: LanConfig | null = null;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, FILE_NAME);
  }

  getConfig(): LanConfig {
    if (this.cache) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { mode: 'single' };
      return this.cache;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LanConfig>;
      const mode: LanMode =
        parsed.mode === 'server' || parsed.mode === 'client' ? parsed.mode : 'single';
      this.cache = {
        mode,
        port: typeof parsed.port === 'number' ? parsed.port : DEFAULT_LAN_PORT,
        token: typeof parsed.token === 'string' ? parsed.token : undefined,
        serverIp: typeof parsed.serverIp === 'string' ? parsed.serverIp : undefined,
        serverPort:
          typeof parsed.serverPort === 'number' ? parsed.serverPort : DEFAULT_LAN_PORT,
      };
      return this.cache;
    } catch {
      this.cache = { mode: 'single' };
      return this.cache;
    }
  }

  setConfig(next: LanConfig): LanConfig {
    const normalized: LanConfig = {
      mode: next.mode,
      port: next.port ?? DEFAULT_LAN_PORT,
      token: next.token,
      serverIp: next.serverIp,
      serverPort: next.serverPort ?? DEFAULT_LAN_PORT,
    };
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
    this.cache = normalized;
    return normalized;
  }

  /** Genera un PIN aleatorio de 6 dígitos (string, conserva ceros a la izquierda). */
  static generatePin(): string {
    const n = crypto.randomInt(0, 1_000_000);
    return String(n).padStart(6, '0');
  }

  /** Primera IPv4 no-loopback (LAN). */
  static getLocalIp(): string | null {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] ?? []) {
        if (info.family === 'IPv4' && !info.internal) return info.address;
      }
    }
    return null;
  }
}
