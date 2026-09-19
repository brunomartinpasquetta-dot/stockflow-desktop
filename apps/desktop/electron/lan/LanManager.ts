/**
 * Gestión del archivo de configuración LAN (`{userData}/lan.json`).
 *
 * Persistencia atómica: escribe a `lan.json.tmp` y luego `rename` para evitar
 * archivos corruptos si el proceso muere a mitad de escritura.
 *
 * En el mismo archivo vive el SECRETO con que el servidor firma las sesiones
 * de las terminales, pero fuera de `LanConfig`: `lan:getConfig` devuelve la
 * config al renderer y el secreto no tiene que salir nunca del proceso main.
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_LAN_PORT, type LanConfig, type LanMode } from './types';

const FILE_NAME = 'lan.json';

/**
 * Claves de lan.json que no son configuración. Cifrado con `safeStorage`
 * (clave del sistema operativo) cuando existe; en texto plano sólo donde no
 * hay Electron (tests) o el SO no ofrece llavero, igual que el secreto de
 * sesión de `bootstrap/session.ts`.
 */
interface SecretoFirma {
  jwtSecretEnc?: string;
  jwtSecret?: string;
}

/** `safeStorage` de Electron, o null fuera de Electron (tsx / tests). */
function cargarSafeStorage(): typeof import('electron').safeStorage | null {
  try {
    const req = createRequire(import.meta.url);
    const electron = req('electron') as unknown;
    if (
      electron &&
      typeof electron === 'object' &&
      'safeStorage' in electron &&
      typeof (electron.safeStorage as { isEncryptionAvailable?: unknown }).isEncryptionAvailable === 'function'
    ) {
      const ss = electron.safeStorage as typeof import('electron').safeStorage;
      return ss.isEncryptionAvailable() ? ss : null;
    }
    return null;
  } catch {
    return null;
  }
}

export class LanManager {
  private readonly filePath: string;
  private cache: LanConfig | null = null;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, FILE_NAME);
  }

  /** true si el archivo lan.json existe (el usuario ya pasó el wizard). */
  isConfigured(): boolean {
    return existsSync(this.filePath);
  }

  private leerArchivo(): Record<string, unknown> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private escribirArchivo(contenido: Record<string, unknown>): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(contenido, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
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
    // El secreto de firma sobrevive a cualquier cambio de config: si se
    // perdiera al guardar, todas las terminales quedarían deslogueadas.
    const { jwtSecretEnc, jwtSecret } = this.leerArchivo() as SecretoFirma;
    this.escribirArchivo({ ...normalized, jwtSecretEnc, jwtSecret });
    this.cache = normalized;
    return normalized;
  }

  /**
   * Secreto con que el servidor firma los JWT de sesión de las terminales.
   * Se genera la primera vez (32 bytes aleatorios) y queda en lan.json. Antes
   * se derivaba del PIN, y el PIN lo conocen todas las terminales: cualquiera
   * podía firmarse una sesión de administrador.
   */
  getOrCreateJwtSecret(): string {
    const guardado = this.leerArchivo() as SecretoFirma;
    const ss = cargarSafeStorage();
    if (ss && guardado.jwtSecretEnc) {
      try {
        return ss.decryptString(Buffer.from(guardado.jwtSecretEnc, 'base64'));
      } catch {
        // blob corrupto o cambió la clave del SO: se regenera abajo.
      }
    } else if (!ss && guardado.jwtSecret) {
      return guardado.jwtSecret;
    }
    return this.rotateJwtSecret();
  }

  /**
   * Cambia el secreto de firma: todas las sesiones de terminal emitidas hasta
   * ahora dejan de valer. Se llama al rotar el PIN.
   */
  rotateJwtSecret(): string {
    const fresco = crypto.randomBytes(32).toString('hex');
    const ss = cargarSafeStorage();
    const actual = this.leerArchivo();
    delete actual.jwtSecretEnc;
    delete actual.jwtSecret;
    if (ss) actual.jwtSecretEnc = ss.encryptString(fresco).toString('base64');
    else actual.jwtSecret = fresco;
    this.escribirArchivo(actual);
    return fresco;
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
