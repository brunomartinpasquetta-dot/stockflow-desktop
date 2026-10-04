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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVO_EDICION_PRUEBA,
  edicionEfectiva,
  esVersionDePrueba,
  interruptorDePruebaActivo,
  leerEdicionPrueba,
  normalizarEdicion,
  tieneMultisucursal,
} from '../license/funciones';
import { LicenseManager } from '../license/LicenseManager';
import { CLOUD_API_URL_DEFAULT, CLOUD_PUBLIC_KEY_PEM, configCloud } from '../license/cloud-public-key';

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

  // --- PRUEBA GRATIS: estados offline según texp (fin de la prueba) ---
  {
    const mkTrialMgr = (texpOffsetSec: number, jwtExpOffsetSec: number): LicenseManager => {
      const dir = mkdtempSync(join(tmpdir(), 'stockflow-trial-smoke-'));
      const jwt = makeJwt(privateKeyPem, {
        ...validPayload,
        kind: 'trial',
        texp: now + texpOffsetSec,
        exp: now + jwtExpOffsetSec,
      });
      writeFileSync(join(dir, 'license.dat'), jwt); // texto plano (fallback sin safeStorage)
      return new LicenseManager({ userDataDir: dir, machineId: 'fake-machine', apiUrl: 'http://localhost:1', publicKeyPem });
    };
    // Prueba VIGENTE (quedan ~10 días, JWT sano) → active + trial + expiresAt = fin de prueba.
    const st1 = mkTrialMgr(10 * 86_400, 7 * 86_400).getState();
    check('trial vigente → active', st1.status === 'active', st1.status);
    check('trial vigente → trial:true y expiresAt=texp', st1.trial === true && Math.abs((st1.expiresAt ?? 0) - (now + 10 * 86_400) * 1000) < 2000);
    // Prueba VENCIDA (texp pasado, JWT todavía sano por renovaciones) → readOnly, NO unlicensed.
    const st2 = mkTrialMgr(-86_400, 7 * 86_400).getState();
    check('trial vencida (offline) → readOnly', st2.status === 'readOnly', st2.status);
    check('trial vencida → mensaje de prueba terminada', (st2.lastError ?? '').includes('prueba gratis'), st2.lastError ?? '');
    // Prueba vencida Y JWT vencido (mucho tiempo sin abrir) → sigue readOnly con datos a la vista.
    const st3 = mkTrialMgr(-86_400, -60).getState();
    check('trial vencida + jwt vencido → readOnly (no unlicensed)', st3.status === 'readOnly', st3.status);
    // Prueba VIGENTE pero JWT vencido (offline >7 días) → readOnly pidiendo conexión (la re-activación silenciosa lo renueva al conectar).
    const st4 = mkTrialMgr(10 * 86_400, -60).getState();
    check('trial vigente + jwt vencido → readOnly pidiendo internet', st4.status === 'readOnly' && (st4.lastError ?? '').includes('onectate'), `${st4.status} / ${st4.lastError ?? ''}`);
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
      const sentBodies: Array<{ licenseKey?: string; machineId?: string }> = [];
      globalThis.fetch = (async (input: unknown, init?: { body?: string }): Promise<Response> => {
        const url = String(input);
        if (url.endsWith('/api/licenses/activate')) {
          sentBodies.push(JSON.parse(init?.body ?? '{}') as { licenseKey?: string; machineId?: string });
          return { ok: true, status: 200, json: async () => ({ jwt: validJwt, expiresAt: validPayload.exp * 1000, plan: 'pro' }) } as unknown as Response;
        }
        if (url.endsWith('/api/me'))
          return { ok: true, status: 200, json: async () => ({ tenant: { name: 'Demo', plan: 'pro' } }) } as unknown as Response;
        throw new Error(`fetch no esperado: ${url}`);
      }) as typeof fetch;

      const renewed = await mgr.attemptSilentReactivation();
      const sent = sentBodies[0];
      check('attemptSilentReactivation(JWT vencido) → renovó', renewed === true);
      check('re-activación usó la clave guardada (lk del JWT)', sent?.licenseKey === 'SF-AAAA-BBBB-CCCC-DDDD', String(sent?.licenseKey));
      check('re-activación mandó el machineId vinculado', sent?.machineId === 'fake-machine');
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
      check('master license → edición común', reopened.getState().edicion === 'comun', reopened.getState().edicion);
    } finally {
      rmSync(masterDir, { recursive: true, force: true });
    }
  }

  // --- EDICIÓN (común / multisucursal) leída del token verificado ---
  console.log('\n[edición]');
  {
    const envAntes = process.env.STOCKFLOW_PLAN;
    delete process.env.STOCKFLOW_PLAN;
    const dirs: string[] = [];
    const mgrCon = (
      payload: Record<string, unknown>,
      opts: { clave?: string; empaquetada?: boolean; version?: string; archivo?: string | Record<string, unknown> } = {},
    ): LicenseManager => {
      const dir = mkdtempSync(join(tmpdir(), 'stockflow-edicion-smoke-'));
      dirs.push(dir);
      writeFileSync(join(dir, 'license.dat'), makeJwt(opts.clave ?? privateKeyPem, payload));
      // Interruptor de prueba ya puesto (como lo deja la casilla de Configuración), o un archivo cualquiera.
      if (opts.archivo !== undefined) {
        writeFileSync(join(dir, ARCHIVO_EDICION_PRUEBA), typeof opts.archivo === 'string' ? opts.archivo : JSON.stringify(opts.archivo));
      }
      return new LicenseManager({
        userDataDir: dir,
        machineId: 'fake-machine',
        apiUrl: 'http://localhost:1',
        publicKeyPem,
        ...(opts.empaquetada === undefined ? {} : { empaquetada: opts.empaquetada }),
        ...(opts.version === undefined ? {} : { version: opts.version }),
      });
    };
    const ARCHIVO_MULTI = { edicion: 'multisucursal', activadaEl: Date.now() };
    try {
      // Tokens de HOY (sin claim): edición común. Es la compatibilidad con todos los clientes.
      const viejo = mgrCon(validPayload).getState();
      check('token viejo SIN claim edicion → active y edición común', viejo.status === 'active' && viejo.edicion === 'comun', `${viejo.status}/${viejo.edicion}`);
      const multi = mgrCon({ ...validPayload, edicion: 'multisucursal' }).getState();
      check("token con edicion='multisucursal' → multisucursal", multi.status === 'active' && multi.edicion === 'multisucursal', `${multi.status}/${multi.edicion}`);
      const raro = mgrCon({ ...validPayload, edicion: 'premium' }).getState();
      check('token con edición desconocida → común', raro.edicion === 'comun', raro.edicion);
      const trialMulti = mgrCon({ ...validPayload, edicion: 'multisucursal', kind: 'trial', texp: now + 10 * 86_400 }).getState();
      check('prueba gratis con edicion multisucursal → multisucursal', trialMulti.trial === true && trialMulti.edicion === 'multisucursal', trialMulti.edicion);
      // Un token FALSIFICADO (otra clave) con el claim no habilita nada.
      const falso = mgrCon({ ...validPayload, edicion: 'multisucursal' }, { clave: wrongPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }).getState();
      check('token falsificado con edicion multisucursal → unlicensed y común', falso.status === 'unlicensed' && falso.edicion === 'comun', `${falso.status}/${falso.edicion}`);
      // Licencia paga vencida (sin conexión mucho tiempo) → sin licencia válida = común.
      const vencida = mgrCon({ ...validPayload, edicion: 'multisucursal', exp: now - 60 }).getState();
      check('licencia vencida con edicion multisucursal → común', vencida.status === 'unlicensed' && vencida.edicion === 'comun', `${vencida.status}/${vencida.edicion}`);
      check('tieneMultisucursal(deps) con token multisucursal → true', tieneMultisucursal({ licenseManager: mgrCon({ ...validPayload, edicion: 'multisucursal' }) }) === true);
      check('tieneMultisucursal(deps) con token común → false', tieneMultisucursal({ licenseManager: mgrCon(validPayload) }) === false);
      check(
        'tieneMultisucursal(deps) si getState() falla → false',
        tieneMultisucursal({ licenseManager: { getState: () => { throw new Error('x'); } } }) === false,
      );

      // --- Override de desarrollo: SÓLO sin empaquetar ---
      process.env.STOCKFLOW_PLAN = 'multisucursal';
      check('override: empaquetada (por defecto) + STOCKFLOW_PLAN → sigue común', mgrCon(validPayload).getState().edicion === 'comun');
      check('override: empaquetada:true explícito + STOCKFLOW_PLAN → sigue común', mgrCon(validPayload, { empaquetada: true }).getState().edicion === 'comun');
      check('override: sin empaquetar + STOCKFLOW_PLAN=multisucursal → multisucursal', mgrCon(validPayload, { empaquetada: false }).getState().edicion === 'multisucursal');
      const sinLicDir = mkdtempSync(join(tmpdir(), 'stockflow-edicion-sinlic-'));
      dirs.push(sinLicDir);
      const sinLic = new LicenseManager({ userDataDir: sinLicDir, machineId: 'm', apiUrl: 'http://localhost:1', publicKeyPem, empaquetada: false });
      check('override sin empaquetar vale también sin licencia (sandbox)', sinLic.getState().edicion === 'multisucursal');
      process.env.STOCKFLOW_PLAN = 'otra';
      check('override: STOCKFLOW_PLAN con otro valor → común', mgrCon(validPayload, { empaquetada: false }).getState().edicion === 'comun');
      delete process.env.STOCKFLOW_PLAN;
      check('override: sin la variable, sin empaquetar → común', mgrCon(validPayload, { empaquetada: false }).getState().edicion === 'comun');

      // --- Interruptor "Edición Multisucursal (versión de prueba)" ---
      // Regla dura: existe SÓLO con sufijo -alpha/-beta/-rc en la versión de la app.
      console.log('\n[edición de prueba]');
      check(
        'esVersionDePrueba: -beta.N / -rc.N / -alpha / -beta1 → true',
        esVersionDePrueba('1.13.0-beta.1') && esVersionDePrueba('2.0.0-rc.2') && esVersionDePrueba('1.14.0-alpha') && esVersionDePrueba('1.13.0-beta1') && esVersionDePrueba(' 1.13.0-RC.1 '),
      );
      check(
        'esVersionDePrueba: finales y basura → false',
        !esVersionDePrueba('1.13.0') && !esVersionDePrueba('1.12.1') && !esVersionDePrueba('0.0.0-test') && !esVersionDePrueba('1.13.0-next.1') && !esVersionDePrueba('beta') && !esVersionDePrueba('') && !esVersionDePrueba(undefined) && !esVersionDePrueba(null),
      );
      // Versión de prueba + archivo + token común (la PC1 de Bruno con su prueba gratis) → multisucursal.
      const beta = mgrCon(validPayload, { version: '1.13.0-beta.1', archivo: ARCHIVO_MULTI });
      check('versión de prueba + archivo → multisucursal (y la licencia sigue activa)', beta.getState().edicion === 'multisucursal' && beta.getState().status === 'active', `${beta.getState().status}/${beta.getState().edicion}`);
      check('tieneMultisucursal(deps) lo refleja', tieneMultisucursal({ licenseManager: beta }) === true);
      const epBeta = beta.getEdicionPrueba();
      check('getEdicionPrueba(): disponible, activa, activadaEl y edicionReal común', epBeta.disponible && epBeta.activa && epBeta.activadaEl === ARCHIVO_MULTI.activadaEl && epBeta.edicionReal === 'comun' && epBeta.version === '1.13.0-beta.1', JSON.stringify(epBeta));
      // Versión FINAL + el mismo archivo → común: la edición vuelve a depender sólo del token.
      const final = mgrCon(validPayload, { version: '1.13.0', archivo: ARCHIVO_MULTI });
      check('versión final + archivo presente → edición común', final.getState().edicion === 'comun', final.getState().edicion);
      check('versión final: tieneMultisucursal(deps) → false', tieneMultisucursal({ licenseManager: final }) === false);
      const epFinal = final.getEdicionPrueba();
      check('versión final: getEdicionPrueba() → no disponible, no activa', !epFinal.disponible && !epFinal.activa && epFinal.activadaEl === null, JSON.stringify(epFinal));
      let tiroFinal = false;
      try {
        final.setEdicionPrueba(true);
      } catch {
        tiroFinal = true;
      }
      check('versión final: setEdicionPrueba(true) tira y no cambia nada', tiroFinal && final.getState().edicion === 'comun');
      check('1.12.1 + archivo → común (igual que cualquier final)', mgrCon(validPayload, { version: '1.12.1', archivo: ARCHIVO_MULTI }).getState().edicion === 'comun');
      check('sin versión (tests, herramientas) + archivo → común', mgrCon(validPayload, { archivo: ARCHIVO_MULTI }).getState().edicion === 'comun');
      check('versión de prueba SIN archivo → común', mgrCon(validPayload, { version: '1.13.0-beta.1' }).getState().edicion === 'comun');
      check('versión de prueba + archivo roto → común, sin romper', mgrCon(validPayload, { version: '1.13.0-beta.1', archivo: '{no es json' }).getState().edicion === 'comun');
      check('versión de prueba + archivo con otra edición → común', mgrCon(validPayload, { version: '1.13.0-beta.1', archivo: { edicion: 'premium', activadaEl: 1 } }).getState().edicion === 'comun');
      // Sólo SUBE: una edición real multisucursal nunca baja por el interruptor.
      const realMulti = mgrCon({ ...validPayload, edicion: 'multisucursal' }, { version: '1.13.0-beta.1', archivo: { edicion: 'comun', activadaEl: 1 } });
      check('token multisucursal + archivo "comun" → sigue multisucursal (no baja)', realMulti.getState().edicion === 'multisucursal');
      realMulti.setEdicionPrueba(false);
      check('token multisucursal + setEdicionPrueba(false) → sigue multisucursal; edicionReal lo dice', realMulti.getState().edicion === 'multisucursal' && realMulti.getEdicionPrueba().edicionReal === 'multisucursal');
      // Prender y apagar desde la casilla: escribe/borra el archivo y la edición cambia al instante (misma instancia).
      const vivo = mgrCon(validPayload, { version: '1.13.0-beta.1' });
      const vivoDir = dirs[dirs.length - 1]!;
      const prendido = vivo.setEdicionPrueba(true);
      const archivo = leerEdicionPrueba(vivoDir);
      check('setEdicionPrueba(true) → activa, archivo {edicion:multisucursal, activadaEl}', prendido.activa && archivo?.edicion === 'multisucursal' && typeof archivo?.activadaEl === 'number' && archivo.activadaEl > 0, JSON.stringify(archivo));
      check('…y getState() ya es multisucursal sin reiniciar', vivo.getState().edicion === 'multisucursal');
      const apagado = vivo.setEdicionPrueba(false);
      check('setEdicionPrueba(false) → común y el archivo se borra', !apagado.activa && leerEdicionPrueba(vivoDir) === null && vivo.getState().edicion === 'comun');
      // Sin licencia la edición de prueba no da licencia: el estado sigue mandando.
      const sinLicBeta = mkdtempSync(join(tmpdir(), 'stockflow-edicion-sinlic-beta-'));
      dirs.push(sinLicBeta);
      writeFileSync(join(sinLicBeta, ARCHIVO_EDICION_PRUEBA), JSON.stringify(ARCHIVO_MULTI));
      const sinLicBetaSt = new LicenseManager({ userDataDir: sinLicBeta, machineId: 'm', apiUrl: 'http://localhost:1', publicKeyPem, version: '1.13.0-beta.1' }).getState();
      check('versión de prueba + archivo SIN licencia → sigue unlicensed (el interruptor no regala licencia)', sinLicBetaSt.status === 'unlicensed', sinLicBetaSt.status);
      // Lógica pura del interruptor.
      check('interruptorDePruebaActivo: prueba + archivo multisucursal → true', interruptorDePruebaActivo('1.13.0-beta.1', ARCHIVO_MULTI) && !interruptorDePruebaActivo('1.13.0', ARCHIVO_MULTI) && !interruptorDePruebaActivo('1.13.0-beta.1', null) && !interruptorDePruebaActivo('1.13.0-beta.1', { edicion: 'comun', activadaEl: 1 }));
      check('edicionEfectiva(empaquetada, versión de prueba, archivo) → multisucursal', edicionEfectiva(undefined, { empaquetada: true, env: {}, version: '1.13.0-beta.1', edicionPrueba: ARCHIVO_MULTI }) === 'multisucursal');
      check('edicionEfectiva(empaquetada, versión final, archivo) → común', edicionEfectiva(undefined, { empaquetada: true, env: {}, version: '1.13.0', edicionPrueba: ARCHIVO_MULTI }) === 'comun');
      check('edicionEfectiva(token multisucursal, versión final, archivo comun) → multisucursal (nunca baja)', edicionEfectiva('multisucursal', { empaquetada: true, env: {}, version: '1.13.0', edicionPrueba: { edicion: 'comun', activadaEl: 1 } }) === 'multisucursal');
      const mainVersion = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts'), 'utf8');
      check('main.ts crea el LicenseManager con version: app.getVersion() (es lo que habilita el interruptor sólo en betas)', /\n\s*version: app\.getVersion\(\),/.test(mainVersion));

      // Lógica pura.
      check('edicionEfectiva(empaquetada, env multisucursal) → token', edicionEfectiva(undefined, { empaquetada: true, env: { STOCKFLOW_PLAN: 'multisucursal' } }) === 'comun');
      check('edicionEfectiva(sin empaquetar, env multisucursal) → multisucursal', edicionEfectiva(undefined, { empaquetada: false, env: { STOCKFLOW_PLAN: 'multisucursal' } }) === 'multisucursal');
      check('normalizarEdicion: sólo el valor exacto cuenta', normalizarEdicion('multisucursal') === 'multisucursal' && normalizarEdicion('MULTISUCURSAL') === 'comun' && normalizarEdicion(null) === 'comun');

      // Empaquetada: nadie se firma una licencia propia por variables de entorno.
      const envFalso = { CLOUD_JWT_PUBLIC_KEY: 'CLAVE-DEL-ATACANTE', CLOUD_API_URL: 'https://cloud-falso.ejemplo.com' };
      const emp = configCloud(true, envFalso);
      check('empaquetada: CLOUD_JWT_PUBLIC_KEY se ignora (clave embebida)', emp.publicKeyPem === CLOUD_PUBLIC_KEY_PEM);
      check('empaquetada: CLOUD_API_URL a otro servidor se ignora', emp.apiUrl === CLOUD_API_URL_DEFAULT, emp.apiUrl);
      check('empaquetada: CLOUD_API_URL a esta PC (sandbox) se admite', configCloud(true, { CLOUD_API_URL: 'http://127.0.0.1:9' }).apiUrl === 'http://127.0.0.1:9');
      const dev = configCloud(false, envFalso);
      check('sin empaquetar (desarrollo): las dos variables valen', dev.publicKeyPem === 'CLAVE-DEL-ATACANTE' && dev.apiUrl === 'https://cloud-falso.ejemplo.com');
      check('sin variables: lo embebido', configCloud(false, {}).publicKeyPem === CLOUD_PUBLIC_KEY_PEM && configCloud(true, {}).apiUrl === CLOUD_API_URL_DEFAULT);
      const nodeEnvAntes = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const sinLicEmp = mkdtempSync(join(tmpdir(), 'stockflow-nodeenv-smoke-'));
        dirs.push(sinLicEmp);
        const empDev = new LicenseManager({ userDataDir: sinLicEmp, machineId: 'm', apiUrl: 'http://localhost:1', publicKeyPem, empaquetada: true }).getState();
        const noEmpDev = new LicenseManager({ userDataDir: sinLicEmp, machineId: 'm', apiUrl: 'http://localhost:1', publicKeyPem, empaquetada: false }).getState();
        check('empaquetada + NODE_ENV=development: NO regala una licencia pro', empDev.status !== 'active', empDev.status);
        check('sin empaquetar + NODE_ENV=development: bypass de desarrollo (como siempre)', noEmpDev.status === 'active');
      } finally {
        if (nodeEnvAntes === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = nodeEnvAntes;
      }
      const mainUsaConfig = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts'), 'utf8');
      check(
        'main.ts toma clave y dirección del cloud de configCloud(app.isPackaged, …), no de process.env directo',
        mainUsaConfig.includes('configCloud(app.isPackaged, process.env)') && !/process\.env\.CLOUD_(JWT_PUBLIC_KEY|API_URL)/.test(mainUsaConfig),
      );

      // El main tiene que pasar app.isPackaged: es lo que apaga el override en el build.
      const mainSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts'), 'utf8');
      const usos = mainSrc.match(/empaquetada:\s*[^,\n]+/g) ?? [];
      check('main.ts crea el LicenseManager con empaquetada: app.isPackaged (y nada más)', usos.length === 1 && usos[0] === 'empaquetada: app.isPackaged', JSON.stringify(usos));
    } finally {
      if (envAntes === undefined) delete process.env.STOCKFLOW_PLAN;
      else process.env.STOCKFLOW_PLAN = envAntes;
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
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
