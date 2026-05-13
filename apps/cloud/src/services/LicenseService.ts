/**
 * Lógica de licencias: generación de claves, activación (vinculación a máquina)
 * y heartbeat (renovación de JWT).
 *
 * El servicio es "puro": recibe la `CloudDatabase` en cada método (no la guarda)
 * y delega la firma de JWT en un callback (`signJwt`) provisto por el caller —
 * así no depende de Fastify ni del par de claves.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { licenses, tenants, type License, type Tenant, type CloudDatabase } from '@stockflow/db';

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I ambiguos
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
    return { sub: license.id, tid: license.tenantId, plan: tenant.plan, lk: license.licenseKey };
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
  ): Promise<{ jwt: string | null }> {
    await db.update(licenses).set({ lastHeartbeat: new Date() }).where(eq(licenses.id, licenseId));

    const [license] = await db.select().from(licenses).where(eq(licenses.id, licenseId)).limit(1);
    if (!license || license.status !== 'active') {
      throw httpError('Licencia inactiva', 401);
    }

    if (currentExpMs - Date.now() < ONE_DAY_MS) {
      const jwt = signJwt({ sub: licenseId, tid, plan, lk } satisfies JwtPayload);
      return { jwt };
    }
    return { jwt: null };
  }
}
