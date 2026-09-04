/**
 * Lógica de licencias: generación de claves, activación (vinculación a máquina)
 * y heartbeat (renovación de JWT).
 *
 * El servicio es "puro": recibe la `CloudDatabase` en cada método (no la guarda)
 * y delega la firma de JWT en un callback (`signJwt`) provisto por el caller —
 * así no depende de Fastify ni del par de claves.
 */
import crypto from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { licenses, tenants, type License, type Tenant, type CloudDatabase } from '@stockflow/db';

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I ambiguos
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Duración de la prueba gratis autoservicio. */
export const TRIAL_DAYS = 30;

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export interface ActivateResult {
  jwt: string;
  expiresAt: number;
  plan: string;
  tenantName: string;
}

export interface JwtPayload {
  sub: string;
  tid: string;
  plan: string;
  lk: string;
  /** 'trial' cuando la licencia es una prueba gratis. Ausente = paga. */
  kind?: 'trial';
  /** Fin de la PRUEBA en epoch-segundos (independiente del exp del JWT, que es
   *  corto y se renueva por heartbeat). El desktop lo verifica offline. */
  texp?: number;
}

export interface TrialInput {
  machineId: string;
  companyName: string;
  fullName: string;
  phone: string;
}

export class LicenseService {
  /** Genera una clave de licencia con formato SF-XXXX-XXXX-XXXX-XXXX. */
  static generateLicenseKey(): string {
    const block = (): string => {
      let s = '';
      for (let i = 0; i < 4; i++) s += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
      return s;
    };
    return `SF-${block()}-${block()}-${block()}-${block()}`;
  }

  /** Construye el payload del JWT para una licencia activa. */
  static jwtPayloadFor(license: License, tenant: Tenant): JwtPayload {
    const base: JwtPayload = { sub: license.id, tid: license.tenantId, plan: tenant.plan, lk: license.licenseKey };
    if (license.kind === 'trial' && license.expiresAt) {
      base.kind = 'trial';
      base.texp = Math.floor(license.expiresAt.getTime() / 1000);
    }
    return base;
  }

  /** ¿La prueba gratis de esta licencia ya venció? (falso para licencias pagas). */
  static trialExpired(license: License): boolean {
    return license.kind === 'trial' && !!license.expiresAt && license.expiresAt.getTime() <= Date.now();
  }

  /**
   * PRUEBA GRATIS autoservicio: crea tenant + licencia 'trial' (30 días) y la
   * activa en el momento, vinculada a `machineId`. Regla: UNA licencia por
   * máquina en toda la historia — si esa PC ya tuvo cualquier licencia (de
   * prueba o paga), se rechaza con 409.
   */
  async createTrial(
    db: CloudDatabase,
    input: TrialInput,
    signJwt: (payload: object) => string,
  ): Promise<ActivateResult & { licenseKey: string; trialEndsAt: number }> {
    const machineId = input.machineId.trim();
    const [prev] = await db
      .select({ id: licenses.id })
      .from(licenses)
      .where(eq(licenses.machineId, machineId))
      .limit(1);
    if (prev) {
      throw httpError(
        'Esta computadora ya usó una licencia de StockFlow (de prueba o definitiva). Escribinos por WhatsApp y te ayudamos a seguir.',
        409,
      );
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TRIAL_DAYS * ONE_DAY_MS);
    const licenseKey = LicenseService.generateLicenseKey();
    // El email es NOT NULL UNIQUE en tenants y en la prueba no lo pedimos:
    // se sintetiza uno determinístico a partir de la clave (contacto real = phone).
    const syntheticEmail = `trial-${licenseKey.replace(/-/g, '').toLowerCase()}@trial.stockflow.local`;

    const [tenant] = await db
      .insert(tenants)
      .values({
        email: syntheticEmail,
        fullName: input.fullName.trim(),
        phone: input.phone.trim(),
        companyName: input.companyName.trim(),
        plan: 'pro', // la prueba muestra el sistema completo
        status: 'active',
      })
      .returning();
    if (!tenant) throw httpError('No se pudo crear la cuenta de prueba.', 500);

    const [license] = await db
      .insert(licenses)
      .values({
        tenantId: tenant.id,
        licenseKey,
        machineId,
        activatedAt: now,
        lastHeartbeat: now,
        status: 'active',
        kind: 'trial',
        expiresAt,
      })
      .returning();
    if (!license) throw httpError('No se pudo crear la licencia de prueba.', 500);

    const jwt = signJwt(LicenseService.jwtPayloadFor(license, tenant));
    return {
      jwt,
      expiresAt: Date.now() + SEVEN_DAYS_MS,
      plan: tenant.plan,
      tenantName: tenant.companyName,
      licenseKey,
      trialEndsAt: expiresAt.getTime(),
    };
  }

  /**
   * Activa una licencia: la vincula a `machineId` y devuelve un JWT (7 días).
   * Lanza errores con `statusCode` según el caso (404/403/409).
   */
  async activateLicense(
    db: CloudDatabase,
    licenseKey: string,
    machineId: string,
    signJwt: (payload: object) => string,
  ): Promise<ActivateResult> {
    const [license] = await db.select().from(licenses).where(eq(licenses.licenseKey, licenseKey)).limit(1);
    if (!license) throw httpError('Licencia no encontrada', 404);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, license.tenantId)).limit(1);
    if (!tenant) throw httpError('Licencia no encontrada', 404);

    if (license.status === 'revoked') throw httpError('Licencia revocada. Contactá soporte.', 403);
    if (tenant.status === 'suspended') {
      throw httpError('Suscripción suspendida. Regularizá el pago para reactivar.', 403);
    }
    if (tenant.status !== 'active' && tenant.status !== 'suspended') {
      throw httpError('La suscripción todavía no está activa.', 403);
    }
    if (license.machineId && license.machineId !== machineId) {
      throw httpError('Licencia ya activada en otra PC. Contactá soporte.', 409);
    }

    // Quota: contar licencias activas distintas a la que se está activando.
    // Si esta licencia ya está activa, no consume cupo (re-activación).
    if (license.status !== 'active') {
      const activeOther = await db
        .select({ id: licenses.id })
        .from(licenses)
        .where(and(eq(licenses.tenantId, tenant.id), eq(licenses.status, 'active'), ne(licenses.id, license.id)));
      const quota = tenant.licensesQuota ?? 1;
      if (activeOther.length >= quota) {
        throw Object.assign(
          new Error('Cuota de licencias alcanzada. Adquirí más cajas desde tu panel.'),
          { statusCode: 403, code: 'QUOTA_REACHED' },
        );
      }
    }

    const now = new Date();
    const [updated] = await db
      .update(licenses)
      .set({
        machineId,
        activatedAt: license.activatedAt ?? now,
        lastHeartbeat: now,
        status: 'active',
      })
      .where(eq(licenses.id, license.id))
      .returning();

    const jwt = signJwt(LicenseService.jwtPayloadFor(updated ?? license, tenant));
    return {
      jwt,
      expiresAt: Date.now() + SEVEN_DAYS_MS,
      plan: tenant.plan,
      tenantName: tenant.companyName,
    };
  }

  /**
   * Heartbeat periódico del desktop. Actualiza `lastHeartbeat` y, si al JWT le
   * quedan menos de 24h, devuelve uno nuevo (renovación deslizante).
   */
  async heartbeat(
    db: CloudDatabase,
    licenseId: string,
    currentExpMs: number,
    plan: string,
    lk: string,
    tid: string,
    signJwt: (payload: object) => string,
    /** `kind` que traía el JWT presentado: si difiere del de la fila (una
     *  prueba convertida a paga), se renueva YA — sin esto el desktop quedaba
     *  en sólo-lectura hasta ~6 días después de cobrar (el JWT trial recién
     *  renovado no vencía y el heartbeat contestaba jwt:null). */
    jwtKind?: 'trial',
  ): Promise<{ jwt: string | null; suspended?: boolean }> {
    await db.update(licenses).set({ lastHeartbeat: new Date() }).where(eq(licenses.id, licenseId));

    const [license] = await db.select().from(licenses).where(eq(licenses.id, licenseId)).limit(1);
    if (!license || license.status !== 'active') {
      throw httpError('Licencia inactiva', 401);
    }

    // Estado del tenant: si está 'suspended' (pago atrasado) NO revocamos —
    // devolvemos JWT renovado igual + `suspended: true` para que el desktop
    // entre en modo sólo-lectura. 'active' opera normal; cualquier otro estado
    // (cancelled, etc.) se trata como revocado (401).
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, license.tenantId)).limit(1);
    if (!tenant || (tenant.status !== 'active' && tenant.status !== 'suspended')) {
      throw httpError('Suscripción cancelada', 401);
    }
    // Prueba gratis vencida → mismo tratamiento que suspendido: el desktop
    // queda en sólo-lectura (ve sus datos, no opera) y el token sigue vivo.
    const suspended = tenant.status === 'suspended' || LicenseService.trialExpired(license);

    // Renovación deslizante: si al JWT le quedan <24h, emitimos uno nuevo.
    // Cuando está suspendido renovamos siempre para mantener vivo el token
    // (la app sigue abierta en sólo-lectura). Y si el kind del JWT quedó
    // desactualizado (prueba convertida a paga), renovamos YA: es lo que
    // desbloquea la app del cliente en el próximo contacto tras el cobro.
    const jwtDesactualizado = (jwtKind === 'trial') !== (license.kind === 'trial');
    if (suspended || jwtDesactualizado || currentExpMs - Date.now() < ONE_DAY_MS) {
      const jwt = signJwt(LicenseService.jwtPayloadFor(license, tenant));
      return suspended ? { jwt, suspended: true } : { jwt };
    }
    return { jwt: null };
  }
}
