/**
 * Tareas programadas (node-cron):
 *  - 03:00 → suspende tenants con el cobro vencido hace más de 5 días.
 *  - 04:00 → revoca licencias de tenants suspendidos hace más de 7 días.
 *
 * Las funciones se exportan aparte para poder testearlas sin esperar al cron.
 */
import cron from 'node-cron';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { licenses, tenants, type CloudDatabase } from '@stockflow/db';

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Suspende tenants `active` cuyo `nextBillingDate` venció hace más de 5 días. */
export async function suspendOverdueTenants(db: CloudDatabase): Promise<void> {
  const cutoff = new Date(Date.now() - FIVE_DAYS_MS);
  await db
    .update(tenants)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(and(eq(tenants.status, 'active'), lt(tenants.nextBillingDate, cutoff)));
}

/** Revoca licencias de tenants `suspended` desde hace más de 7 días. */
export async function revokeStaleLicenses(db: CloudDatabase): Promise<void> {
  const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);
  const stale = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.status, 'suspended'), lt(tenants.updatedAt, cutoff)));
  const ids = stale.map((r) => r.id);
  if (ids.length === 0) return;
  await db.update(licenses).set({ status: 'revoked' }).where(inArray(licenses.tenantId, ids));
}

export function registerCronJobs(db: CloudDatabase): void {
  cron.schedule('0 3 * * *', () => {
    suspendOverdueTenants(db).catch(console.error);
  });
  cron.schedule('0 4 * * *', () => {
    revokeStaleLicenses(db).catch(console.error);
  });
}
