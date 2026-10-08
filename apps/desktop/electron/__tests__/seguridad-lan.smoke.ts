/**
 * Smoke de seguridad en red (auditoría sep-2026: C3, A9, A10 y medias).
 *
 *   pnpm --filter @stockflow/desktop test:seguridad-lan
 *
 * Parte 1 — LanServer con handlers mock:
 *  - un JWT firmado con el PIN (el secreto viejo) es rechazado (C3);
 *  - canales fuera de la lista LAN → 403 aunque la sesión sea de admin (A9);
 *  - escrituras de usuarios/roles/demo, restore y mantenimiento → 403;
 *  - 6 PIN equivocados → 429 con Retry-After, y el bloqueo tapa también al
 *    intento correcto; 10 logins fallidos → 429;
 *  - licencia readOnly/revocada: escrituras 403, lecturas y login pasan.
 * Parte 2 — handlers reales sobre una base temporal:
 *  - `imagePath` mandado por el cliente se ignora; una ruta guardada fuera de
 *    article-images/ no se lee ni se borra (A10);
 *  - company:get como vendedor no trae catalogoToken;
 *  - catalogo:* exige permiso según el canal.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { BackupService } from '../backup/BackupService';
import { HardwareManager } from '../hardware/HardwareManager';
import { ExcelImportService } from '../import/ExcelImportService';
import { LicenseManager } from '../license/LicenseManager';
import { buildAllHandlers } from '../ipc/index';
import { SessionStore } from '../ipc/session-store';
import type { HandlerMap } from '../ipc/handler-context';
import type { IpcResponse } from '../ipc/types';
import { LanManager } from '../lan/LanManager';
import { LanServer, signJwt, verifyJwt } from '../lan/LanServer';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

interface Resp { status: number; body: IpcResponse<unknown> | null; headers: Headers }

async function rpc(url: string, body: unknown, jwt?: string): Promise<Resp> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (jwt) headers.authorization = `Bearer ${jwt}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  let parsed: IpcResponse<unknown> | null = null;
  try {
    parsed = (await res.json()) as IpcResponse<unknown>;
  } catch {
    /* sin cuerpo */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const ok = (data: unknown): IpcResponse<unknown> => ({ ok: true, data });

type U = Parameters<InstanceType<typeof SessionStore>['setSession']>[0];
const ADMIN = { id: 'admin-1', username: 'admin', fullName: 'Admin', role: 'admin', active: true, createdAt: 0, updatedAt: 0 } as unknown as U;
const VENDEDOR = { id: 'vend-1', username: 'vendedor', fullName: 'Vend', role: 'seller', active: true, createdAt: 0, updatedAt: 0 } as unknown as U;

function mockHandlers(): HandlerMap {
  const h: HandlerMap = {
    'auth:login': async (payload) => {
      const p = payload as { username?: string; password?: string };
      if (p?.password !== 'ok') return { ok: false, code: 'VALIDATION', message: 'Credenciales inválidas' };
      return ok({ user: { id: p.username === 'admin' ? 'admin-1' : 'vend-1' }, sessionToken: 'core' });
    },
  };
  for (const ch of [
    'articles:list', 'sales:create', 'sales:get', 'cash:open', 'users:list', 'users:create',
    'roles:getConfig', 'roles:setConfig', 'demo:status', 'demo:load', 'backup:list', 'backup:restore',
    'maintenance:resetOperationalData', 'license:deactivate', 'updater:quitAndInstall',
    'lan:applyAndRestart', 'system:pickFile', 'fiscal:issueInvoice', 'fiscal:listVouchers',
    'catalogo:pedidoConvertir', 'catalogo:pedidosListar', 'company:get', 'company:upsert',
    'facturas:obtener', 'facturas:foto', 'facturas:seguir', 'facturas:guardar', 'facturas:marcarCargada',
  ]) {
    h[ch] = async () => ok({ canal: ch });
  }
  return h;
}

function resolveUser(id: string): U | null {
  if (id === 'admin-1') return ADMIN;
  if (id === 'vend-1') return VENDEDOR;
  return null;
}

const PIN = '123456';
const SECRETO = 'secreto-del-servidor';
const SECRETO_VIEJO = `${PIN}:stockflow-lan-jwt`;
const silencio = { info: () => {}, warn: () => {}, error: () => {} };

async function parteServidor(): Promise<void> {
  console.log('\n[1] LanServer: secreto, allowlist, fuerza bruta, licencia');
  const PORT = 47741;
  const server = new LanServer({
    handlers: mockHandlers(),
    port: PORT,
    token: PIN,
    jwtSecret: SECRETO,
    sessionStore: new SessionStore(),
    resolveUser,
    log: silencio,
  });
  await server.start();
  const url = `http://127.0.0.1:${PORT}/lan/rpc`;
  const exp = Math.floor(Date.now() / 1000) + 600;
  const jwtAdminFalso = signJwt({ sub: 'admin-1', exp }, SECRETO_VIEJO);
  const jwtAdmin = signJwt({ sub: 'admin-1', exp }, SECRETO);
  const jwtVend = signJwt({ sub: 'vend-1', exp }, SECRETO);

  // --- C3: el secreto ya no es el PIN
  const r1 = await rpc(url, { channel: 'articles:list', token: PIN }, jwtAdminFalso);
  check('JWT firmado con el PIN → 401', r1.status === 401, JSON.stringify(r1.body));
  const r2 = await rpc(url, { channel: 'articles:list', token: PIN }, jwtAdmin);
  check('JWT firmado con el secreto del servidor → 200', r2.status === 200 && r2.body?.ok === true, JSON.stringify(r2.body));

  const login = await rpc(url, { channel: 'auth:login', payload: { username: 'vendedor', password: 'ok' }, token: PIN });
  const emitido = (login.body as { data?: { _lanSessionToken?: string } } | null)?.data?._lanSessionToken ?? '';
  check('auth:login por LAN devuelve _lanSessionToken', login.status === 200 && emitido.length > 20);
  check('el token emitido verifica con el secreto del servidor', verifyJwt(emitido, SECRETO)?.sub === 'vend-1');
  check('el token emitido NO verifica con el secreto derivado del PIN', verifyJwt(emitido, SECRETO_VIEJO) === null);

  // Sin jwtSecret configurado, el servidor se inventa uno: tampoco cae al PIN.
  {
    const PORT2 = 47742;
    const s2 = new LanServer({ handlers: mockHandlers(), port: PORT2, token: PIN, sessionStore: new SessionStore(), resolveUser, log: silencio });
    await s2.start();
    const r = await rpc(`http://127.0.0.1:${PORT2}/lan/rpc`, { channel: 'articles:list', token: PIN }, jwtAdminFalso);
    check('sin jwtSecret configurado, el JWT del PIN igual es rechazado', r.status === 401, String(r.status));
    await s2.stop();
  }

  // --- A9: allowlist de canales
  for (const canal of ['license:deactivate', 'updater:quitAndInstall', 'lan:applyAndRestart', 'system:pickFile']) {
    const rv = await rpc(url, { channel: canal, token: PIN }, jwtVend);
    const ra = await rpc(url, { channel: canal, token: PIN }, jwtAdmin);
    check(`${canal} → 403 para vendedor y para admin`, rv.status === 403 && ra.status === 403, `${rv.status}/${ra.status}`);
  }
  for (const canal of ['backup:restore', 'maintenance:resetOperationalData', 'users:create', 'roles:setConfig', 'demo:load']) {
    const ra = await rpc(url, { channel: canal, token: PIN }, jwtAdmin);
    check(`${canal} → 403 (se hace en el servidor)`, ra.status === 403, String(ra.status));
  }
  for (const canal of ['users:list', 'roles:getConfig', 'demo:status', 'backup:list', 'sales:create', 'fiscal:issueInvoice', 'catalogo:pedidoConvertir', 'company:get']) {
    const ra = await rpc(url, { channel: canal, token: PIN }, jwtAdmin);
    check(`${canal} → pasa al handler`, ra.status === 200 && ra.body?.ok === true, String(ra.status));
  }
  const proto = await rpc(url, { channel: 'constructor', token: PIN }, jwtAdmin);
  check("'constructor' como canal → 403 (no 200)", proto.status === 403, String(proto.status));
  const noReg = await rpc(url, { channel: 'articles:noExiste', token: PIN }, jwtAdmin);
  check('canal de grupo permitido pero no registrado → 404', noReg.status === 404, String(noReg.status));

  // --- Fuerza bruta contra la contraseña (mismo servidor, antes del PIN)
  let ultimo: Resp | null = null;
  for (let i = 0; i < 10; i++) {
    ultimo = await rpc(url, { channel: 'auth:login', payload: { username: 'admin', password: 'mala' }, token: PIN });
  }
  check('10 logins fallidos → todavía 200 (ok:false)', ultimo?.status === 200 && ultimo.body?.ok === false, String(ultimo?.status));
  const login11 = await rpc(url, { channel: 'auth:login', payload: { username: 'admin', password: 'ok' }, token: PIN });
  check('login 11 (aun con la clave correcta) → 429', login11.status === 429, String(login11.status));
  const otroCanal = await rpc(url, { channel: 'articles:list', token: PIN }, jwtAdmin);
  check('el bloqueo de login no afecta a las sesiones ya abiertas', otroCanal.status === 200, String(otroCanal.status));

  // --- Fuerza bruta contra el PIN
  let r429: Resp | null = null;
  for (let i = 0; i < 6; i++) {
    r429 = await rpc(url, { channel: 'articles:list', token: `00000${i}` }, jwtAdmin);
    if (i < 5) check(`PIN equivocado ${i + 1} → 401`, r429.status === 401, String(r429.status));
  }
  check('PIN equivocado 6 → 429', r429?.status === 429, String(r429?.status));
  const retry = Number(r429?.headers.get('retry-after') ?? 0);
  check('429 trae Retry-After en segundos (1..600)', retry >= 1 && retry <= 600, `retry-after=${retry}`);
  const correctoBloqueado = await rpc(url, { channel: 'articles:list', token: PIN }, jwtAdmin);
  check('con el bloqueo puesto, el PIN correcto también recibe 429', correctoBloqueado.status === 429, String(correctoBloqueado.status));
  await server.stop();

  // --- Licencia en sólo lectura / revocada
  // Un puerto por estado: fetch reusa la conexión keep-alive al mismo puerto
  // y, tras cerrar un servidor, el siguiente pedido se caería con ECONNRESET.
  let PORT3 = 47743;
  for (const estado of ['readOnly', 'revoked', 'unlicensed'] as const) {
    PORT3 += 1;
    const s3 = new LanServer({
      handlers: mockHandlers(), port: PORT3, token: PIN, jwtSecret: SECRETO,
      sessionStore: new SessionStore(), resolveUser, log: silencio,
      licenseStatus: () => estado,
    });
    await s3.start();
    const u3 = `http://127.0.0.1:${PORT3}/lan/rpc`;
    const w = await rpc(u3, { channel: 'sales:create', token: PIN }, jwtAdmin);
    const w2 = await rpc(u3, { channel: 'cash:open', token: PIN }, jwtAdmin);
    const w3 = await rpc(u3, { channel: 'catalogo:pedidoConvertir', token: PIN }, jwtAdmin);
    const w4 = await rpc(u3, { channel: 'fiscal:issueInvoice', token: PIN }, jwtAdmin);
    const w5 = await rpc(u3, { channel: 'facturas:guardar', token: PIN }, jwtAdmin);
    const w6 = await rpc(u3, { channel: 'facturas:marcarCargada', token: PIN }, jwtAdmin);
    const rd = await rpc(u3, { channel: 'sales:get', token: PIN }, jwtAdmin);
    const rd2 = await rpc(u3, { channel: 'catalogo:pedidosListar', token: PIN }, jwtAdmin);
    // Facturas por teléfono desde un puesto: abrir una factura, ver la foto y
    // seguir la que está en revisión son consultas (antes caían en 403).
    const rd3 = await rpc(u3, { channel: 'facturas:obtener', token: PIN }, jwtAdmin);
    const rd4 = await rpc(u3, { channel: 'facturas:foto', token: PIN }, jwtAdmin);
    const rd5 = await rpc(u3, { channel: 'facturas:seguir', token: PIN }, jwtAdmin);
    const lg = await rpc(u3, { channel: 'auth:login', payload: { username: 'admin', password: 'ok' }, token: PIN });
    check(
      `licencia ${estado}: escrituras → 403`,
      w.status === 403 && w2.status === 403 && w3.status === 403 && w4.status === 403 && w5.status === 403 && w6.status === 403 && /sólo lectura/.test(w.body?.ok === false ? w.body.message : ''),
      `${w.status}/${w2.status}/${w3.status}/${w4.status}/${w5.status}/${w6.status} ${JSON.stringify(w.body)}`,
    );
    check(
      `licencia ${estado}: lecturas (también facturas:obtener/foto/seguir) y login → 200`,
      rd.status === 200 && rd2.status === 200 && rd3.status === 200 && rd4.status === 200 && rd5.status === 200 && lg.status === 200,
      `${rd.status}/${rd2.status}/${rd3.status}/${rd4.status}/${rd5.status}/${lg.status}`,
    );
    await s3.stop();
  }

  // --- soloTunel: el comercio de UNA PC tiene acceso remoto sin exponer la red
  // La 1.10.0 salió con el túnel atado al modo servidor, así que en un comercio
  // de una sola PC la pestaña de Acceso remoto quedaba vacía (Denver, 25-sep).
  // Al arreglarlo hay que sostener las DOS mitades: que la puerta del túnel
  // abra, y que NO aparezca nada escuchando en la red local.
  {
    const PUERTO_TUNEL = 47751;
    const PUERTO_LAN = 47752;
    const s4 = new LanServer({
      handlers: mockHandlers(),
      soloTunel: true,
      tunnelPort: PUERTO_TUNEL,
      port: PUERTO_LAN,
      token: PIN,
      jwtSecret: SECRETO,
      sessionStore: new SessionStore(),
      resolveUser,
      log: silencio,
    });
    await s4.start();

    // Por la puerta del túnel se entra SIN el PIN de la red local.
    const sinPin = await rpc(`http://127.0.0.1:${PUERTO_TUNEL}/lan/rpc`, { channel: 'articles:list' }, jwtAdmin);
    check('soloTunel: la puerta del túnel atiende y no pide PIN', sinPin.status === 200, String(sinPin.status));

    // Y la lista corta de internet se sigue aplicando por esa puerta.
    const vedado = await rpc(`http://127.0.0.1:${PUERTO_TUNEL}/lan/rpc`, { channel: 'backup:restore' }, jwtAdmin);
    check('soloTunel: los canales vedados desde internet siguen en 403', vedado.status === 403, String(vedado.status));

    // Nada en el puerto de la red local: es el punto de todo el modo.
    let escuchaEnLaRed = false;
    try {
      await fetch(`http://127.0.0.1:${PUERTO_LAN}/lan/ping`, { signal: AbortSignal.timeout(1500) });
      escuchaEnLaRed = true;
    } catch {
      // no contesta: no escucha en la red
    }
    check('soloTunel: NO escucha en el puerto de la red local', !escuchaEnLaRed);

    await s4.stop();
  }

  // --- LanManager: el secreto persiste y sobrevive a setConfig; rotar lo cambia
  {
    const dir = mkdtempSync(join(tmpdir(), 'stockflow-lan-secret-'));
    const mgr = new LanManager(dir);
    const s1 = mgr.getOrCreateJwtSecret();
    const s1b = new LanManager(dir).getOrCreateJwtSecret();
    check('LanManager: el secreto se genera una vez y se relee igual', s1.length === 64 && s1 === s1b);
    mgr.setConfig({ mode: 'server', port: 7777, token: '654321' });
    check('LanManager: setConfig conserva el secreto', new LanManager(dir).getOrCreateJwtSecret() === s1);
    check('LanManager: getConfig no expone el secreto', !JSON.stringify(mgr.getConfig()).includes(s1));
    const s2 = mgr.rotateJwtSecret();
    check('LanManager: rotateJwtSecret cambia el secreto y lo persiste', s2 !== s1 && new LanManager(dir).getOrCreateJwtSecret() === s2);
    check('LanManager: la config sigue intacta tras rotar', new LanManager(dir).getConfig().token === '654321');
    rmSync(dir, { recursive: true, force: true });
  }
}

async function invoke<T = unknown>(handlers: HandlerMap, channel: string, payload?: unknown): Promise<IpcResponse<T>> {
  const handler = handlers[channel];
  if (!handler) throw new Error(`canal IPC no registrado: ${channel}`);
  return (await handler(payload)) as IpcResponse<T>;
}

async function parteHandlers(): Promise<void> {
  console.log('\n[2] Handlers reales: imagePath, company:get, catalogo:*');
  process.env.NODE_ENV = 'test';
  process.env.STOCKFLOW_SESSION_SECRET = 'seguridad-lan-smoke';
  const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-seguridad-lan-'));
  const dbPath = join(tmpDir, 'stockflow.db');
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);
  const sessionStore = new SessionStore();
  const handlers = buildAllHandlers({
    db,
    repos,
    sessionStore,
    machineId: 'test-machine',
    appVersion: '0.0.0-test',
    dbPath,
    userDataDir: tmpDir,
    licenseManager: new LicenseManager({ userDataDir: tmpDir, machineId: 'test-machine', apiUrl: 'http://localhost:1', publicKeyPem: '' }),
    hardware: new HardwareManager({ userDataDir: tmpDir }),
    backup: new BackupService({ dbPath, backupDir: tmpDir, appVersion: '0.0.0-test' }),
    importService: new ExcelImportService(),
    emit: () => {},
  });

  // Un "secreto" del servidor que ningún imagePath tiene que poder leer ni borrar.
  const arcaDir = join(tmpDir, 'arca');
  const clave = join(arcaDir, 'clave.key');
  mkdirSync(arcaDir, { recursive: true });
  writeFileSync(clave, '-----BEGIN PRIVATE KEY-----\nsecreto\n', 'utf8');

  const login = await invoke(handlers, 'auth:login', { username: 'admin', password: 'admin36724776' });
  check('login admin', login.ok);
  const vend = await invoke<{ id: string }>(handlers, 'users:create', { username: 'vend', password: 'vend1234', fullName: 'Vendedor', role: 'seller' });
  check('alta de vendedor', vend.ok, JSON.stringify(vend).slice(0, 160));
  const comp = await invoke(handlers, 'company:upsert', { name: 'Mi Empresa', catalogoToken: 'tok-secreto' });
  check('company:upsert con catalogoToken', comp.ok, JSON.stringify(comp).slice(0, 160));

  // --- A10: imagePath
  const creado = await invoke<{ id: string; imagePath: string | null }>(handlers, 'articles:create', {
    barcode: '7790000011111', description: 'Artículo seguridad', listPrice1: '100.0000', stock: '1.000', minStock: '0.000',
    imagePath: clave,
  });
  check('articles:create ignora imagePath del cliente', creado.ok && creado.data.imagePath == null, JSON.stringify(creado).slice(0, 200));
  if (!creado.ok) throw new Error('articles:create falló');
  const artId = creado.data.id;

  const upd = await invoke<{ imagePath: string | null }>(handlers, 'articles:update', { id: artId, data: { description: 'Artículo seguridad 2', imagePath: clave } });
  check('articles:update ignora imagePath del cliente', upd.ok && upd.data.imagePath == null, JSON.stringify(upd).slice(0, 200));
  const updRel = await invoke<{ imagePath: string | null }>(handlers, 'articles:update', { id: artId, data: { imagePath: '../arca/clave.key' } });
  check('articles:update ignora imagePath relativo con ..', updRel.ok && updRel.data.imagePath == null, JSON.stringify(updRel).slice(0, 200));

  // Fila "heredada" que ya apunta afuera (base migrada o tocada a mano).
  await repos.articles.update(artId, { imagePath: clave });
  const leida = await invoke<{ dataUrl: string | null }>(handlers, 'articles:getImageDataUrl', { articleId: artId });
  check('getImageDataUrl con imagePath fuera de article-images → null', leida.ok && leida.data.dataUrl === null, JSON.stringify(leida).slice(0, 120));
  const quitada = await invoke(handlers, 'articles:removeImage', { articleId: artId });
  check('removeImage con imagePath fuera → no borra el archivo', quitada.ok && existsSync(clave));
  await repos.articles.update(artId, { imagePath: '../arca/clave.key' });
  const leida2 = await invoke<{ dataUrl: string | null }>(handlers, 'articles:getImageDataUrl', { articleId: artId });
  check('getImageDataUrl con ../ → null', leida2.ok && leida2.data.dataUrl === null);
  const borrado = await invoke(handlers, 'articles:delete', { id: artId });
  check('articles:delete con imagePath fuera → el archivo sigue', borrado.ok && existsSync(clave));

  // Camino feliz: la imagen bien guardada se sigue leyendo y borrando.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  const pngPath = join(tmpDir, 'sample.png');
  writeFileSync(pngPath, png);
  const art2 = await invoke<{ id: string }>(handlers, 'articles:create', {
    barcode: '7790000022222', description: 'Con imagen', listPrice1: '100.0000', stock: '1.000', minStock: '0.000',
  });
  if (!art2.ok) throw new Error('articles:create 2 falló');
  const subida = await invoke<{ imagePath: string }>(handlers, 'articles:uploadImage', { articleId: art2.data.id, sourcePath: pngPath });
  const leidaOk = await invoke<{ dataUrl: string | null }>(handlers, 'articles:getImageDataUrl', { articleId: art2.data.id });
  check('imagen legítima: upload + getImageDataUrl siguen funcionando', subida.ok && leidaOk.ok && (leidaOk.data.dataUrl ?? '').startsWith('data:image/png'));
  const absImg = subida.ok ? join(tmpDir, subida.data.imagePath) : '';
  const quitadaOk = await invoke(handlers, 'articles:removeImage', { articleId: art2.data.id });
  check('imagen legítima: removeImage borra el archivo', quitadaOk.ok && absImg !== '' && !existsSync(absImg));

  // --- company:get: el token del catálogo sólo para manage_company
  const compAdmin = await invoke<{ catalogoToken: string | null }>(handlers, 'company:get');
  check('company:get como admin trae catalogoToken', compAdmin.ok && compAdmin.data.catalogoToken === 'tok-secreto');

  // --- catalogo:* como admin (para contrastar): el rechazo de un id inexistente llega a la validación
  const rechAdmin = await invoke(handlers, 'catalogo:pedidoRechazar', { id: 'no-existe' });
  check('catalogo:pedidoRechazar como admin pasa el permiso (falla por id)', !rechAdmin.ok && rechAdmin.code === 'VALIDATION', JSON.stringify(rechAdmin));

  await invoke(handlers, 'auth:logout');
  const loginVend = await invoke(handlers, 'auth:login', { username: 'vend', password: 'vend1234' });
  check('login vendedor', loginVend.ok, JSON.stringify(loginVend).slice(0, 160));

  const compVend = await invoke<{ name: string; catalogoToken: string | null }>(handlers, 'company:get');
  check('company:get como vendedor NO trae catalogoToken', compVend.ok && compVend.data.catalogoToken === null && compVend.data.name === 'Mi Empresa', JSON.stringify(compVend).slice(0, 160));

  for (const canal of ['catalogo:syncActivar', 'catalogo:syncAhora', 'catalogo:vincularLote', 'catalogo:sugerirVinculacion', 'catalogo:pedidoRechazar']) {
    const r = await invoke(handlers, canal, { id: 'x', activo: true, vinculos: [] });
    check(`${canal} como vendedor → PERMISSION_DENIED`, !r.ok && r.code === 'PERMISSION_DENIED', JSON.stringify(r).slice(0, 120));
  }
  const conv = await invoke(handlers, 'catalogo:pedidoConvertir', { id: 'no-existe', paymentMethodId: 'x' });
  check('catalogo:pedidoConvertir como vendedor pasa el permiso (falla por id)', !conv.ok && conv.code === 'VALIDATION', JSON.stringify(conv).slice(0, 120));
  const cont = await invoke<{ pendientes: number }>(handlers, 'catalogo:pedidosContarPendientes');
  const lst = await invoke<unknown[]>(handlers, 'catalogo:pedidosListar', {});
  const est = await invoke(handlers, 'catalogo:syncEstado');
  check('catalogo lecturas como vendedor → ok', cont.ok && lst.ok && est.ok, `${JSON.stringify(cont)} ${JSON.stringify(est).slice(0, 80)}`);

  closeLocalDb(db);
  rmSync(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  await parteServidor();
  await parteHandlers();
  if (failures > 0) {
    console.error(`\nTEST SEGURIDAD LAN FALLÓ — ${failures} check(s) con error.\n`);
    process.exit(1);
  }
  /* ------------------------------------------------------------------ */
  console.log('\n[ACCESO REMOTO] desde afuera se hace todo MENOS vender');
  {
    const { remotoAccepts, lanServerAccepts } = await import('../preload-bridge');
    // Pedido de Bruno (7-oct-2026): entrar desde afuera y encontrarse botones
    // muertos obligaba a ir hasta el local por una tarea de dos minutos. Lo que
    // protege es el usuario, su contraseña y su ROL — igual que en el mostrador.
    // Lo ÚNICO que no se hace desde afuera: vender. No es seguridad, es
    // licencias: si se pudiera cobrar desde una tablet, esa tablet sería una
    // caja más sin terminal paga (Bruno, 7-oct-2026).
    check('desde afuera NO se registra una venta', remotoAccepts('sales:create') === false);
    check(
      'desde afuera SÍ se mueve la caja y se cobra una cuenta corriente',
      remotoAccepts('cash:addMovement') && remotoAccepts('accounts:receivePayment'),
    );
    check(
      'desde afuera SÍ se devuelve y se anula (no es vender, y hace falta cuando el dueño no está)',
      remotoAccepts('returns:createForSale') && remotoAccepts('sales:void'),
    );
    check('desde afuera SÍ se consulta', remotoAccepts('articles:list') && remotoAccepts('sales:get'));
    check(
      'desde afuera SÍ se compra y se paga al proveedor',
      remotoAccepts('purchases:create') && remotoAccepts('supplierAccounts:registerPayment'),
    );
    check(
      'desde afuera SÍ se borra un artículo o un cliente (lo decide el rol, no la puerta)',
      remotoAccepts('articles:delete') && remotoAccepts('customers:delete'),
    );
    check('desde afuera SÍ se emite factura', remotoAccepts('fiscal:issueInvoice'));
    check('desde afuera SÍ se cambia la ficha del comercio', remotoAccepts('company:upsert'));
    check('desde afuera SÍ se actualizan precios', remotoAccepts('priceUpdate:apply'));
    // Lo que necesita estar sentado en la PC del servidor sigue afuera, igual
    // que para una terminal: no es una restricción del túnel.
    check(
      'lo que se hace sentado en el servidor sigue sin hacerse desde afuera',
      remotoAccepts('backup:restore') === false &&
        remotoAccepts('users:create') === false &&
        remotoAccepts('maintenance:resetOperationalData') === false &&
        remotoAccepts('assistant:iaInstalarOllama') === false,
    );
    check(
      'salvo vender, el túnel no recorta nada: lo que pasa por la red local pasa por el túnel',
      ['articles:delete', 'fiscal:issueInvoice', 'company:upsert', 'purchases:create', 'priceUpdate:apply',
       'backup:restore', 'users:create', 'maintenance:resetOperationalData']
        .every((c) => remotoAccepts(c) === lanServerAccepts(c)),
    );
    check(
      'vender SÍ se puede desde una terminal del local',
      lanServerAccepts('sales:create') === true,
    );
  }

  console.log('\n✅ TODO OK — TEST SEGURIDAD LAN\n');
}

main().catch((err) => {
  console.error('\n✗ Excepción durante el test de seguridad LAN:', err);
  process.exit(1);
});
