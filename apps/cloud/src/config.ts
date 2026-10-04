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
  // Precio único: StockFlow completo (22-sep-2026). Los dos planes siguen
  // existiendo en la base por compatibilidad con las licencias ya emitidas.
  basic: Number(process.env.PLAN_BASIC_PRICE ?? 80000),
  pro: Number(process.env.PLAN_PRO_PRICE ?? 80000),
};

/** Features habilitadas por plan (se exponen en /api/me). */
export const PLAN_FEATURES: Record<PlanId, { arca: boolean }> = {
  basic: { arca: false },
  pro: { arca: true },
};

/* ----- MercadoPago ----- */
export const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
export const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;

/* ----- Acceso remoto (túnel de los comercios) ----- */
/**
 * Llave de Cloudflare con permiso para crear túneles y escribir el DNS del
 * dominio. Vive SÓLO acá: en la PC de un comercio sería una llave regalada.
 * Sin estas variables, el alta automática responde "no disponible" y el
 * comercio puede seguir cargando la credencial a mano.
 */
export const REMOTO_CF_API_TOKEN = process.env.REMOTO_CF_API_TOKEN;
export const REMOTO_CF_ACCOUNT_ID = process.env.REMOTO_CF_ACCOUNT_ID;
export const REMOTO_CF_ZONE_ID = process.env.REMOTO_CF_ZONE_ID;
/** Dominio bajo el que cuelga cada comercio: `<comercio>.<dominio>`. */
export const REMOTO_DOMINIO = process.env.REMOTO_DOMINIO ?? 'mistockflow.com';

/* ----- Panel admin ----- */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@stockflow.local';
export const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH ?? '';

/* ----- SMTP (emails transaccionales) ----- */
export const SMTP_HOST = process.env.SMTP_HOST;
export const SMTP_USER = process.env.SMTP_USER;
export const SMTP_PASS = process.env.SMTP_PASS;
export const SMTP_FROM = process.env.SMTP_FROM ?? 'StockFlow <no-reply@stockflow.local>';

/** Orígenes permitidos para CORS (coma-separados). Si vacío → `true` (cualquiera). */
export const CORS_ORIGINS = process.env.CORS_ORIGINS;
