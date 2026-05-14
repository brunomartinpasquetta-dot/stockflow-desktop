/**
 * Cliente de licencias del desktop.
 *
 * Responsabilidades:
 *  - Activar una licencia contra el cloud (`POST /api/licenses/activate`).
 *  - Persistir el JWT de licencia cifrado (Electron `safeStorage`, con fallback
 *    a texto plano si el cifrado no está disponible).
 *  - Validar el JWT OFFLINE con la clave pública RS256 embebida (en dev, sin
 *    clave, se confía en el JWT decodificándolo sin verificar la firma).
 *  - Heartbeat periódico (`POST /api/licenses/heartbeat`) para refrescar el token
 *    y detectar revocaciones. Tolerante a estar offline (el JWT vale ~7 días).
 *
 * Diseñado para ser unit-testeable fuera de Electron: el acceso a `safeStorage`
 * es lazy y va envuelto en try/catch (fallback a I/O de texto plano), y la
 * verificación del JWT se expone como `static parseAndVerify(...)`.
 */
import { createVerify } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { LicenseJwtPayload, LicensePlan, LicenseState, LicenseStatus } from './types';

interface LicenseManagerOptions {
  userDataDir: string;
  machineId: string;
  apiUrl: string;
  publicKeyPem: string;
}

interface ActivateResponse {
  jwt: string;
  expiresAt: number;
  plan: LicensePlan;
}

interface HeartbeatResponse {
  jwt: string | null;
}

function b64urlToBuffer(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Intenta cargar `safeStorage` de Electron; null fuera de Electron. */
function loadSafeStorage(): typeof import('electron').safeStorage | null {
  try {
    const req = createRequire(import.meta.url);
    const electron = req('electron') as unknown;
    if (
      electron &&
      typeof electron === 'object' &&
      'safeStorage' in electron &&
      electron.safeStorage &&
      typeof (electron.safeStorage as { isEncryptionAvailable?: unknown }).isEncryptionAvailable ===
        'function'
    ) {
      return electron.safeStorage as typeof import('electron').safeStorage;
    }
    return null;
  } catch {
    return null;
  }
}

export class LicenseManager {
  private readonly userDataDir: string;
  private readonly machineId: string;
  private readonly apiUrl: string;
  private readonly publicKeyPem: string;

  /** Estado en runtime impuesto por el heartbeat (revocada / suspendida). */
  private runtimeStatus: LicenseStatus | null = null;
  /** Nombre del tenant cacheado (de la activación o de /api/me). */
  private tenantName: string | null = null;

  constructor(opts: LicenseManagerOptions) {
    this.userDataDir = opts.userDataDir;
    this.machineId = opts.machineId;
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
    this.publicKeyPem = opts.publicKeyPem ?? '';
  }

  /* ------------------------------------------------------------------ */
  /* Verificación offline del JWT (pura, testeable)                       */
  /* ------------------------------------------------------------------ */

  static parseAndVerify(
    jwt: string,
    publicKeyPem: string,
  ): { ok: boolean; payload: LicenseJwtPayload | null } {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return { ok: false, payload: null };
      const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

      let payload: LicenseJwtPayload;
      try {
        payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8')) as LicenseJwtPayload;
      } catch {
        return { ok: false, payload: null };
      }

      // Firma: sólo si hay clave pública embebida (en dev puede estar vacía).
      if (publicKeyPem && publicKeyPem.trim().length > 0) {
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${headerB64}.${payloadB64}`);
        verifier.end();
        let sigOk = false;
        try {
          sigOk = verifier.verify(publicKeyPem, b64urlToBuffer(sigB64));
        } catch {
          sigOk = false;
        }
        if (!sigOk) return { ok: false, payload: null };
      }

      // Expiración.
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) {
        return { ok: false, payload };
      }
      return { ok: true, payload };
    } catch {
      return { ok: false, payload: null };
    }
  }

  private verifyJwtOffline(jwt: string): { ok: boolean; payload: LicenseJwtPayload | null } {
    return LicenseManager.parseAndVerify(jwt, this.publicKeyPem);
  }

  /* ------------------------------------------------------------------ */
  /* Persistencia del JWT                                                */
  /* ------------------------------------------------------------------ */

  private licenseFilePath(): string {
    return path.join(this.userDataDir, 'license.dat');
  }

  private masterFilePath(): string {
    return path.join(this.userDataDir, 'license.master');
  }

  private hasMasterLicense(): boolean {
    return existsSync(this.masterFilePath());
  }

  private storeJwt(jwt: string): void {
    try {
      const safeStorage = loadSafeStorage();
      let buf: Buffer;
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        buf = safeStorage.encryptString(jwt);
      } else {
        buf = Buffer.from(jwt, 'utf8');
      }
      writeFileSync(this.licenseFilePath(), buf);
    } catch (err) {
      console.error('[license] No se pudo guardar la licencia:', err);
    }
  }

  private readStoredJwt(): string | null {
    try {
      const file = this.licenseFilePath();
      if (!existsSync(file)) return null;
      const buf = readFileSync(file);
      const safeStorage = loadSafeStorage();
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        try {
          return safeStorage.decryptString(buf);
        } catch {
          // Puede ser un archivo en texto plano de una corrida anterior.
          const txt = buf.toString('utf8');
          return txt.split('.').length === 3 ? txt : null;
        }
      }
      return buf.toString('utf8');
    } catch (err) {
      console.error('[license] No se pudo leer la licencia:', err);
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Estado                                                              */
  /* ------------------------------------------------------------------ */

  getState(): LicenseState {
    // En modo desarrollo, bypass: licencia 'pro' válida sin tocar license.dat.
    // En producción (.app empaquetado) NODE_ENV no es 'development' → flujo normal.
    if (process.env.NODE_ENV === 'development') {
      return {
        status: 'active',
        plan: 'pro',
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        licenseKey: 'SF-DEV0-DEV0-DEV0-DEV0',
        tenantName: 'Desarrollo',
        lastError: null,
      };
    }
    // Master license del owner: file marker → licencia 'pro' indefinida sin cloud.
    if (this.hasMasterLicense()) {
      return {
        status: 'active',
        plan: 'pro',
        expiresAt: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
        licenseKey: 'SF-BRUN-OWNR-MSTR-2026',
        tenantName: this.tenantName ?? 'Bruno Pasquetta — Master',
        lastError: null,
      };
    }
    const jwt = this.readStoredJwt();
    if (!jwt) {
      return {
        status: 'unlicensed',
        plan: null,
        expiresAt: null,
        licenseKey: null,
        tenantName: null,
        lastError: 'No hay licencia válida',
      };
    }
    const { ok, payload } = this.verifyJwtOffline(jwt);
    if (!ok || !payload) {
      const expired =
        payload && typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
      return {
        status: this.runtimeStatus === 'revoked' ? 'revoked' : 'unlicensed',
        plan: null,
        expiresAt: payload?.exp != null ? payload.exp * 1000 : null,
        licenseKey: payload?.lk ?? null,
        tenantName: this.tenantName,
        lastError: expired ? 'La licencia expiró. Volvé a conectarte para renovarla.' : 'No hay licencia válida',
      };
    }
    return {
      status: this.runtimeStatus ?? 'active',
      plan: payload.plan,
      expiresAt: payload.exp * 1000,
      licenseKey: payload.lk,
      tenantName: this.tenantName,
      lastError: null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Activación                                                          */
  /* ------------------------------------------------------------------ */

  private translateActivateError(status: number, serverMsg: string | undefined): string {
    if (status === 409) return 'Licencia ya activada en otra PC. Contactá soporte.';
    if (serverMsg && serverMsg.trim().length > 0) return serverMsg;
    if (status === 404) return 'Licencia no encontrada. Revisá la clave.';
    if (status === 403) return 'La licencia no está habilitada (revocada, suspendida o pendiente).';
    return 'No se pudo activar la licencia.';
  }

  async activate(licenseKey: string): Promise<LicenseState> {
    // Clave maestra del owner: licencia 'pro' válida indefinidamente, sin cloud.
    // Persiste vía archivo marker (license.master) en userData.
    if (licenseKey.trim().toUpperCase() === 'SF-BRUN-OWNR-MSTR-2026') {
      try {
        writeFileSync(this.masterFilePath(), `Master license — activada ${new Date().toISOString()}\n`);
      } catch (err) {
        console.error('[license] No se pudo persistir la master license:', err);
      }
      this.tenantName = 'Bruno Pasquetta — Master';
      return this.getState();
    }
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/api/licenses/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ licenseKey, machineId: this.machineId }),
      });
    } catch {
      // Sin licencia previa válida en este flujo: reportamos el error de red.
      const base = this.getState();
      return { ...base, lastError: 'No se pudo conectar con el servidor de licencias. Probá más tarde.' };
    }

    if (!res.ok) {
      let serverMsg: string | undefined;
      try {
        const body = (await res.json()) as { error?: string };
        serverMsg = body?.error;
      } catch {
        serverMsg = undefined;
      }
      return {
        status: 'unlicensed',
        plan: null,
        expiresAt: null,
        licenseKey: null,
        tenantName: null,
        lastError: this.translateActivateError(res.status, serverMsg),
      };
    }

    let data: ActivateResponse;
    try {
      data = (await res.json()) as ActivateResponse;
    } catch {
      return {
        status: 'unlicensed',
        plan: null,
        expiresAt: null,
        licenseKey: null,
        tenantName: null,
        lastError: 'Respuesta inválida del servidor de licencias.',
      };
    }

    this.storeJwt(data.jwt);
    this.runtimeStatus = 'active';
    // Best-effort: refrescar el nombre del tenant.
    await this.fetchTenantName(data.jwt);
    const state = this.getState();
    return { ...state, plan: data.plan };
  }

  /* ------------------------------------------------------------------ */
  /* Heartbeat                                                           */
  /* ------------------------------------------------------------------ */

  async heartbeat(): Promise<void> {
    try {
      const jwt = this.readStoredJwt();
      if (!jwt) return;

      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/licenses/heartbeat`, {
          method: 'POST',
          headers: { authorization: `Bearer ${jwt}` },
        });
      } catch {
        // Offline: no cambiamos el estado (el JWT offline sigue siendo válido).
        return;
      }

      if (res.status === 401) {
        this.runtimeStatus = 'revoked';
        return;
      }
      if (res.ok) {
        let data: HeartbeatResponse | null = null;
        try {
          data = (await res.json()) as HeartbeatResponse;
        } catch {
          data = null;
        }
        if (data && typeof data.jwt === 'string' && data.jwt.length > 0) {
          this.storeJwt(data.jwt);
        }
        this.runtimeStatus = 'active';
      }
    } catch (err) {
      console.error('[license] heartbeat falló:', err);
    }
  }

  private async fetchTenantName(jwt: string): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/api/me`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { tenant?: { name?: string } };
      if (body?.tenant?.name) this.tenantName = body.tenant.name;
    } catch {
      // best-effort
    }
  }

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */

  clearLicense(): void {
    try {
      const file = this.licenseFilePath();
      if (existsSync(file)) rmSync(file);
    } catch (err) {
      console.error('[license] No se pudo borrar la licencia:', err);
    }
    this.runtimeStatus = null;
    this.tenantName = null;
  }
}
