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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { LicenseJwtPayload, LicensePlan, LicenseState, LicenseStatus, TrialInput } from './types';

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

interface TrialResponse extends ActivateResponse {
  tenantName?: string;
  licenseKey?: string;
  /** Fin de la prueba (epoch ms). */
  trialEndsAt?: number;
}

interface HeartbeatResponse {
  jwt: string | null;
  /** Tenant con la suscripción suspendida → la app pasa a sólo-lectura. */
  suspended?: boolean;
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
  /** Nombre del tenant (empresa) cacheado (de la activación o de /api/me). */
  private tenantName: string | null = null;
  /** Nombre del titular/cliente (full_name) cacheado (de /api/me). */
  private clientName: string | null = null;

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
      // Asegurar el dir (en Windows, recién creado, podría no existir todavía).
      mkdirSync(this.userDataDir, { recursive: true });
      const safeStorage = loadSafeStorage();
      const canEncrypt = !!(safeStorage && safeStorage.isEncryptionAvailable());
      let buf: Buffer;
      if (canEncrypt && safeStorage) {
        buf = safeStorage.encryptString(jwt);
      } else {
        buf = Buffer.from(jwt, 'utf8');
      }
      writeFileSync(this.licenseFilePath(), buf);
      console.info(`[license] licencia guardada (safeStorage=${canEncrypt}) en ${this.licenseFilePath()}`);
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

  /**
   * Saca la licencia de ESTA máquina: borra los markers locales (master +
   * `license.dat`) y resetea el estado en runtime → la app vuelve a "sin
   * licencia" (pantalla de Activación), para poder activar otra. NO notifica al
   * cloud: reasignar una licencia cloud a otra PC requiere liberar el machine_id
   * desde el admin del cloud.
   */
  deactivate(): LicenseState {
    for (const f of [this.masterFilePath(), this.licenseFilePath()]) {
      try {
        if (existsSync(f)) rmSync(f);
      } catch (err) {
        console.error('[license] No se pudo borrar', f, err);
      }
    }
    this.runtimeStatus = null;
    this.tenantName = null;
    this.clientName = null;
    const state = this.getState();
    console.info(`[license] licencia desactivada — estado: ${state.status}`);
    return state;
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
        fullName: 'Desarrollo',
        tenantId: 'OWNER',
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
        fullName: this.clientName,
        tenantId: 'OWNER',
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
        fullName: null,
        tenantId: null,
        lastError: 'No hay licencia válida',
      };
    }
    const { ok, payload } = this.verifyJwtOffline(jwt);
    if (!ok || !payload) {
      const expired =
        payload && typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
      // PRUEBA GRATIS con JWT vencido (offline demasiado tiempo): no volvemos a
      // "sin licencia" — sólo-lectura con sus datos a la vista. Si la prueba
      // sigue vigente, la re-activación silenciosa lo renueva al reconectar.
      if (expired && payload?.kind === 'trial' && typeof payload.texp === 'number' && this.runtimeStatus !== 'revoked') {
        const endsAt = payload.texp * 1000;
        const trialOver = endsAt <= Date.now();
        return {
          status: 'readOnly',
          plan: payload.plan ?? null,
          expiresAt: endsAt,
          licenseKey: payload.lk ?? null,
          tenantName: this.tenantName,
          fullName: this.clientName,
          tenantId: payload.tid ?? null,
          trial: true,
          lastError: trialOver
            ? 'Tu prueba gratis de 30 días terminó. Escribinos por WhatsApp para activar tu licencia — tus datos están intactos.'
            : 'No se pudo renovar la prueba (sin conexión). Conectate a internet para seguir operando.',
        };
      }
      return {
        status: this.runtimeStatus === 'revoked' ? 'revoked' : 'unlicensed',
        plan: null,
        expiresAt: payload?.exp != null ? payload.exp * 1000 : null,
        licenseKey: payload?.lk ?? null,
        tenantName: this.tenantName,
        fullName: this.clientName,
        tenantId: payload?.tid ?? null,
        lastError: expired ? 'La licencia expiró. Volvé a conectarte para renovarla.' : 'No hay licencia válida',
      };
    }
    // PRUEBA GRATIS vigente o vencida: el fin de la prueba viaja en `texp`
    // (el `exp` del JWT es corto y se renueva por heartbeat). Vencida →
    // sólo-lectura, incluso sin internet.
    if (payload.kind === 'trial' && typeof payload.texp === 'number') {
      const endsAt = payload.texp * 1000;
      const trialOver = endsAt <= Date.now();
      return {
        status: trialOver ? 'readOnly' : (this.runtimeStatus ?? 'active'),
        plan: payload.plan,
        expiresAt: endsAt,
        licenseKey: payload.lk,
        tenantName: this.tenantName,
        fullName: this.clientName,
        tenantId: payload.tid,
        trial: true,
        lastError: trialOver
          ? 'Tu prueba gratis de 30 días terminó. Escribinos por WhatsApp para activar tu licencia — tus datos están intactos.'
          : null,
      };
    }
    return {
      status: this.runtimeStatus ?? 'active',
      plan: payload.plan,
      expiresAt: payload.exp * 1000,
      licenseKey: payload.lk,
      tenantName: this.tenantName,
      fullName: this.clientName,
      tenantId: payload.tid,
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
    const key = licenseKey.trim();
    const isMaster = key.toUpperCase() === 'SF-BRUN-OWNR-MSTR-2026';
    console.info(`[license] activando key=${key.slice(0, 7)}… master=${isMaster}`);
    // Clave maestra del owner: licencia 'pro' válida indefinidamente, sin cloud.
    // Persiste vía archivo marker (license.master) en userData. NO usa safeStorage
    // (la disponibilidad de safeStorage es irrelevante para la master key).
    if (isMaster) {
      try {
        // En Windows el userData puede no existir aún en el primer arranque.
        mkdirSync(this.userDataDir, { recursive: true });
        writeFileSync(this.masterFilePath(), `Master license — activada ${new Date().toISOString()}\n`);
        console.info(
          `[license] master license persistida en ${this.masterFilePath()} (existe=${existsSync(
            this.masterFilePath(),
          )})`,
        );
      } catch (err) {
        console.error('[license] No se pudo persistir la master license:', err);
      }
      this.tenantName = 'Bruno Pasquetta — Master';
      const state = this.getState();
      console.info(`[license] estado tras activar master: ${state.status}`);
      return state;
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
        fullName: null,
        tenantId: null,
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
        fullName: null,
        tenantId: null,
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

  /**
   * PRUEBA GRATIS autoservicio: pide al cloud una licencia trial de 30 días
   * para ESTA máquina (una sola por computadora, para siempre) y la deja
   * activada. No requiere clave: solo nombre, comercio y WhatsApp.
   */
  async activateTrial(input: TrialInput): Promise<LicenseState> {
    console.info('[license] creando prueba gratis de 30 días…');
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/api/licenses/trial`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          machineId: this.machineId,
          fullName: input.fullName,
          companyName: input.companyName,
          phone: input.phone,
        }),
      });
    } catch {
      const base = this.getState();
      return { ...base, lastError: 'No se pudo conectar con el servidor. Revisá tu internet y probá de nuevo.' };
    }

    if (!res.ok) {
      let serverMsg: string | undefined;
      try {
        serverMsg = ((await res.json()) as { error?: string })?.error;
      } catch {
        serverMsg = undefined;
      }
      const base = this.getState();
      return {
        ...base,
        lastError: serverMsg && serverMsg.trim().length > 0 ? serverMsg : 'No se pudo crear la prueba gratis. Probá de nuevo en un rato.',
      };
    }

    let data: TrialResponse;
    try {
      data = (await res.json()) as TrialResponse;
    } catch {
      const base = this.getState();
      return { ...base, lastError: 'Respuesta inválida del servidor de licencias.' };
    }

    this.storeJwt(data.jwt);
    this.runtimeStatus = 'active';
    if (data.tenantName) this.tenantName = data.tenantName;
    this.clientName = input.fullName;
    console.info(`[license] prueba gratis activada (key=${(data.licenseKey ?? '').slice(0, 7)}…, vence=${data.trialEndsAt ? new Date(data.trialEndsAt).toISOString() : '?'})`);
    return this.getState();
  }

  /**
   * Re-activación AUTOMÁTICA (sin intervención del usuario). Si el JWT guardado
   * venció —la app estuvo cerrada/offline más que su vigencia de 7 días— pero
   * conocemos la clave (viaja dentro del propio JWT, campo `lk`), re-activamos
   * contra el cloud usando esa clave + el `machineId` YA vinculado. Como el
   * machineId coincide con el de la licencia, el cloud devuelve un JWT nuevo sin
   * pedir nada: la licencia "queda fija" entre reinicios y updates.
   *
   * No-op si: no hay JWT, el JWT sigue válido, es master, el JWT está corrupto/
   * con firma inválida (no re-activamos a ciegas), o estamos offline (se deja como
   * está y se reintenta en el próximo arranque/heartbeat). Devuelve true si renovó.
   */
  async attemptSilentReactivation(): Promise<boolean> {
    if (this.hasMasterLicense()) return false;
    const jwt = this.readStoredJwt();
    if (!jwt) return false;
    const { ok, payload } = this.verifyJwtOffline(jwt);
    if (ok) return false; // todavía válido, nada que renovar
    const expired = !!payload && typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
    const key = payload?.lk;
    // Sólo re-activamos si el motivo del rechazo es EXPIRACIÓN y tenemos la clave.
    if (!expired || !key) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/licenses/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ licenseKey: key, machineId: this.machineId }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // 403 (revocada/suspendida/cancelada) / 404 / 409: NO renovamos en silencio
        // → cae al flujo normal (pantalla de activación / estado revocado).
        console.warn(`[license] re-activación automática rechazada (HTTP ${res.status})`);
        return false;
      }
      const data = (await res.json()) as ActivateResponse;
      this.storeJwt(data.jwt);
      this.runtimeStatus = 'active';
      await this.fetchTenantName(data.jwt);
      console.info('[license] re-activación automática OK — licencia renovada con la clave guardada');
      return true;
    } catch {
      return false; // offline / abort: queda como está, se reintenta luego
    }
  }

  /* ------------------------------------------------------------------ */
  /* Heartbeat                                                           */
  /* ------------------------------------------------------------------ */

  async heartbeat(): Promise<void> {
    try {
      let jwt = this.readStoredJwt();
      if (!jwt) return;

      // Si el token venció (offline > vigencia), renovarlo solo con la clave
      // guardada ANTES de mandar el heartbeat: un JWT vencido daría 401 = revoked.
      if (!this.verifyJwtOffline(jwt).ok) {
        const renewed = await this.attemptSilentReactivation();
        if (!renewed) return; // sigue vencido (offline/rechazado): no mandar token muerto
        jwt = this.readStoredJwt() ?? jwt;
      }

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
        // Suscripción suspendida (cloud devuelve 200 + suspended:true): la app
        // sigue abierta pero en sólo-lectura. Si no, opera normal.
        this.runtimeStatus = data?.suspended === true ? 'readOnly' : 'active';
        // Auto-cura: si no tenemos el nombre de la empresa/titular (p.ej. la
        // activación trajo el JWT pero /api/me falló esa vez), lo traemos ahora.
        if (!this.tenantName || !this.clientName) {
          const freshJwt = data && typeof data.jwt === 'string' && data.jwt.length > 0 ? data.jwt : jwt;
          await this.fetchTenantName(freshJwt);
        }
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
      const body = (await res.json()) as { tenant?: { name?: string; fullName?: string } };
      if (body?.tenant?.name) this.tenantName = body.tenant.name;
      if (body?.tenant?.fullName) this.clientName = body.tenant.fullName;
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
    this.clientName = null;
  }
}
