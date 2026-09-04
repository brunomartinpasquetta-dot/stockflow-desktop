/**
 * Smoke test del módulo de licencias.
 *
 * Usa pglite (Postgres en memoria) — no requiere un Postgres real. Levanta el
 * servidor Fastify real con `buildServer({ db })` y prueba las rutas vía
 * `app.inject`. También testea helpers puros (firma de webhook, generación de
 * claves).
 *
 * Ejecutar: pnpm --filter @stockflow/cloud run test:smoke
 */
process.env.NODE_ENV = 'test';

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { billingEvents, cloudSchema, licenses, tenants } from '@stockflow/db';

import { buildServer } from '../server';
import { LicenseService } from '../services/LicenseService';
import { MercadoPagoService } from '../services/MercadoPagoService';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.resolve(here, '..', '..', '..', '..', 'packages', 'db', 'migrations', 'cloud');
const MIGRATIONS = ['0000_cloud_init.sql', '0001_licenses_quota.sql', '0002_trial_licenses.sql'];

async function main(): Promise<void> {
  const pg = new PGlite();
  for (const mig of MIGRATIONS) {
    const sql = readFileSync(path.join(migrationDir, mig), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await pg.exec(stmt);
    }
  }

  const cloudDb = drizzle(pg, { schema: cloudSchema });

  const app = await buildServer({ db: cloudDb as never });

  // --- Setup: tenant + licencia ---
  const [tenant] = await cloudDb
    .insert(tenants)
    .values({ email: 't@test.com', fullName: 'Test', companyName: 'Test SA', plan: 'pro', status: 'active' })
    .returning();
  if (!tenant) throw new Error('no se creó el tenant de prueba');
  await cloudDb
    .insert(licenses)
    .values({ tenantId: tenant.id, licenseKey: 'SF-TEST-AAAA-BBBB-CCCC', status: 'pending' })
    .returning();

  // --- activate (machine-1) ---
  const r1 = await app.inject({
    method: 'POST',
    url: '/api/licenses/activate',
    payload: { licenseKey: 'SF-TEST-AAAA-BBBB-CCCC', machineId: 'machine-1' },
  });
  check('activate machine-1 → 200', r1.statusCode === 200, r1.statusCode);
  const body1 = r1.json() as { jwt?: string };
  const jwt1 = body1.jwt ?? '';
  check('activate devuelve jwt con 3 segmentos', jwt1.split('.').length === 3, jwt1.slice(0, 12));

  // --- activate (machine-2) → 409 ---
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/licenses/activate',
    payload: { licenseKey: 'SF-TEST-AAAA-BBBB-CCCC', machineId: 'machine-2' },
  });
  check('activate machine-2 → 409', r2.statusCode === 409, r2.statusCode);

  // --- re-activate (machine-1) → 200 ---
  const r3 = await app.inject({
    method: 'POST',
    url: '/api/licenses/activate',
    payload: { licenseKey: 'SF-TEST-AAAA-BBBB-CCCC', machineId: 'machine-1' },
  });
  check('re-activate machine-1 → 200', r3.statusCode === 200, r3.statusCode);
  const jwtForHb = (r3.json() as { jwt?: string }).jwt ?? jwt1;

  // --- heartbeat con auth ---
  const r4 = await app.inject({
    method: 'POST',
    url: '/api/licenses/heartbeat',
    headers: { authorization: `Bearer ${jwtForHb}` },
  });
  check('heartbeat con auth → 200', r4.statusCode === 200, r4.statusCode);
  const [licAfterHb] = await cloudDb.select().from(licenses).where(eq(licenses.tenantId, tenant.id)).limit(1);
  check('heartbeat actualizó lastHeartbeat', licAfterHb?.lastHeartbeat instanceof Date, licAfterHb?.lastHeartbeat);

  // --- heartbeat sin auth → 401 ---
  const r5 = await app.inject({ method: 'POST', url: '/api/licenses/heartbeat' });
  check('heartbeat sin auth → 401', r5.statusCode === 401, r5.statusCode);

  // --- /api/me ---
  const r6 = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${jwtForHb}` } });
  check('/api/me → 200', r6.statusCode === 200, r6.statusCode);
  const meBody = r6.json() as { features?: { arca?: boolean }; tenant?: { plan?: string } };
  check('/api/me features.arca = true (plan pro)', meBody.features?.arca === true, meBody.features);

  // --- webhook idempotencia (payment.approved) ---
  const w1 = await app.inject({
    method: 'POST',
    url: `/api/billing/webhook/mp?event=payment.approved&tenantId=${tenant.id}`,
    payload: { type: 'payment', data: { id: 'pay-1' }, amount: 25000 },
  });
  check('webhook payment.approved → 200', w1.statusCode === 200, w1.statusCode);
  let evCount = (await cloudDb.select().from(billingEvents).where(eq(billingEvents.tenantId, tenant.id))).length;
  check('webhook creó 1 billingEvent', evCount === 1, evCount);

  const w2 = await app.inject({
    method: 'POST',
    url: `/api/billing/webhook/mp?event=payment.approved&tenantId=${tenant.id}`,
    payload: { type: 'payment', data: { id: 'pay-1' }, amount: 25000 },
  });
  check('webhook duplicado → 200', w2.statusCode === 200, w2.statusCode);
  check('webhook duplicado → { duplicate: true }', (w2.json() as { duplicate?: boolean }).duplicate === true);
  evCount = (await cloudDb.select().from(billingEvents).where(eq(billingEvents.tenantId, tenant.id))).length;
  check('billingEvents sigue en 1 tras duplicado', evCount === 1, evCount);

  // --- webhook preapproval.authorized → tenant active + licencia ---
  const [tenant2] = await cloudDb
    .insert(tenants)
    .values({ email: 't2@test.com', fullName: 'Test 2', companyName: 'Test 2 SA', plan: 'basic', status: 'pending' })
    .returning();
  if (!tenant2) throw new Error('no se creó tenant2');
  const w3 = await app.inject({
    method: 'POST',
    url: `/api/billing/webhook/mp?event=preapproval.authorized&tenantId=${tenant2.id}`,
    payload: { type: 'preapproval', data: { id: 'preap-2' } },
  });
  check('webhook preapproval.authorized → 200', w3.statusCode === 200, w3.statusCode);
  const [t2After] = await cloudDb.select().from(tenants).where(eq(tenants.id, tenant2.id)).limit(1);
  check('tenant2 quedó active', t2After?.status === 'active', t2After?.status);
  const t2Licenses = await cloudDb.select().from(licenses).where(eq(licenses.tenantId, tenant2.id));
  check('tenant2 tiene una licencia', t2Licenses.length === 1, t2Licenses.length);

  // --- billing/status ---
  const sRes = await app.inject({ method: 'GET', url: `/api/billing/status/${tenant2.id}` });
  check('billing/status → 200 active', sRes.statusCode === 200 && (sRes.json() as { status?: string }).status === 'active', sRes.json());

  // --- firma de webhook (helper puro) ---
  const secret = 'whsecret';
  const mpSvc = new MercadoPagoService('tok', secret);
  const ts = '1700000000';
  const dataId = 'd';
  const reqId = 'rq';
  const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
  const goodHmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  check(
    'validateWebhookSignature (firma correcta) → true',
    mpSvc.validateWebhookSignature({ xSignature: `ts=${ts},v1=${goodHmac}`, xRequestId: reqId, dataId }) === true,
  );
  check(
    'validateWebhookSignature (firma incorrecta) → false',
    mpSvc.validateWebhookSignature({ xSignature: `ts=${ts},v1=${'0'.repeat(goodHmac.length)}`, xRequestId: reqId, dataId }) === false,
  );

  // --- Quota de licencias (tenant con quota=1 ya tiene una activa) ---
  // Agregamos una segunda licencia pending al tenant inicial; debería rechazarse
  // por QUOTA_REACHED al intentar activarla en otra máquina.
  await cloudDb
    .insert(licenses)
    .values({ tenantId: tenant.id, licenseKey: 'SF-QQQQ-WWWW-EEEE-RRRR', status: 'pending' })
    .returning();
  const rq = await app.inject({
    method: 'POST',
    url: '/api/licenses/activate',
    payload: { licenseKey: 'SF-QQQQ-WWWW-EEEE-RRRR', machineId: 'machine-3' },
  });
  check('activate con quota agotada → 403', rq.statusCode === 403, rq.statusCode);

  // Subiendo la quota a 2, debe permitir la activación.
  await cloudDb.update(tenants).set({ licensesQuota: 2 }).where(eq(tenants.id, tenant.id));
  const rq2 = await app.inject({
    method: 'POST',
    url: '/api/licenses/activate',
    payload: { licenseKey: 'SF-QQQQ-WWWW-EEEE-RRRR', machineId: 'machine-3' },
  });
  check('activate con quota=2 → 200', rq2.statusCode === 200, rq2.statusCode);

  // --- generateLicenseKey ---
  const key = LicenseService.generateLicenseKey();
  check('generateLicenseKey con formato válido', /^SF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key), key);

  // ============ PRUEBA GRATIS (trial autoservicio) ============

  // --- crear trial en máquina virgen → 200, activada al instante ---
  const tr1 = await app.inject({
    method: 'POST',
    url: '/api/licenses/trial',
    payload: { machineId: 'trial-machine-1', companyName: 'Kiosco Demo', fullName: 'Ana Prueba', phone: '342 5551234' },
  });
  check('trial máquina virgen → 200', tr1.statusCode === 200, tr1.body);
  const trBody = tr1.json() as { jwt?: string; licenseKey?: string; trialEndsAt?: number; plan?: string };
  check('trial devuelve jwt', (trBody.jwt ?? '').split('.').length === 3, trBody.jwt?.slice(0, 12));
  check('trial devuelve licenseKey SF-…', /^SF-/.test(trBody.licenseKey ?? ''), trBody.licenseKey);
  const days = trBody.trialEndsAt ? (trBody.trialEndsAt - Date.now()) / 86_400_000 : 0;
  check('trialEndsAt ≈ 30 días', days > 29 && days < 31, days);
  const trPayload = JSON.parse(Buffer.from((trBody.jwt ?? '..').split('.')[1]!, 'base64url').toString()) as {
    kind?: string;
    texp?: number;
    plan?: string;
  };
  check("jwt trial lleva kind='trial'", trPayload.kind === 'trial', trPayload.kind);
  check('jwt trial lleva texp (fin de prueba)', typeof trPayload.texp === 'number' && trPayload.texp * 1000 > Date.now(), trPayload.texp);
  const [trTenant] = await cloudDb.select().from(tenants).where(eq(tenants.companyName, 'Kiosco Demo')).limit(1);
  check('tenant trial creado con phone', trTenant?.phone === '342 5551234', trTenant?.phone);
  check('tenant trial plan pro y active', trTenant?.plan === 'pro' && trTenant?.status === 'active', `${trTenant?.plan}/${trTenant?.status}`);

  // --- misma máquina pide OTRO trial → 409 ---
  const tr2 = await app.inject({
    method: 'POST',
    url: '/api/licenses/trial',
    payload: { machineId: 'trial-machine-1', companyName: 'Otro Kiosco', fullName: 'Otro', phone: '111' },
  });
  check('trial repetido misma máquina → 409', tr2.statusCode === 409, tr2.statusCode);

  // --- máquina que ya tiene licencia PAGA pide trial → 409 ---
  const tr3 = await app.inject({
    method: 'POST',
    url: '/api/licenses/trial',
    payload: { machineId: 'machine-1', companyName: 'Vivo', fullName: 'Cliente Pago', phone: '222' },
  });
  check('trial en máquina con licencia paga → 409', tr3.statusCode === 409, tr3.statusCode);

  // --- datos incompletos → 400 ---
  const tr4 = await app.inject({
    method: 'POST',
    url: '/api/licenses/trial',
    payload: { machineId: 'trial-machine-2', companyName: '', fullName: 'X', phone: '' },
  });
  check('trial sin datos → 400', tr4.statusCode === 400, tr4.statusCode);

  // --- heartbeat de trial VIGENTE → 200 sin suspended ---
  const hb1 = await app.inject({
    method: 'POST',
    url: '/api/licenses/heartbeat',
    headers: { authorization: `Bearer ${trBody.jwt}` },
  });
  check('heartbeat trial vigente → 200', hb1.statusCode === 200, hb1.statusCode);
  check('heartbeat trial vigente sin suspended', (hb1.json() as { suspended?: boolean }).suspended !== true, hb1.body);

  // --- trial VENCIDO → heartbeat responde suspended:true (solo lectura) ---
  await cloudDb
    .update(licenses)
    .set({ expiresAt: new Date(Date.now() - 86_400_000) })
    .where(eq(licenses.licenseKey, trBody.licenseKey ?? ''));
  const hb2 = await app.inject({
    method: 'POST',
    url: '/api/licenses/heartbeat',
    headers: { authorization: `Bearer ${trBody.jwt}` },
  });
  check('heartbeat trial vencido → 200', hb2.statusCode === 200, hb2.statusCode);
  const hb2Body = hb2.json() as { suspended?: boolean; jwt?: string };
  check('heartbeat trial vencido → suspended:true', hb2Body.suspended === true, hb2.body);
  check('heartbeat trial vencido renueva jwt (app abierta en solo-lectura)', (hb2Body.jwt ?? '').split('.').length === 3, hb2Body.jwt?.slice(0, 12));

  // --- re-activate de trial vencido (re-activación silenciosa del desktop) → 200 con texp pasado ---
  const tr5 = await app.inject({
    method: 'POST',
    url: '/api/licenses/activate',
    payload: { licenseKey: trBody.licenseKey, machineId: 'trial-machine-1' },
  });
  check('re-activate trial vencido → 200 (desktop queda readOnly por texp)', tr5.statusCode === 200, tr5.statusCode);
  const tr5Payload = JSON.parse(
    Buffer.from(((tr5.json() as { jwt?: string }).jwt ?? '..').split('.')[1]!, 'base64url').toString(),
  ) as { kind?: string; texp?: number };
  check('re-activate trial vencido: jwt con texp en el pasado', tr5Payload.kind === 'trial' && (tr5Payload.texp ?? 0) * 1000 < Date.now(), tr5Payload.texp);

  // --- CONVERSIÓN A PAGA (el cobro real): con un JWT trial FRESCO en mano
  // (el hb2 renovó uno con ~7 días de vida), el UPDATE a kind='paid' debe
  // desbloquear en el PRÓXIMO heartbeat — jwt nuevo sin kind/texp, sin
  // suspended — y no ~6 días después cuando venza el token viejo. ---
  await cloudDb
    .update(licenses)
    .set({ kind: 'paid', expiresAt: null })
    .where(eq(licenses.licenseKey, trBody.licenseKey ?? ''));
  const hb3 = await app.inject({
    method: 'POST',
    url: '/api/licenses/heartbeat',
    headers: { authorization: `Bearer ${hb2Body.jwt}` },
  });
  check('heartbeat tras convertir a paga → 200', hb3.statusCode === 200, hb3.statusCode);
  const hb3Body = hb3.json() as { suspended?: boolean; jwt?: string | null };
  check('convertida: ya no viene suspended', hb3Body.suspended !== true, hb3.body);
  check('convertida: renueva el jwt YA (no jwt:null)', (hb3Body.jwt ?? '').split('.').length === 3, hb3.body);
  const hb3Payload = JSON.parse(
    Buffer.from((hb3Body.jwt ?? '..').split('.')[1]!, 'base64url').toString(),
  ) as { kind?: string; texp?: number };
  check('convertida: jwt limpio, sin kind ni texp', hb3Payload.kind === undefined && hb3Payload.texp === undefined, JSON.stringify(hb3Payload));

  await app.close();
  await pg.close();

  if (failures > 0) {
    console.error(`\n${failures} chequeo(s) fallaron ❌`);
    process.exit(1);
  }
  console.log('\nSMOKE TEST (licensing) OK ✅');
}

main().catch((err) => {
  failures++;
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
