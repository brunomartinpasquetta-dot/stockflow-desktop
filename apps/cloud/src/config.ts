/**
 * Configuración de la API de licencias en la nube.
 *
 * Lee variables de entorno con valores por defecto razonables para desarrollo.
 * En producción todas las variables sensibles (MP, SMTP, ADMIN, JWT) deben
 * estar seteadas explícitamente.
 */

/** Identificador de plan disponible. */
export type PlanId = 'basic' | 'pro';

export const IS_TEST = process.env.NODE_ENV === 'test';

export const PORT = Number(process.env.PORT ?? 3009);
export const HOST = process.env.HOST ?? '0.0.0.0';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/stockflow_cloud';

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3009';

/** Precios mensuales por plan (en ARS). */
export const PLAN_PRICES: Record<PlanId, number> = {
  basic: Number(process.env.PLAN_BASIC_PRICE ?? 15000),
  pro: Number(process.env.PLAN_PRO_PRICE ?? 25000),
};

/** Features habilitadas por plan (se exponen en /api/me). */
export const PLAN_FEATURES: Record<PlanId, { arca: boolean }> = {
  basic: { arca: false },
  pro: { arca: true },
};

/* ----- MercadoPago ----- */
export const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
export const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;

/* ----- Panel admin ----- */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@stockflow.local';
export const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';

/* ----- SMTP (emails transaccionales) ----- */
export const SMTP_HOST = process.env.SMTP_HOST;
export const SMTP_USER = process.env.SMTP_USER;
export const SMTP_PASS = process.env.SMTP_PASS;
export const SMTP_FROM = process.env.SMTP_FROM ?? 'StockFlow <no-reply@stockflow.local>';

/** URL pública de la landing (para enlaces en emails / redirects). */
export const LANDING_URL = process.env.LANDING_URL ?? 'http://localhost:3009/landing.html';

/** Orígenes permitidos para CORS (coma-separados). Si vacío → `true` (cualquiera). */
export const CORS_ORIGINS = process.env.CORS_ORIGINS;
