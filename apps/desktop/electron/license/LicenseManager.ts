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

import {
  edicionEfectiva,
  type EntornoEdicion,
  esVersionDePrueba,
  guardarEdicionPrueba,
  interruptorDePruebaActivo,
  leerEdicionPrueba,
  normalizarEdicion,
} from './funciones';
import type { EdicionPruebaEstado, LicenseJwtPayload, LicensePlan, LicenseState, LicenseStatus, TrialInput } from './types';

interface LicenseManagerOptions {
  userDataDir: string;
  machineId: string;
  apiUrl: string;
  publicKeyPem: string;
  /**
   * `app.isPackaged`. Sólo con `false` se admite el override de desarrollo
   * `STOCKFLOW_PLAN=multisucursal` (ver funciones.ts). Por defecto `true`:
   * quien no lo pase (tests, herramientas) nunca activa el override.
   */
  empaquetada?: boolean;
  /**
   * `app.getVersion()`. Sólo con sufijo de prueba (-alpha/-beta/-rc) existe el
   * interruptor "Edición Multisucursal (versión de prueba)" (ver funciones.ts).
   * Sin versión (tests, herramientas) no existe.
   */
  version?: string;
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
  private readonly empaquetada: boolean;
  private readonly version: string | undefined;

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
    this.empaquetada = opts.empaquetada !== false;
    this.version = opts.version;
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

  /**
   * ¿Es la instalación del DUEÑO del sistema (licencia maestra)?
   *
   * Sirve para que la máquina de desarrollo no tenga las fricciones pensadas
   * para un comercio: el ingreso automático y el bloqueo por contraseña débil.
   * Ningún cliente tiene esta licencia, así que nada de esto los alcanza.
   */
  esInstalacionMaestra(): boolean {
    return this.hasMasterLicense();
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
    const estado = this.estadoSegunToken();
    // Edición: la del token (sin claim = común), salvo el override de
    // desarrollo (sólo sin empaquetar) o el interruptor de prueba (sólo en
    // una versión -alpha/-beta/-rc; nunca baja la del token).
    return {
      ...estado,
      edicion: edicionEfectiva(estado.edicion, this.entornoEdicion(true)),
    };
  }

  /**
   * Lo que `edicionEfectiva` necesita de esta PC. El archivo del interruptor
   * se lee SÓLO en una versión de prueba: en una final no se toca el disco y
   * el archivo, exista o no, no cuenta.
   */
  private entornoEdicion(conInterruptor: boolean): EntornoEdicion {
    return {
      empaquetada: this.empaquetada,
      env: process.env,
      version: this.version,
      edicionPrueba: conInterruptor && esVersionDePrueba(this.version) ? leerEdicionPrueba(this.userDataDir) : null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Interruptor "Edición Multisucursal (versión de prueba)"             */
  /* ------------------------------------------------------------------ */

  /** Estado del interruptor de prueba (ver funciones.ts). */
  getEdicionPrueba(): EdicionPruebaEstado {
    const disponible = esVersionDePrueba(this.version);
    const archivo = disponible ? leerEdicionPrueba(this.userDataDir) : null;
    const activa = interruptorDePruebaActivo(this.version, archivo);
    return {
      disponible,
      activa,
      activadaEl: activa ? (archivo?.activadaEl ?? null) : null,
      edicionReal: edicionEfectiva(this.estadoSegunToken().edicion, this.entornoEdicion(false)),
      version: this.version ?? '',
    };
  }

  /**
   * Prende o apaga el interruptor de prueba. Sólo en una versión de prueba:
   * en una final tira, no escribe nada y la edición sigue siendo la del token.
   */
  setEdicionPrueba(activa: boolean): EdicionPruebaEstado {
    if (!esVersionDePrueba(this.version)) {
      throw new Error(
        'La edición Multisucursal de prueba sólo existe en las versiones de prueba. En esta versión la edición la define la licencia.',
      );
    }
    guardarEdicionPrueba(this.userDataDir, activa);
    const estado = this.getEdicionPrueba();
    console.info(`[license] edición de prueba ${estado.activa ? 'activada' : 'desactivada'} (versión ${this.version})`);
    return estado;
  }

  private estadoSegunToken(): LicenseState {
    // En modo desarrollo, bypass: licencia 'pro' válida sin tocar license.dat.
    // SÓLO sin empaquetar: en la app de los clientes, NODE_ENV=development
    // puesto a mano daba una licencia pro sin pasar por el cloud.
    if (process.env.NODE_ENV === 'development' && !this.empaquetada) {
      return {
        status: 'active',
        plan: 'pro',
        expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
        licenseKey: 'SF-DEV0-DEV0-DEV0-DEV0',
        tenantName: 'Desarrollo',
        fullName: 'Desarrollo',
        tenantId: 'OWNER',
        edicion: 'comun',
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
        edicion: 'comun',
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
        edicion: 'comun',
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
          // Firma válida, sólo vencido por estar sin conexión: la edición sigue
          // siendo la que el cloud firmó (en sólo lectura no se escribe igual).
          edicion: normalizarEdicion(payload.edicion),
          lastError: trialOver
            ? 'La prueba gratis de 30 días terminó. Escríbanos por WhatsApp para activar la licencia — los datos están intactos.'
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
        // Sin licencia válida no rige ninguna edición especial.
        edicion: 'comun',
        lastError: expired ? 'La licencia expiró. Vuelva a conectarse para renovarla.' : 'No hay licencia válida',
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
        edicion: normalizarEdicion(payload.edicion),
        lastError: trialOver
          ? 'La prueba gratis de 30 días terminó. Escríbanos por WhatsApp para activar la licencia — los datos están intactos.'
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
      edicion: normalizarEdicion(payload.edicion),
      lastError: null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Activación                                                          */
  /* ------------------------------------------------------------------ */

  private translateActivateError(status: number, serverMsg: string | undefined): string {
    if (status === 409) return 'Licencia ya activada en otra PC. Contacte a soporte.';
    if (serverMsg && serverMsg.trim().length > 0) return serverMsg;
    if (status === 404) return 'Licencia no encontrada. Revise la clave.';
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
      return { ...base, lastError: 'No se pudo conectar con el servidor de licencias. Intente más tarde.' };
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
        edicion: 'comun',
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
        edicion: 'comun',
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
      return { ...base, lastError: 'No se pudo conectar con el servidor. Revise la conexión a internet e intente de nuevo.' };
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
        lastError: serverMsg && serverMsg.trim().length > 0 ? serverMsg : 'No se pudo crear la prueba gratis. Intente de nuevo en unos minutos.',
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

  /**
   * ACCESO REMOTO: le pide al servidor el alta del túnel de ESTE comercio.
   * Se identifica con el mismo token de licencia del heartbeat, así que sólo
   * un cliente con licencia activa puede pedirlo. Devuelve lo que hay que
   * guardar en la PC; la llave maestra de Cloudflare nunca baja hasta acá.
   */
  async pedirAltaRemota(): Promise<{ hostname: string; tunnelId: string; credencial: string }> {
    const jwt = this.readStoredJwt();
    if (!jwt) throw new Error('Esta instalación todavía no tiene una licencia activada.');
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/api/remoto/alta`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('No se pudo contactar al servidor. Revise la conexión a internet.');
    }
    const body = (await res.json().catch(() => ({}))) as {
      hostname?: string;
      tunnelId?: string;
      credencial?: string;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? `El servidor respondió ${res.status}`);
    }
    if (!body.hostname || !body.tunnelId || !body.credencial) {
      throw new Error('El servidor no devolvió los datos del acceso remoto.');
    }
    return { hostname: body.hostname, tunnelId: body.tunnelId, credencial: body.credencial };
  }

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
