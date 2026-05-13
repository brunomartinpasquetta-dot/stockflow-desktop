/**
 * Schema Postgres de la nube de licencias (multi-tenant).
 *
 * Convenciones:
 *  - IDs: uuid con `defaultRandom()`.
 *  - Timestamps: `timestamp` (con `defaultNow()` en `createdAt`).
 *  - Decimales de dinero: `numeric(10, 2)`.
 *  - Enums como `varchar` + `check` (más simple de migrar que `pgEnum`).
 *
 * Tablas: tenants, licenses, billingEvents, adminUsers.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------ */
/* tenants — el cliente que paga la suscripción                        */
/* ------------------------------------------------------------------ */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    fullName: varchar('full_name', { length: 255 }).notNull(),
    phone: varchar('phone', { length: 64 }),
    companyName: varchar('company_name', { length: 255 }).notNull(),
    plan: varchar('plan', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    mpPreapprovalId: varchar('mp_preapproval_id', { length: 128 }),
    mpCustomerId: varchar('mp_customer_id', { length: 128 }),
    /** Próxima fecha de cobro esperada (la actualiza el webhook payment.approved). */
    nextBillingDate: timestamp('next_billing_date'),
    /** Cantidad de pagos rechazados consecutivos (para la regla de suspensión). */
    failedPayments: numeric('failed_payments', { precision: 4, scale: 0 }).notNull().default('0'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    planCheck: check('tenants_plan_check', sql`${t.plan} in ('basic', 'pro')`),
    statusCheck: check(
      'tenants_status_check',
      sql`${t.status} in ('pending', 'active', 'suspended', 'cancelled')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* licenses — la clave que activa el desktop, vinculada a una máquina  */
/* ------------------------------------------------------------------ */
export const licenses = pgTable(
  'licenses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Formato SF-XXXX-XXXX-XXXX-XXXX. */
    licenseKey: varchar('license_key', { length: 32 }).notNull().unique(),
    /** Hash de machineId; se vincula en la primera activación. */
    machineId: varchar('machine_id', { length: 128 }),
    activatedAt: timestamp('activated_at'),
    lastHeartbeat: timestamp('last_heartbeat'),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    machineIdx: index('idx_license_machine').on(t.machineId),
    tenantIdx: index('idx_license_tenant').on(t.tenantId),
    statusCheck: check('licenses_status_check', sql`${t.status} in ('pending', 'active', 'revoked')`),
  }),
);

/* ------------------------------------------------------------------ */
/* billingEvents — eventos de MercadoPago (idempotencia por mpPaymentId) */
/* ------------------------------------------------------------------ */
export const billingEvents = pgTable(
  'billing_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** id del pago / preapproval en MP — único para idempotencia del webhook. */
    mpPaymentId: varchar('mp_payment_id', { length: 128 }).notNull().unique(),
    type: varchar('type', { length: 48 }).notNull(),
    amount: numeric('amount', { precision: 10, scale: 2 }),
    status: varchar('status', { length: 32 }),
    rawPayload: jsonb('raw_payload'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index('idx_billing_events_tenant').on(t.tenantId),
  }),
);

/* ------------------------------------------------------------------ */
/* adminUsers — usuarios del panel de administración                   */
/* ------------------------------------------------------------------ */
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/* ================================================================== */
/* Tipos inferidos                                                     */
/* ================================================================== */
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type License = typeof licenses.$inferSelect;
export type NewLicense = typeof licenses.$inferInsert;
export type BillingEvent = typeof billingEvents.$inferSelect;
export type NewBillingEvent = typeof billingEvents.$inferInsert;
export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;

/** Objeto schema agregado (para pasar a drizzle({ schema })). */
export const cloudSchema = {
  tenants,
  licenses,
  billingEvents,
  adminUsers,
};
