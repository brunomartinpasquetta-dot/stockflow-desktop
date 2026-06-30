/**
 * Smoke test del cliente de licencias, sin Electron ni servidor cloud real.
 *
 *   pnpm --filter @stockflow/desktop test:license
 *
 * Ejercita la lógica pura de `LicenseManager`:
 *  - `LicenseManager.parseAndVerify` con JWTs válidos / expirados / firma mala.
 *  - `getState()` sin licencia y con un `license.dat` en texto plano (fallback).
 *  - `activate()` con `fetch` monkeypatcheado.
 *  - `heartbeat()` con `fetch` devolviendo 401 → estado 'revoked'.
 */
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LicenseManager } from '../license/LicenseManager';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function makeJwt(privateKeyPem: string, payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  const sig = b64url(signer.sign(privateKeyPem));
  return `${header}.${body}.${sig}`;
}

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-license-smoke-'));
console.log(`\nSmoke test del cliente de licencias — dir temporal: ${tmpDir}\n`);

async function main(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  // Otro par distinto, para el caso "firma incorrecta".
  const wrongPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongPublicKeyPem = wrongPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const now = Math.floor(Date.now() / 1000);
  const validPayload = {
    sub: 'lic1',
    tid: 'ten1',
    plan: 'pro',
    lk: 'SF-AAAA-BBBB-CCCC-DDDD',
    iat: now,
    exp: now + 7 * 24 * 60 * 60,
  };
  const expiredPayload = { ...validPayload, exp: now - 60 };

  const validJwt = makeJwt(privateKeyPem, validPayload);
  const expiredJwt = makeJwt(privateKeyPem, expiredPayload);

  // --- parseAndVerify ---
  {
    const r = LicenseManager.parseAndVerify(validJwt, '');
    check('parseAndVerify(válido, sin clave) → ok', r.ok === true && r.payload?.lk === 'SF-AAAA-BBBB-CCCC-DDDD');
  }
  {
    const r = LicenseManager.parseAndVerify(expiredJwt, '');
    check('parseAndVerify(expirado, sin clave) → !ok', r.ok === false);
  }
  {
    const r = LicenseManager.parseAndVerify(validJwt, publicKeyPem);
    check('parseAndVerify(válido, clave correcta) → ok', r.ok === true);
  }
  {
    const r = LicenseManager.parseAndVerify(validJwt, wrongPublicKeyPem);
    check('parseAndVerify(válido, clave incorrecta) → !ok', r.ok === false);
  }
  {
    const r = LicenseManager.parseAndVerify('not-a-jwt', '');
    check('parseAndVerify(basura) → !ok', r.ok === false && r.payload === null);
  }

  // --- getState() sin licencia ---
  {
    const mgr = new LicenseManager({
      userDataDir: tmpDir,
      machineId: 'fake-machine',
      apiUrl: 'http://localhost:1',
      publicKeyPem: '',
    });
    const st = mgr.getState();
    check('getState() sin license.dat → unlicensed', st.status === 'unlicensed' && st.plan === null);
  }

  // --- activate() con fetch monkeypatcheado ---
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/licenses/activate')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ jwt: validJwt, expiresAt: validPayload.exp * 1000, plan: 'pro' }),
        } as unknown as Response;
      }
      if (url.endsWith('/api/me')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tenant: { name: 'Comercio Demo', plan: 'pro' } }),
        } as unknown as Response;
      }
      throw new Error(`fetch no esperado: ${url}`);
    }) as typeof fetch;

    const mgr = new LicenseManager({
      userDataDir: tmpDir,
      machineId: 'fake-machine',
      apiUrl: 'http://localhost:1',
      publicKeyPem: '',
    });
    const st = await mgr.activate('SF-AAAA-BBBB-CCCC-DDDD');
    check('activate() OK → status active', st.status === 'active', st.status);
    check('activate() OK → plan pro', st.plan === 'pro');
    check('activate() OK → tenantName cacheado', st.tenantName === 'Comercio Demo', String(st.tenantName));

    // getState() ahora debe leer el license.dat en texto plano (fallback fuera de Electron).
    const st2 = mgr.getState();
    check('getState() tras activate → active', st2.status === 'active', st2.status);

    // --- heartbeat() devolviendo 401 → revoked ---
    globalThis.fetch = (async (input: unknown): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/api/licenses/heartbeat')) {
        return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`fetch no esperado: ${url}`);
    }) as typeof fetch;

    await mgr.heartbeat();
    check('heartbeat() 401 → status revoked', mgr.getState().status === 'revoked', mgr.getState().status);
  } finally {
    globalThis.fetch = realFetch;
  }

  // --- attemptSilentReactivation: un JWT VENCIDO se renueva solo con la clave guardada ---
  {
    const reDir = mkdtempSync(join(tmpdir(), 'stockflow-license-react-'));
    const realFetch2 = globalThis.fetch;
    try {
      // 1) Sembrar license.dat con un JWT VENCIDO (vía activate mockeado).
      globalThis.fetch = (async (input: unknown): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/api/licenses/activate'))
          return { ok: true, status: 200, json: async () => ({ jwt: expiredJwt, expiresAt: 0, plan: 'pro' }) } as unknown as Response;
        if (url.endsWith('/api/me'))
          return { ok: true, status: 200, json: async () => ({ tenant: { name: 'Demo', plan: 'pro' } }) } as unknown as Response;
        throw new Error(`fetch no esperado: ${url}`);
      }) as typeof fetch;
      const mgr = new LicenseManager({ userDataDir: reDir, machineId: 'fake-machine', apiUrl: 'http://localhost:1', publicKeyPem: '' });
      await mgr.activate('SF-AAAA-BBBB-CCCC-DDDD');
      check('estado con JWT vencido → unlicensed', mgr.getState().status === 'unlicensed', mgr.getState().status);

      // 2) Ahora el cloud responde con un JWT FRESCO → la re-activación debe renovar.
      let sentBody: { licenseKey?: string; machineId?: string } | null = null;
      globalThis.fetch = (async (input: unknown, init?: { body?: string }): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/api/licenses/activate')) {
          sentBody = JSON.parse(init?.body ?? '{}') as { licenseKey?: string; machineId?: string };
          return { ok: true, status: 200, json: async () => ({ jwt: validJwt, expiresAt: validPayload.exp * 1000, plan: 'pro' }) } as unknown as Response;
        }
        if (url.endsWith('/api/me'))
          return { ok: true, status: 200, json: async () => ({ tenant: { name: 'Demo', plan: 'pro' } }) } as unknown as Response;
        throw new Error(`fetch no esperado: ${url}`);
      }) as typeof fetch;

      const renewed = await mgr.attemptSilentReactivation();
      check('attemptSilentReactivation(JWT vencido) → renovó', renewed === true);
      check('re-activación usó la clave guardada (lk del JWT)', sentBody?.licenseKey === 'SF-AAAA-BBBB-CCCC-DDDD', String(sentBody?.licenseKey));
      check('re-activación mandó el machineId vinculado', sentBody?.machineId === 'fake-machine');
      check('getState() tras re-activación → active', mgr.getState().status === 'active', mgr.getState().status);

      // 3) Con JWT válido NO debe re-activar (no-op).
      const renewed2 = await mgr.attemptSilentReactivation();
      check('attemptSilentReactivation(JWT válido) → no-op (false)', renewed2 === false);

      // 4) Offline (fetch tira) con JWT vencido → false, sin romper.
      const expDir = mkdtempSync(join(tmpdir(), 'stockflow-license-off-'));
      globalThis.fetch = (async (input: unknown): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/api/licenses/activate')) return { ok: true, status: 200, json: async () => ({ jwt: expiredJwt, expiresAt: 0, plan: 'pro' }) } as unknown as Response;
        if (url.endsWith('/api/me')) return { ok: true, status: 200, json: async () => ({ tenant: { name: 'Demo' } }) } as unknown as Response;
        throw new Error(`fetch no esperado: ${url}`);
      }) as typeof fetch;
      const offMgr = new LicenseManager({ userDataDir: expDir, machineId: 'fake-machine', apiUrl: 'http://localhost:1', publicKeyPem: '' });
      await offMgr.activate('SF-AAAA-BBBB-CCCC-DDDD'); // siembra vencido
      globalThis.fetch = (async (): Promise<Response> => { throw new Error('offline'); }) as typeof fetch;
      const renewedOffline = await offMgr.attemptSilentReactivation();
      check('attemptSilentReactivation(offline) → false sin romper', renewedOffline === false);
      rmSync(expDir, { recursive: true, force: true });
    } finally {
      globalThis.fetch = realFetch2;
      rmSync(reDir, { recursive: true, force: true });
    }
  }

  // --- master key: persiste vía marker file (sin cloud ni safeStorage) ---
  // Usa su PROPIO dir para no chocar con el license.dat del bloque anterior.
  {
    const masterDir = mkdtempSync(join(tmpdir(), 'stockflow-license-master-'));
    try {
      const mgr = new LicenseManager({
        userDataDir: masterDir,
        machineId: 'fake-machine',
        apiUrl: 'http://localhost:1',
        publicKeyPem: '',
      });
      // Minúsculas + espacios → debe normalizar (trim + case-insensitive).
      const st = await mgr.activate('  sf-brun-ownr-mstr-2026  ');
      check('activate(master, lower+spaces) → active', st.status === 'active', st.status);
      check('activate(master) → plan pro', st.plan === 'pro', String(st.plan));
      check('getState() tras master → active', mgr.getState().status === 'active');

      // Reabrir la app = nueva instancia sobre el mismo userData → sigue activa.
      const reopened = new LicenseManager({
        userDataDir: masterDir,
        machineId: 'fake-machine',
        apiUrl: 'http://localhost:1',
        publicKeyPem: '',
      });
      check(
        'reabrir app (instancia nueva) → sigue active',
        reopened.getState().status === 'active',
        reopened.getState().status,
      );
    } finally {
      rmSync(masterDir, { recursive: true, force: true });
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error('Error inesperado en el smoke test:', err);
    failures++;
  })
  .finally(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (failures > 0) {
      console.error(`\n${failures} verificación(es) fallida(s) ❌\n`);
      process.exit(1);
    }
    console.log('\nSMOKE TEST (license) OK ✅\n');
  });
