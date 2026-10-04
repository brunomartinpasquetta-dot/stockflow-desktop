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
  /**
   * Terminal de sucursal emparejada: token de dispositivo que entregó el
   * servidor. Mismo trato que el secreto de firma (cifrado con la clave del
   * SO cuando hay llavero) y nunca sale por `lan:getConfig`.
   */
  dispositivoTokenEnc?: string;
  dispositivoToken?: string;
  /** Opción del comercio "Una caja por PC" (no es secreta, pero sobrevive igual a `setConfig`). */
  cajaPorPc?: boolean;
}

/**
 * Claves de lan.json que no son configuración y sobreviven a `setConfig`.
 * `cajaPorPc` (opción del comercio, ver ipc/caja-por-pc.ts) también: cambiar
 * el PIN o el puerto no tiene por qué apagarla.
 */
const CLAVES_SECRETAS = ['jwtSecretEnc', 'jwtSecret', 'dispositivoTokenEnc', 'dispositivoToken', 'cajaPorPc'] as const;

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
        serverUrl: typeof parsed.serverUrl === 'string' && parsed.serverUrl ? parsed.serverUrl : undefined,
        remotoActivado: parsed.remotoActivado === true,
        remotoHostname:
          typeof parsed.remotoHostname === 'string' ? parsed.remotoHostname : undefined,
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
      serverUrl: next.mode === 'client' && next.serverUrl ? next.serverUrl : undefined,
      remotoActivado: next.remotoActivado === true,
      remotoHostname: next.remotoHostname,
    };
    // El secreto de firma sobrevive a cualquier cambio de config: si se
    // perdiera al guardar, todas las terminales quedarían deslogueadas. El
    // token de PC de sucursal también, salvo que la PC deje de ser terminal.
    const actual = this.leerArchivo() as SecretoFirma;
    const secretos: Record<string, unknown> = {};
    for (const k of CLAVES_SECRETAS) if (actual[k] !== undefined) secretos[k] = actual[k];
    if (normalized.mode !== 'client') {
      delete secretos.dispositivoTokenEnc;
      delete secretos.dispositivoToken;
    }
    this.escribirArchivo({ ...normalized, ...secretos });
    this.cache = normalized;
    return normalized;
  }

  /** Opción "Una caja por PC" (apagada por defecto). Ver ipc/caja-por-pc.ts. */
  getCajaPorPc(): boolean {
    return (this.leerArchivo() as { cajaPorPc?: unknown }).cajaPorPc === true;
  }

  setCajaPorPc(activa: boolean): void {
    const actual = this.leerArchivo() as Record<string, unknown>;
    if (activa) actual.cajaPorPc = true;
    else delete actual.cajaPorPc;
    this.escribirArchivo(actual);
  }

  /**
   * Guarda (o borra, con null) el token de PC de sucursal. Cifrado con
   * `safeStorage` cuando el SO ofrece llavero; en texto plano sólo donde no
   * hay Electron (tests) o llavero, igual que el secreto de firma.
   */
  guardarTokenDispositivo(token: string | null): void {
    const actual = this.leerArchivo();
    delete actual.dispositivoTokenEnc;
    delete actual.dispositivoToken;
    if (token) {
      const ss = cargarSafeStorage();
      if (ss) actual.dispositivoTokenEnc = ss.encryptString(token).toString('base64');
      else actual.dispositivoToken = token;
    }
    this.escribirArchivo(actual);
  }

  /** Token de PC de sucursal guardado, o null. */
  leerTokenDispositivo(): string | null {
    const guardado = this.leerArchivo() as SecretoFirma;
    const ss = cargarSafeStorage();
    if (guardado.dispositivoTokenEnc) {
      if (!ss) return null;
      try {
        return ss.decryptString(Buffer.from(guardado.dispositivoTokenEnc, 'base64'));
      } catch {
        return null; // cambió la clave del SO: hay que emparejar de nuevo
      }
    }
    return typeof guardado.dispositivoToken === 'string' && guardado.dispositivoToken ? guardado.dispositivoToken : null;
  }

  /** ¿Hay un token de PC de sucursal guardado? (sin descifrarlo) */
  tieneTokenDispositivo(): boolean {
    const g = this.leerArchivo() as SecretoFirma;
    return Boolean(g.dispositivoTokenEnc || g.dispositivoToken);
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
