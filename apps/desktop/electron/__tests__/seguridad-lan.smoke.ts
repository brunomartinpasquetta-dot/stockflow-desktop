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
import { hostname, tmpdir } from 'node:os';
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
import { DispositivosSucursal, obtenerDispositivos, planMultisucursal, pruebaEsperada, VIGENCIA_CODIGO_MS, type SqliteLike } from '../lan/dispositivos';
import { obtenerTerminalActual, type TerminalActual } from '../ipc/terminal-actual';
import { createCaller, esHostDeRedLocal, normalizarUrlServidor, type IdentidadTerminal } from '../preload-bridge';
import { createServer } from 'node:http';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

interface Resp { status: number; body: IpcResponse<unknown> | null; headers: Headers }

async function rpc(url: string, body: unknown, jwt?: string, extra: Record<string, string> = {}): Promise<Resp> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
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
  const msj429 = r429?.body?.ok === false ? r429.body.message : '';
  check('el aviso del bloqueo dice los MINUTOS (no "587 segundos")', /Espere 10 minutos y vuelva a intentar\.$/.test(msj429) && !/segundos/.test(msj429), msj429);
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

/**
 * http:// sin cifrar SÓLO dentro de la red del local. Un nombre de internet
 * que empieza con "fc"/"fd" (una farmacia "Fcia. …") contaba como red local
 * y la PC de sucursal mandaba contraseña, sesión, token y código en claro.
 */
function parteDirecciones(): void {
  console.log('\n[direcciones] http:// sólo en la red del local');
  for (const host of ['fcia-del-centro.mistockflow.com', 'fd-x.com', 'fdxx.com', 'fe80.mistockflow.com', 'febo.mistockflow.com', 'fc::1', '2001:db8::1']) {
    check(`"${host}" NO es de la red local`, !esHostDeRedLocal(host));
  }
  for (const host of ['fd00::1', '[fd12:3456::1]', 'fc00::5', 'fe80::1', '[fe80::abcd]', '::1', '192.168.1.10', '100.70.1.2', 'caja.local', 'localhost']) {
    check(`"${host}" es de la red local`, esHostDeRedLocal(host));
  }
  const sinEsquema = normalizarUrlServidor('fcia-del-centro.mistockflow.com');
  check('"fcia-del-centro.mistockflow.com" sin esquema → https://', sinEsquema.ok && sinEsquema.url === 'https://fcia-del-centro.mistockflow.com', JSON.stringify(sinEsquema));
  for (const url of ['http://fcia-x.mistockflow.com', 'http://fd-x.com', 'http://fc-algo.com.ar:7777']) {
    check(`"${url}" (http por internet) → rechazada`, !normalizarUrlServidor(url).ok, JSON.stringify(normalizarUrlServidor(url)));
  }
  const ula = normalizarUrlServidor('http://[fd00::1]:7777');
  check('http://[fd00::1]:7777 (IPv6 de la red local) → se admite', ula.ok && ula.url === 'http://[fd00::1]:7777', JSON.stringify(ula));
}

async function main(): Promise<void> {
  await parteServidor();
  await parteHandlers();
  await parteSucursal();
  parteDirecciones();
  if (failures > 0) {
    console.error(`\nTEST SEGURIDAD LAN FALLÓ — ${failures} check(s) con error.\n`);
    process.exit(1);
  }
  /* ------------------------------------------------------------------ */
  console.log('\n[ACCESO REMOTO] la puerta del túnel tiene menos permisos que la red local');
  {
    const { remotoAccepts } = await import('../preload-bridge');
    check('desde afuera NO se emite factura', remotoAccepts('fiscal:issueInvoice') === false);
    check(
      'desde afuera NO se importa ni se reinicia la operativa',
      remotoAccepts('import:execute') === false && remotoAccepts('maintenance:resetOperationalData') === false,
    );
    check('desde afuera NO se cambia la ficha del comercio', remotoAccepts('company:upsert') === false);
    check(
      'desde afuera NO se borran clientes ni artículos',
      remotoAccepts('customers:delete') === false && remotoAccepts('articles:delete') === false,
    );
    check(
      'desde afuera SÍ se vende y se cobra',
      remotoAccepts('sales:create') && remotoAccepts('cash:addMovement') && remotoAccepts('accounts:receivePayment'),
    );
    check('desde afuera SÍ se consulta', remotoAccepts('articles:list') && remotoAccepts('sales:get'));
    check(
      'lo prohibido por red sigue prohibido por el túnel',
      remotoAccepts('backup:restore') === false && remotoAccepts('users:create') === false,
    );
  }

  console.log('\n✅ TODO OK — TEST SEGURIDAD LAN\n');
}

main().catch((err) => {
  console.error('\n✗ Excepción durante el test de seguridad LAN:', err);
  process.exit(1);
});

/* ------------------------------------------------------------------------ */
/* [3] Multisucursal: PC de sucursal emparejadas                              */
/* ------------------------------------------------------------------------ */
async function parteSucursal(): Promise<void> {
  console.log('\n[3] PC de sucursal: emparejar, canales por el túnel, revocar, bloqueo por PC');
  process.env.NODE_ENV = 'test';
  process.env.STOCKFLOW_SESSION_SECRET = 'seguridad-lan-smoke';
  const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-sucursal-'));
  const dbPath = join(tmpDir, 'stockflow.db');
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);
  let reloj = Date.now();
  const auditados: string[] = [];
  const disp = new DispositivosSucursal(db.$client as unknown as SqliteLike, {
    ahora: () => reloj,
    auditar: (e) => auditados.push(e.description),
  });

  const handlers = mockHandlers();
  for (const ch of ['mpQr:createOrder', 'mpQr:setupCompany', 'fiscal:saveConfig', 'fiscal:deleteSalePoint', 'sales:voidRange', 'import:execute', 'articles:delete']) {
    handlers[ch] = async () => ok({ canal: ch });
  }
  handlers['articles:quienSoy'] = async () => ok(obtenerTerminalActual({ machineId: 'id-servidor' }));
  let multiActivo = true;
  const PORT = 47771;
  const PORT_T = 47772;
  const server = new LanServer({
    handlers, port: PORT, tunnelPort: PORT_T, token: PIN, jwtSecret: SECRETO,
    sessionStore: new SessionStore(), resolveUser, log: silencio,
    dispositivos: disp, multisucursalActivo: () => multiActivo, machineId: 'id-servidor',
  });
  await server.start();
  const uT = `http://127.0.0.1:${PORT_T}/lan/rpc`;
  const uL = `http://127.0.0.1:${PORT}/lan/rpc`;
  const emp = (puerto: number, body: unknown, xff?: string) =>
    rpc(`http://127.0.0.1:${puerto}/lan/emparejar`, body, undefined, xff ? { 'x-forwarded-for': xff } : {});
  const exp = Math.floor(Date.now() / 1000) + 600;
  const jwtAdmin = signJwt({ sub: 'admin-1', exp }, SECRETO);
  const MID_A = 'a1'.repeat(32);
  const MID_B = 'b2'.repeat(32);

  // --- Sin emparejar: el túnel sigue con la lista corta (como hoy)
  const fSin = await rpc(uT, { channel: 'fiscal:issueInvoice' }, jwtAdmin);
  const mSin = await rpc(uT, { channel: 'mpQr:createOrder' }, jwtAdmin);
  check('sin token: fiscal por el túnel → 403', fSin.status === 403, String(fSin.status));
  check('sin token: mpQr por el túnel → 403', mSin.status === 403, String(mSin.status));

  // --- Emparejar
  const c1 = disp.generarCodigo({ id: 'admin-1', nombre: 'Admin' });
  check('el código tiene 10 caracteres legibles (dos grupos)', /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(c1.codigo), c1.codigo);
  check('vence a los 15 minutos', c1.venceEn - reloj === VIGENCIA_CODIGO_MS);
  const canje = await emp(PORT_T, { codigo: c1.codigo.toLowerCase().replace('-', ' '), nombre: 'Caja San Carlos', machineId: MID_A }, '200.1.2.3');
  const tokA = (canje.body as { data?: { token?: string } } | null)?.data?.token ?? '';
  check('canje por el túnel (minúsculas y espacio) → token', canje.status === 200 && /^sfd1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(tokA), JSON.stringify(canje.body).slice(0, 120));
  const fila = db.$client.prepare('SELECT token_hash, machine_id, nombre, estado FROM dispositivos_sucursal').all() as { token_hash: string; machine_id: string; nombre: string; estado: string }[];
  check('el servidor guarda sólo el hash (no el token)', fila.length === 1 && fila[0]!.token_hash.length === 64 && !tokA.includes(fila[0]!.token_hash) && !JSON.stringify(fila).includes(tokA.split('.')[2]!));
  check('auditoría: emparejar queda registrado', auditados.some((d) => d.includes('emparejada') && d.includes('Caja San Carlos')));
  check(
    'auditoría del canje: red del visitante, vía, dispositivo y fragmento del machineId',
    auditados.some((d) => d.includes('emparejada') && d.includes('200.1.2.0/24 por internet') && d.includes('dispositivo ') && d.includes(MID_A.slice(0, 12))),
    auditados.join(' | '),
  );
  const reuso = await emp(PORT_T, { codigo: c1.codigo, nombre: 'Otra', machineId: MID_B }, '200.1.2.3');
  check('el mismo código usado otra vez → 401', reuso.status === 401, String(reuso.status));
  check('auditoría: el canje fallido queda como incidente', auditados.some((d) => /Canje de código de emparejamiento fallido/.test(d) && d.includes('200.1.2.0/24')), auditados.join(' | '));

  // --- Con token: canales de la red local por el túnel
  const H_A = { 'x-stockflow-dispositivo': tokA };
  const fCon = await rpc(uT, { channel: 'fiscal:issueInvoice' }, jwtAdmin, H_A);
  const mCon = await rpc(uT, { channel: 'mpQr:createOrder' }, jwtAdmin, H_A);
  check('con token: fiscal por el túnel → 200', fCon.status === 200 && fCon.body?.ok === true, String(fCon.status));
  check('con token: mpQr por el túnel → 200', mCon.status === 200, String(mCon.status));
  const vedado = await rpc(uT, { channel: 'backup:restore' }, jwtAdmin, H_A);
  const lic = await rpc(uT, { channel: 'license:deactivate' }, jwtAdmin, H_A);
  check('con token: lo que no cruza la red sigue en 403 (restore, licencia)', vedado.status === 403 && lic.status === 403);
  // Lista intermedia: facturar y cobrar sí; configurar ARCA/MP, la ficha, anular en bloque, importar y borrar, NO.
  for (const ch of ['mpQr:setupCompany', 'fiscal:saveConfig', 'fiscal:deleteSalePoint', 'company:upsert', 'sales:voidRange', 'import:execute', 'articles:delete']) {
    const r = await rpc(uT, { channel: ch }, jwtAdmin, H_A);
    check(`con token, por el túnel: ${ch} → 403 (sólo en el local)`, r.status === 403 && /PC de sucursal/.test(r.body?.ok === false ? r.body.message : ''), `${r.status} ${JSON.stringify(r.body)}`);
  }
  const fLeer = await rpc(uT, { channel: 'fiscal:listVouchers' }, jwtAdmin, H_A);
  check('con token, por el túnel: lecturas fiscales (fiscal:listVouchers) → 200', fLeer.status === 200, String(fLeer.status));
  const cfgLan = await rpc(uL, { channel: 'mpQr:setupCompany', token: PIN }, jwtAdmin);
  check('en la red local (con PIN) la configuración de MP sigue permitida', cfgLan.status === 200, String(cfgLan.status));
  const t = (await rpc(uT, { channel: 'articles:quienSoy' }, jwtAdmin, { ...H_A, 'x-stockflow-terminal': MID_B, 'x-stockflow-terminal-nombre': 'Impostora' })).body as { data?: TerminalActual } | null;
  check(
    'con token, la terminal es disp:<machineId registrado> aunque el encabezado diga otra',
    t?.data?.id === `disp:${MID_A}` && t.data.nombre === 'Caja San Carlos' && t.data.origen === 'tunel' && typeof t.data.dispositivoId === 'string',
    JSON.stringify(t?.data),
  );
  // Por el túnel SIN PC emparejada el encabezado de terminal se ignora: opera como el servidor.
  const tTun = (await rpc(uT, { channel: 'articles:quienSoy' }, jwtAdmin, { 'x-stockflow-terminal': MID_A, 'x-stockflow-terminal-nombre': 'Impostora' })).body as { data?: TerminalActual } | null;
  check(
    'túnel sin token declarando el machineId de una PC emparejada → opera como el servidor (no identificada)',
    tTun?.data?.id === 'id-servidor' && tTun.data.identificada === false && tTun.data.origen === 'tunel',
    JSON.stringify(tTun?.data),
  );
  // En la red local nadie puede declararse PC de sucursal.
  const tDisp = (await rpc(uL, { channel: 'articles:quienSoy', token: PIN }, jwtAdmin, { 'x-stockflow-terminal': `disp:${MID_A}` })).body as { data?: TerminalActual } | null;
  check('red local declarando disp:<machineId> → se ignora (opera como el servidor)', tDisp?.data?.id === 'id-servidor' && tDisp.data.identificada === false, JSON.stringify(tDisp?.data));
  const tLan = (await rpc(uL, { channel: 'articles:quienSoy', token: PIN }, jwtAdmin, { 'x-stockflow-terminal': MID_B, 'x-stockflow-terminal-nombre': 'Caja%202' })).body as { data?: TerminalActual } | null;
  check('red local con su machineId → identificada como esa PC (como antes)', tLan?.data?.id === MID_B && tLan.data.nombre === 'Caja 2', JSON.stringify(tLan?.data));
  // /lan/ping avisa que admite identidad y que acepta PC de sucursal.
  const ping = (await (await fetch(`http://127.0.0.1:${PORT_T}/lan/ping`)).json()) as { identidad?: boolean; sucursales?: boolean };
  check('/lan/ping informa identidad: true y sucursales: true', ping.identidad === true && ping.sucursales === true, JSON.stringify(ping));
  // "Terminales conectadas": por el túnel todo llega desde 127.0.0.1; cada
  // local (red del visitante) es una fila, y la app instalada figura como app.
  const UA_APP = 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) StockFlow/1.13.0 Chrome/124.0 Electron/30.5.1 Safari/537.36';
  await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { ...H_A, 'x-forwarded-for': '186.33.44.5', 'user-agent': UA_APP });
  await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { 'x-forwarded-for': '190.20.30.40', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/129.0 Safari/537.36' });
  const conectadas = server.getConnectedClients();
  const filaSucursal = conectadas.find((c) => c.ip === '186.33.44.0/24');
  const filaVisita = conectadas.find((c) => c.ip === '190.20.30.0/24');
  check(
    'terminales conectadas por el túnel: una fila por red, con el nombre de la PC de sucursal y "app instalada"',
    !!filaSucursal && filaSucursal.nombre === 'Caja San Carlos' && filaSucursal.via === 'app' && !!filaVisita && filaVisita.via === 'navegador',
    JSON.stringify(conectadas),
  );

  // --- La sesión iniciada con la PC queda atada a ella
  const loginA = await rpc(uT, { channel: 'auth:login', payload: { username: 'vendedor', password: 'ok' } }, undefined, H_A);
  const jwtA = (loginA.body as { data?: { _lanSessionToken?: string } } | null)?.data?._lanSessionToken ?? '';
  check('login desde la PC emparejada: el JWT lleva el dispositivo', !!verifyJwt(jwtA, SECRETO)?.dis);
  const robado = await rpc(uT, { channel: 'articles:list' }, jwtA);
  check('ese JWT usado SIN el token de la PC → 401', robado.status === 401, String(robado.status));
  const propio = await rpc(uT, { channel: 'articles:list' }, jwtA, H_A);
  check('ese JWT con su PC → 200', propio.status === 200, String(propio.status));

  // --- Token inventado o adulterado
  const adult = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { 'x-stockflow-dispositivo': tokA.slice(0, -2) + 'xx' }, );
  check('token adulterado → 401 con mensaje para el usuario', adult.status === 401 && /código de emparejamiento nuevo/.test(adult.body?.ok === false ? adult.body.message : ''), JSON.stringify(adult.body));

  // --- Bloqueo por PC: los errores de un cajero no bloquean a la sucursal
  const c2 = disp.generarCodigo(null);
  const canjeB = await emp(PORT, { codigo: c2.codigo, nombre: 'Caja 2 San Carlos', machineId: MID_B });
  const tokB = (canjeB.body as { data?: { token?: string } } | null)?.data?.token ?? '';
  check('canje también por la escucha de la red local', canjeB.status === 200 && tokB.startsWith('sfd1.'), String(canjeB.status));
  const H_B = { 'x-stockflow-dispositivo': tokB };
  const XFF = { 'x-forwarded-for': '181.10.20.30' };
  for (let i = 0; i < 10; i++) {
    await rpc(uT, { channel: 'auth:login', payload: { username: 'admin', password: 'mala' } }, undefined, { ...H_A, ...XFF });
  }
  const aBloq = await rpc(uT, { channel: 'auth:login', payload: { username: 'admin', password: 'ok' } }, undefined, { ...H_A, ...XFF });
  const bLibre = await rpc(uT, { channel: 'auth:login', payload: { username: 'admin', password: 'ok' } }, undefined, { ...H_B, ...XFF });
  const ipLibre = await rpc(uT, { channel: 'auth:login', payload: { username: 'admin', password: 'ok' } }, undefined, XFF);
  check('10 logins fallidos en la PC A → la PC A recibe 429', aBloq.status === 429, String(aBloq.status));
  check('la PC B de la misma sucursal (misma IP pública) entra igual', bLibre.status === 200 && bLibre.body?.ok === true, String(bLibre.status));
  check('una visita sin token desde esa IP tampoco quedó bloqueada', ipLibre.status === 200 && ipLibre.body?.ok === true, String(ipLibre.status));
  for (let i = 0; i < 5; i++) await rpc(uL, { channel: 'articles:list', token: `99999${i}` }, jwtAdmin, H_B);
  const pinB = await rpc(uL, { channel: 'articles:list', token: PIN }, jwtAdmin, H_B);
  const pinIp = await rpc(uL, { channel: 'articles:list', token: PIN }, jwtAdmin);
  check('5 PIN equivocados con la PC B → B bloqueada por PIN (429)', pinB.status === 429, String(pinB.status));
  check('el PIN de esa IP sin token sigue andando', pinIp.status === 200, String(pinIp.status));

  // --- Código vencido, código inventado y bloqueo del canje por IP
  const c3 = disp.generarCodigo(null);
  reloj += VIGENCIA_CODIGO_MS + 1000;
  const venc = await emp(PORT_T, { codigo: c3.codigo, nombre: 'Tarde', machineId: 'c3'.repeat(32) }, '190.5.5.5');
  check('código vencido → 401 "venció"', venc.status === 401 && /venció/.test(venc.body?.ok === false ? venc.body.message : ''), JSON.stringify(venc.body));
  check('…con motivo "vencido" para la PC nueva', (venc.body as { motivo?: string } | null)?.motivo === 'vencido', JSON.stringify(venc.body));
  const c4 = disp.generarCodigo(null);
  for (let i = 0; i < 4; i++) await emp(PORT_T, { codigo: `ZZZZZ-ZZZZ${i + 2}`, nombre: 'X', machineId: 'c4'.repeat(32) }, '190.5.5.9');
  const bloqCanje = await emp(PORT_T, { codigo: c4.codigo, nombre: 'Buena', machineId: 'c4'.repeat(32) }, '190.5.5.20');
  check('5 canjes fallidos desde la misma /24 → 429, aun con el código bueno', bloqCanje.status === 429 && !!bloqCanje.headers.get('retry-after'), String(bloqCanje.status));
  const otraRed = await emp(PORT_T, { codigo: c4.codigo, nombre: 'Buena', machineId: 'c4'.repeat(32) }, '201.7.7.7');
  check('desde otra red el código bueno se canjea', otraRed.status === 200, String(otraRed.status));
  const sinDatos = await emp(PORT_T, { codigo: disp.generarCodigo(null).codigo, nombre: '', machineId: 'x' }, '202.1.1.1');
  check('canje sin nombre/machineId válidos → 400', sinDatos.status === 400, String(sinDatos.status));
  // Tokens inventados: contador propio; frena a los inválidos, NUNCA a un token válido.
  for (let i = 0; i < 5; i++) await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { 'x-stockflow-dispositivo': `sfd1.00000000-0000-0000-0000-00000000000${i}.nada`, 'x-forwarded-for': '203.0.113.9' });
  const tokBloq = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { 'x-stockflow-dispositivo': 'sfd1.00000000-0000-0000-0000-000000000009.nada', 'x-forwarded-for': '203.0.113.9' });
  check('5 tokens inventados desde una IP → el siguiente inventado recibe 429', tokBloq.status === 429, String(tokBloq.status));
  const validoMismaIp = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { ...H_A, 'x-forwarded-for': '203.0.113.10' });
  check('…pero una PC con token VÁLIDO desde esa misma red sigue operando (200)', validoMismaIp.status === 200, String(validoMismaIp.status));
  // El caso del revisor: la CAJA-2 tipea mal el código 5 veces desde la sucursal; la CAJA-1 sigue vendiendo.
  for (let i = 0; i < 5; i++) await emp(PORT_T, { codigo: `YYYYY-YYYY${i + 2}`, nombre: 'Caja 2', machineId: 'd5'.repeat(32) }, '186.33.44.5');
  const caja2 = await emp(PORT_T, { codigo: 'YYYYY-YYYY9', nombre: 'Caja 2', machineId: 'd5'.repeat(32) }, '186.33.44.5');
  const caja1 = await rpc(uT, { channel: 'fiscal:issueInvoice' }, jwtAdmin, { ...H_A, 'x-forwarded-for': '186.33.44.6' });
  check('5 canjes fallidos en la sucursal → el canje queda en 429', caja2.status === 429, String(caja2.status));
  check('…y la caja ya emparejada de esa sucursal sigue facturando (200)', caja1.status === 200 && caja1.body?.ok === true, String(caja1.status));

  // --- Revocar
  const lista = disp.listar();
  const filaA = lista.find((d) => d.nombre === 'Caja San Carlos');
  check('listar: sin hashes, con estado', !!filaA && filaA.estado === 'activo' && !('token_hash' in (filaA as object)), JSON.stringify(lista).slice(0, 160));
  check('revocar → true', disp.revocar(filaA!.id, { id: 'admin-1', nombre: 'Admin' }));
  check('auditoría: revocar queda registrado', auditados.some((d) => d.includes('revocada') && d.includes('Caja San Carlos')));
  const trasRevocar = await rpc(uT, { channel: 'fiscal:issueInvoice' }, jwtAdmin, H_A);
  check('token revocado → 401 en el pedido siguiente', trasRevocar.status === 401, String(trasRevocar.status));
  check('revocar dos veces → false', disp.revocar(filaA!.id, null) === false);
  // Una PC revocada que sigue prendida reintenta: 401 siempre, sin bloquear a nadie.
  for (let i = 0; i < 12; i++) await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { ...H_A, 'x-forwarded-for': '170.1.1.1' });
  const revocadaSigue = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { ...H_A, 'x-forwarded-for': '170.1.1.1' });
  const vecinaB = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { ...H_B, 'x-forwarded-for': '170.1.1.2' });
  check('PC revocada que reintenta 12 veces → sigue en 401 (no 429)', revocadaSigue.status === 401, String(revocadaSigue.status));
  check('…y la PC vecina con token válido no se entera (200)', vecinaB.status === 200, String(vecinaB.status));
  check(
    'auditoría: el uso de un token revocado queda registrado UNA vez (no cada reintento)',
    auditados.filter((d) => /Pedido de una PC de sucursal revocada/.test(d)).length === 1,
    auditados.slice(-5).join(' | '),
  );
  // Ventana de incidentes nueva (el tope es por 10 minutos).
  reloj += 11 * 60_000;
  // Emparejar una PC que YA está activa no la reemplaza en silencio.
  const c5 = disp.generarCodigo(null);
  const ocupada = await emp(PORT_T, { codigo: c5.codigo, nombre: 'Impostora', machineId: MID_B }, '204.1.1.1');
  const bSigue = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { ...H_B, 'x-forwarded-for': '204.1.1.2' });
  check('canje con el machineId de una PC activa → 409 y NO se revoca la PC activa', ocupada.status === 409 && bSigue.status === 200, `${ocupada.status}/${bSigue.status}`);
  check('auditoría: el emparejamiento rechazado queda registrado', auditados.some((d) => /Emparejamiento rechazado/.test(d) && d.includes('Impostora')), auditados.slice(-3).join(' | '));
  // El administrador revoca la vieja y el MISMO código sirve (no se consumió).
  const filaB = disp.listar().find((d) => d.nombre === 'Caja 2 San Carlos' && d.estado === 'activo');
  disp.revocar(filaB!.id, { id: 'admin-1', nombre: 'Admin' });
  const re = await emp(PORT_T, { codigo: c5.codigo, nombre: 'Caja 2 San Carlos (nueva)', machineId: MID_B }, '204.1.1.1');
  const tokB2 = (re.body as { data?: { token?: string } } | null)?.data?.token ?? '';
  const viejoB = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { ...H_B, 'x-forwarded-for': '204.1.1.2' });
  const nuevoB = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { 'x-stockflow-dispositivo': tokB2, 'x-forwarded-for': '204.1.1.3' });
  check('revocada la vieja, el mismo código empareja: el token viejo 401 y el nuevo 200', re.status === 200 && viejoB.status === 401 && nuevoB.status === 200, `${re.status}/${viejoB.status}/${nuevoB.status}`);
  const filaNueva = disp.listar().find((d) => d.nombre === 'Caja 2 San Carlos (nueva)');
  check(
    'listar: fragmentos de id y de PC, desde dónde se emparejó y la última red',
    !!filaNueva && filaNueva.idCorto.length === 8 && filaNueva.pcCorta === MID_B.slice(0, 8) && filaNueva.creadoDesde === '204.1.1.0/24 por internet' && filaNueva.ultimaIp === '204.1.1.0/24',
    JSON.stringify(filaNueva),
  );
  // Tope de incidentes: 40 canjes fallidos más no llenan audit_log.
  const antes = auditados.length;
  for (let i = 0; i < 40; i++) await emp(PORT_T, { codigo: 'QQQQQ-QQQQQ', nombre: 'X', machineId: 'e6'.repeat(32) }, `150.${i}.1.1`);
  check('tope de incidentes: 40 canjes fallidos dejan como mucho 21 líneas de auditoría', auditados.length - antes <= 21, String(auditados.length - antes));

  // --- Sin la edición Multisucursal: todo como antes
  multiActivo = false;
  const sinPlanEmp = await emp(PORT_T, { codigo: disp.generarCodigo(null).codigo, nombre: 'X', machineId: 'c6'.repeat(32) }, '205.1.1.1');
  const sinPlanFiscal = await rpc(uT, { channel: 'fiscal:issueInvoice' }, jwtAdmin, { 'x-stockflow-dispositivo': tokB2 });
  const sinPlanLista = await rpc(uT, { channel: 'articles:list' }, jwtAdmin, { 'x-stockflow-dispositivo': tokB2 });
  check('sin edición Multisucursal: /lan/emparejar → 404', sinPlanEmp.status === 404, String(sinPlanEmp.status));
  check('sin edición Multisucursal: el token se ignora (fiscal por el túnel → 403, lecturas → 200)', sinPlanFiscal.status === 403 && sinPlanLista.status === 200, `${sinPlanFiscal.status}/${sinPlanLista.status}`);
  check(
    'sin edición: el 403 explica que el comercio ya no tiene Multisucursal',
    /ya no tiene la licencia Multisucursal/.test(sinPlanFiscal.body?.ok === false ? sinPlanFiscal.body.message : ''),
    JSON.stringify(sinPlanFiscal.body),
  );
  const loginB2 = await (async () => {
    multiActivo = true;
    const r = await rpc(uT, { channel: 'auth:login', payload: { username: 'vendedor', password: 'ok' } }, undefined, { 'x-stockflow-dispositivo': tokB2 });
    multiActivo = false;
    return (r.body as { data?: { _lanSessionToken?: string } } | null)?.data?._lanSessionToken ?? '';
  })();
  const sesionVieja = await rpc(uT, { channel: 'articles:list' }, loginB2, { 'x-stockflow-dispositivo': tokB2 });
  check(
    'sin edición: una sesión iniciada como PC de sucursal → 401 que pide iniciar sesión de nuevo y lo explica',
    sesionVieja.status === 401 && /ya no tiene la licencia Multisucursal/.test(sesionVieja.body?.ok === false ? sesionVieja.body.message : ''),
    JSON.stringify(sesionVieja.body),
  );
  const pingSin = (await (await fetch(`http://127.0.0.1:${PORT_T}/lan/ping`)).json()) as { sucursales?: boolean };
  check('sin edición: /lan/ping informa sucursales: false', pingSin.sucursales === false, JSON.stringify(pingSin));
  multiActivo = true;
  await server.stop();

  // --- Handlers reales: generar/listar/revocar desde Configuración + terminal que canjea
  const lm = new LicenseManager({ userDataDir: tmpDir, machineId: 'servidor-machine', apiUrl: 'http://localhost:1', publicKeyPem: '' });
  const sessionStore = new SessionStore();
  const depsSrv = {
    db, repos, sessionStore, machineId: 'servidor-machine', appVersion: '0.0.0-test', dbPath, userDataDir: tmpDir,
    licenseManager: lm, hardware: new HardwareManager({ userDataDir: tmpDir }),
    backup: new BackupService({ dbPath, backupDir: tmpDir, appVersion: '0.0.0-test' }),
    importService: new ExcelImportService(), emit: () => {},
  };
  const hs = buildAllHandlers(depsSrv);
  const login = await invoke(hs, 'auth:login', { username: 'admin', password: 'admin36724776' });
  check('[handlers] login admin', login.ok);
  const sinPlan = await invoke(hs, 'lan:emparejarGenerarCodigo');
  check('[handlers] sin edición Multisucursal no se generan códigos', !sinPlan.ok && /Multisucursal/.test(sinPlan.ok ? '' : sinPlan.message), JSON.stringify(sinPlan));
  const original = lm.getState.bind(lm);
  (lm as { getState: () => unknown }).getState = () => ({ ...original(), edicion: 'multisucursal' });
  const cod = await invoke<{ codigo: string; venceEn: number }>(hs, 'lan:emparejarGenerarCodigo');
  check('[handlers] admin con Multisucursal genera código', cod.ok && /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(cod.data.codigo), JSON.stringify(cod));

  // Interruptor "Edición Multisucursal (versión de prueba)": el LanServer lo
  // ve en vivo por `planMultisucursal(licenseManager)`, sin reiniciar nada.
  {
    const tmpBeta = mkdtempSync(join(tmpdir(), 'stockflow-beta-'));
    const lmBeta = new LicenseManager({ userDataDir: tmpBeta, machineId: 'servidor-machine', apiUrl: 'http://localhost:1', publicKeyPem: '', version: '1.13.0-beta.1' });
    const PORT_B = 47782;
    const srvBeta = new LanServer({
      handlers: hs, port: PORT_B, token: PIN, jwtSecret: SECRETO, sessionStore, log: silencio,
      resolveUser: async () => null,
      dispositivos: obtenerDispositivos(depsSrv), machineId: 'servidor-machine',
      multisucursalActivo: () => planMultisucursal(lmBeta),
    });
    await srvBeta.start();
    const pingB = async (): Promise<{ sucursales?: boolean }> => (await (await fetch(`http://127.0.0.1:${PORT_B}/lan/ping`)).json()) as { sucursales?: boolean };
    check('[interruptor de prueba] apagado: /lan/ping informa sucursales: false', (await pingB()).sucursales === false);
    lmBeta.setEdicionPrueba(true);
    check('[interruptor de prueba] encendido: /lan/ping informa sucursales: true sin reiniciar el servidor', (await pingB()).sucursales === true);
    lmBeta.setEdicionPrueba(false);
    check('[interruptor de prueba] apagado de nuevo: sucursales: false', (await pingB()).sucursales === false);
    await srvBeta.stop();
    rmSync(tmpBeta, { recursive: true, force: true });
  }

  // El LanServer real usa la MISMA instancia que los handlers (los códigos viven en memoria).
  check('[handlers] obtenerDispositivos devuelve la misma instancia por base', obtenerDispositivos(depsSrv) === obtenerDispositivos(depsSrv));
  const PORT_R = 47781;
  const srvReal = new LanServer({
    handlers: hs, port: PORT_R, token: PIN, jwtSecret: SECRETO, sessionStore, log: silencio,
    resolveUser: async (id) => {
      const u = await repos.users.findById(id);
      if (!u) return null;
      const { passwordHash: _p, ...safe } = u as typeof u & { passwordHash?: string };
      void _p;
      return safe as unknown as U;
    },
    dispositivos: obtenerDispositivos(depsSrv), machineId: 'servidor-machine',
    multisucursalActivo: () => multiReal,
  });
  let multiReal = true;
  await srvReal.start();

  // Terminal (otra carpeta de datos): canjea en lan:setMode con dirección web.
  const tmpTerm = mkdtempSync(join(tmpdir(), 'stockflow-terminal-'));
  const dbTermPath = join(tmpTerm, 'stockflow.db');
  const { db: dbT } = initLocalDb(dbTermPath);
  const depsTerm = {
    ...depsSrv, db: dbT, repos: createRepositories(dbT), sessionStore: new SessionStore(),
    machineId: 'f0'.repeat(32), dbPath: dbTermPath, userDataDir: tmpTerm,
    licenseManager: new LicenseManager({ userDataDir: tmpTerm, machineId: 'f0'.repeat(32), apiUrl: 'http://localhost:1', publicKeyPem: '' }),
  };
  const ht = buildAllHandlers(depsTerm);
  const base = `http://127.0.0.1:${PORT_R}`;
  const malo = await invoke(ht, 'lan:setMode', { mode: 'client', serverUrl: base, codigoEmparejamiento: 'AAAAA-AAAAA' });
  check('[terminal] código inválido → error y NO se guarda la config', !malo.ok && /no es válido/.test(malo.ok ? '' : malo.message) && !new LanManager(tmpTerm).isConfigured(), JSON.stringify(malo));
  // La PC de sucursal recién instalada NO tiene licencia propia: el canje no la pide.
  check('[terminal] la PC nueva no tiene licencia propia', depsTerm.licenseManager.getState().status === 'unlicensed', depsTerm.licenseManager.getState().status);
  // La central sin la edición Multisucursal: mensaje claro, nada guardado y el código no se gasta.
  multiReal = false;
  const sinEd = await invoke(ht, 'lan:setMode', { mode: 'client', serverUrl: base, codigoEmparejamiento: cod.ok ? cod.data.codigo : '' });
  multiReal = true;
  check(
    '[terminal] central sin edición Multisucursal → "La casa central no tiene habilitada la edición Multisucursal" y no se guarda',
    !sinEd.ok && /La casa central no tiene habilitada la edición Multisucursal/.test(sinEd.ok ? '' : sinEd.message) && !new LanManager(tmpTerm).isConfigured(),
    JSON.stringify(sinEd),
  );
  const sinEdTest = await invoke<{ ok: boolean; sucursales?: boolean; aviso?: string }>(ht, 'lan:testConnection', { url: base });
  check('[terminal] "Probar conexión" a esa central: conecta y avisa (sin decir "sin conexión")', sinEdTest.ok && sinEdTest.data.ok, JSON.stringify(sinEdTest));
  multiReal = false;
  const sinEdTest2 = await invoke<{ ok: boolean; sucursales?: boolean; aviso?: string }>(ht, 'lan:testConnection', { url: base });
  multiReal = true;
  check('[terminal] …y con la central sin edición, el aviso lo dice', sinEdTest2.ok && sinEdTest2.data.ok && sinEdTest2.data.sucursales === false && /edición Multisucursal/.test(sinEdTest2.data.aviso ?? ''), JSON.stringify(sinEdTest2));
  const apagada = await invoke(ht, 'lan:setMode', { mode: 'client', serverUrl: 'http://127.0.0.1:47799', codigoEmparejamiento: 'ABCDE-FGH23' });
  check('[terminal] central apagada → "No responde ningún StockFlow" y no se guarda', !apagada.ok && /No responde ningún StockFlow/.test(apagada.ok ? '' : apagada.message) && !new LanManager(tmpTerm).isConfigured(), JSON.stringify(apagada));
  const corto = await invoke(ht, 'lan:setMode', { mode: 'client', serverUrl: base, codigoEmparejamiento: 'ABC' });
  check('[terminal] código incompleto → se avisa sin consultar a la central', !corto.ok && /10 letras y números/.test(corto.ok ? '' : corto.message), JSON.stringify(corto));
  const publica = await invoke(ht, 'lan:setMode', { mode: 'client', serverUrl: 'http://comercio.ejemplo.com' });
  check('[terminal] dirección http pública → rechazada', !publica.ok, JSON.stringify(publica));
  // Como lo pega el usuario: con espacios, barra final y la ruta de la pantalla; el código en minúsculas.
  const bien = await invoke<{ config: { serverUrl?: string } }>(ht, 'lan:setMode', { mode: 'client', serverUrl: `  ${base}/#/login `, codigoEmparejamiento: (cod.ok ? cod.data.codigo : '').toLowerCase() });
  check('[terminal] canje OK desde una PC sin licencia → config con serverUrl normalizada', bien.ok && bien.data.config.serverUrl === base, JSON.stringify(bien));
  const mgrT = new LanManager(tmpTerm);
  const tokT = mgrT.leerTokenDispositivo();
  check('[terminal] el token quedó guardado (y no aparece en lan:getConfig)', !!tokT && tokT.startsWith('sfd1.'));
  const cfgT = await invoke<Record<string, unknown>>(ht, 'lan:getConfig');
  check('[terminal] lan:getConfig informa emparejada sin exponer el token', cfgT.ok && cfgT.data.emparejada === true && !JSON.stringify(cfgT.data).includes(tokT ?? '###'), JSON.stringify(cfgT));
  const ident = await invoke<{ terminalId: string; dispositivoToken: string | null; central?: string }>(ht, 'lan:identidadTerminal');
  check(
    '[terminal] lan:identidadTerminal comprueba a la casa central y recién ahí entrega machineId y token al puente',
    ident.ok && ident.data.terminalId === 'f0'.repeat(32) && ident.data.dispositivoToken === tokT && ident.data.central === 'verificada',
    JSON.stringify(ident),
  );

  // --- ¿Es SU casa central? La ruta /lan/central de la central real.
  const nonce = 'n'.repeat(43);
  const esperado = pruebaEsperada(tokT ?? '', nonce);
  const pr = await fetch(`${base}/lan/central`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dispositivoId: esperado?.dispositivoId, nonce }) });
  const prBody = (await pr.json()) as { ok?: boolean; prueba?: string };
  check('[central] /lan/central contesta la prueba que espera la PC (HMAC del hash del secreto)', pr.status === 200 && prBody.prueba === esperado?.prueba, JSON.stringify(prBody));
  const prOtra = await fetch(`${base}/lan/central`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dispositivoId: '00000000-0000-4000-8000-000000000000', nonce }) });
  const prOtraBody = (await prOtra.json()) as { motivo?: string };
  check('[central] /lan/central con una PC que no figura → 404 "desconocida"', prOtra.status === 404 && prOtraBody.motivo === 'desconocida', JSON.stringify(prOtraBody));
  const prCorto = await fetch(`${base}/lan/central`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dispositivoId: esperado?.dispositivoId, nonce: 'corto' }) });
  check('[central] /lan/central con un número al azar demasiado corto → 404', prCorto.status === 404, String(prCorto.status));

  // --- Alguien se queda con la dirección: contesta como StockFlow pero no tiene el hash.
  const PORT_FALSA = 47786;
  const recibidosFalsa: string[] = [];
  let respuestaFalsa: () => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, prueba: 'a'.repeat(64) } });
  const falsa = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
    req.on('end', () => {
      recibidosFalsa.push(`${req.url} ${raw} ${String(req.headers['x-stockflow-dispositivo'] ?? '')}`);
      if (req.url === '/lan/central') {
        const r = respuestaFalsa();
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/lan/ping' ? { ok: true, timestamp: Date.now(), license: 'active', identidad: true, sucursales: true } : { ok: true, data: { _lanSessionToken: 'jwt-falso' } }));
    });
  });
  await new Promise<void>((r) => falsa.listen(PORT_FALSA, '127.0.0.1', () => r()));
  const baseFalsa = `http://127.0.0.1:${PORT_FALSA}`;
  const cfgOriginal = new LanManager(tmpTerm).getConfig();
  new LanManager(tmpTerm).setConfig({ ...cfgOriginal, serverUrl: baseFalsa, serverIp: '127.0.0.1', serverPort: PORT_FALSA });
  check('[suplantación] el token sigue guardado en la PC (cambia sólo la dirección)', new LanManager(tmpTerm).leerTokenDispositivo() === tokT);
  const identFalsa = await invoke<{ dispositivoToken: string | null; central?: string; motivoCentral?: string }>(ht, 'lan:identidadTerminal', { verificarCentral: true });
  check(
    '[suplantación] lan:identidadTerminal NO entrega el token y explica por qué',
    identFalsa.ok && identFalsa.data.central === 'rechazada' && identFalsa.data.dispositivoToken === null && /no responde como la casa central/.test(identFalsa.data.motivoCentral ?? ''),
    JSON.stringify(identFalsa),
  );
  const puenteFalsa = createCaller('client', { serverIp: '127.0.0.1', serverPort: PORT_FALSA, token: '', serverBaseUrl: baseFalsa }, {
    invoke: async () => ({ ok: true, data: null }),
    listeners: { on: () => {}, off: () => {} },
    sondearIdentidad: true,
    identidad: async (o) => {
      const r = await invoke<IdentidadTerminal>(ht, 'lan:identidadTerminal', o);
      return r.ok ? r.data : null;
    },
  });
  const loginFalsa = await puenteFalsa('auth:login', { username: 'admin', password: 'admin36724776' });
  check(
    '[suplantación] el puente no manda el login: ni la contraseña ni el token llegan a la dirección falsa',
    !loginFalsa.ok && /no responde como la casa central/.test(loginFalsa.ok ? '' : loginFalsa.message) &&
      !recibidosFalsa.some((r) => r.startsWith('/lan/rpc')) && !recibidosFalsa.some((r) => r.includes('admin36724776') || (tokT ? r.includes(tokT.split('.')[2] ?? '###') : false)),
    JSON.stringify({ loginFalsa, recibidosFalsa }),
  );
  respuestaFalsa = () => ({ status: 404, body: { ok: false, message: 'Ruta inexistente' } });
  const identViejo = await invoke<{ central?: string; motivoCentral?: string }>(ht, 'lan:identidadTerminal', { verificarCentral: true });
  check('[suplantación] sin la ruta de identidad (404) → rechazada', identViejo.ok && identViejo.data.central === 'rechazada', JSON.stringify(identViejo));
  respuestaFalsa = () => ({ status: 404, body: { ok: false, motivo: 'desconocida' } });
  const identDesc = await invoke<{ central?: string; motivoCentral?: string }>(ht, 'lan:identidadTerminal', { verificarCentral: true });
  check(
    '[sucursal] la central no conoce la PC → rechazada con el camino para reconectarla',
    identDesc.ok && identDesc.data.central === 'rechazada' && /no reconoce esta PC.*Conectar esta PC con un código nuevo/.test(identDesc.data.motivoCentral ?? ''),
    JSON.stringify(identDesc),
  );
  await new Promise<void>((r) => falsa.close(() => r()));
  new LanManager(tmpTerm).setConfig(cfgOriginal);
  const identVuelta = await invoke<{ central?: string }>(ht, 'lan:identidadTerminal', { verificarCentral: true });
  check('[sucursal] de vuelta en la dirección de su central → verificada', identVuelta.ok && identVuelta.data.central === 'verificada', JSON.stringify(identVuelta));
  const diagIdent = await invoke<{ checks: { id: string; ok: boolean; detail: string }[] }>(ht, 'lan:diagnose');
  check('[terminal] diagnóstico: identidad de la casa central comprobada', diagIdent.ok && diagIdent.data.checks.some((c) => c.id === 'central' && c.ok), JSON.stringify(diagIdent.ok ? diagIdent.data.checks : diagIdent));
  const diag = await invoke<{ checks: { id: string; ok: boolean }[] }>(ht, 'lan:diagnose');
  check('[terminal] diagnóstico: conexión por la URL y PC emparejada', diag.ok && diag.data.checks.some((c) => c.id === 'conexion' && c.ok) && diag.data.checks.some((c) => c.id === 'emparejada' && c.ok), JSON.stringify(diag.ok ? diag.data.checks : diag));
  // El comercio baja de edición: el diagnóstico de la terminal no dice "emparejada".
  multiReal = false;
  const diagSin = await invoke<{ checks: { id: string; ok: boolean; detail: string }[] }>(ht, 'lan:diagnose');
  const chkSin = diagSin.ok ? diagSin.data.checks.find((c) => c.id === 'emparejada') : undefined;
  check(
    '[terminal] servidor sin Multisucursal: el diagnóstico avisa en vez de decir "emparejada"',
    !!chkSin && !chkSin.ok && /ya no tiene la licencia Multisucursal/.test(chkSin.detail),
    JSON.stringify(chkSin),
  );
  multiReal = true;
  const testUrl = await invoke<{ ok: boolean }>(ht, 'lan:testConnection', { url: base });
  check('[terminal] lan:testConnection con url', testUrl.ok && testUrl.data.ok);
  // 'lan:*' no cruza la red: un puesto no puede pedirle al servidor su identidad ni códigos.
  const cruzar = await rpc(`${base}/lan/rpc`, { channel: 'lan:emparejarGenerarCodigo', token: PIN }, jwtAdmin);
  check('[servidor] lan:emparejarGenerarCodigo por /lan/rpc → 403', cruzar.status === 403, String(cruzar.status));
  // Volver a la red local por IP borra el token; pasar a servidor también.
  const aIp = await invoke(ht, 'lan:setMode', { mode: 'client', serverIp: '192.168.1.10', serverPort: 7777, token: '123456' });
  check('[terminal] volver a conectar por IP borra el token de sucursal', aIp.ok && new LanManager(tmpTerm).leerTokenDispositivo() === null && new LanManager(tmpTerm).getConfig().serverUrl === undefined);
  mgrT.guardarTokenDispositivo('sfd1.x.y');
  new LanManager(tmpTerm).setConfig({ mode: 'server', port: 7777, token: '654321' });
  check('[terminal] pasar a servidor borra el token de sucursal', new LanManager(tmpTerm).leerTokenDispositivo() === null);

  // Lista y revocación desde Configuración (servidor), con auditoría real.
  const listaH = await invoke<{ id: string; nombre: string; estado: string }[]>(hs, 'lan:dispositivosListar');
  const filaT = listaH.ok ? listaH.data.find((d) => d.estado === 'activo' && d.nombre === hostname()) : undefined;
  check('[handlers] lista con la PC de la terminal', !!filaT, JSON.stringify(listaH).slice(0, 160));
  const rev = await invoke(hs, 'lan:dispositivoRevocar', { id: filaT?.id });
  check('[handlers] revocar desde Configuración', rev.ok, JSON.stringify(rev));
  const audit = db.$client.prepare(`SELECT description FROM audit_log WHERE area = 'Sucursales'`).all() as { description: string }[];
  check('[handlers] audit_log tiene el emparejamiento y la revocación', audit.some((a) => /emparejada/.test(a.description)) && audit.some((a) => /revocada/.test(a.description)), JSON.stringify(audit));

  // --- Casa central en modo PC ÚNICA (sólo la puerta del túnel). Es como
  // queda una PC recién instalada que activa su licencia sin pasar por la
  // Bienvenida: el caso real de la prueba con dos PC Windows. La PC nueva,
  // sin licencia, se empareja por esa puerta y factura como caja del local.
  const PORT_SOLO = 47783;
  const srvSolo = new LanServer({
    handlers: hs, soloTunel: true, tunnelPort: PORT_SOLO, port: 47784, token: 'f'.repeat(32), jwtSecret: SECRETO, sessionStore, log: silencio,
    resolveUser: async (id) => {
      const u = await repos.users.findById(id);
      if (!u) return null;
      const { passwordHash: _p, ...safe } = u as typeof u & { passwordHash?: string };
      void _p;
      return safe as unknown as U;
    },
    dispositivos: obtenerDispositivos(depsSrv), machineId: 'servidor-machine',
    multisucursalActivo: () => true,
  });
  await srvSolo.start();
  const tmpTerm2 = mkdtempSync(join(tmpdir(), 'stockflow-terminal2-'));
  const dbTerm2Path = join(tmpTerm2, 'stockflow.db');
  const { db: dbT2 } = initLocalDb(dbTerm2Path);
  const depsTerm2 = {
    ...depsSrv, db: dbT2, repos: createRepositories(dbT2), sessionStore: new SessionStore(),
    machineId: 'f1'.repeat(32), dbPath: dbTerm2Path, userDataDir: tmpTerm2,
    licenseManager: new LicenseManager({ userDataDir: tmpTerm2, machineId: 'f1'.repeat(32), apiUrl: 'http://localhost:1', publicKeyPem: '' }),
  };
  const ht2 = buildAllHandlers(depsTerm2);
  const cod2 = await invoke<{ codigo: string }>(hs, 'lan:emparejarGenerarCodigo');
  const baseSolo = `http://127.0.0.1:${PORT_SOLO}`;
  const emp2 = await invoke<{ config: { serverUrl?: string } }>(ht2, 'lan:setMode', {
    mode: 'client',
    serverUrl: `${baseSolo}/`,
    codigoEmparejamiento: cod2.ok ? cod2.data.codigo : '',
    // Como lo escribe el que instala: con espacios y algún carácter raro.
    nombrePc: '  Caja 1 San Carlos\u0007 ',
  });
  check('[central PC única] la PC nueva (sin licencia) se empareja por la puerta del túnel', emp2.ok && emp2.data.config.serverUrl === baseSolo, JSON.stringify(emp2));
  const tok2 = new LanManager(tmpTerm2).leerTokenDispositivo() ?? '';
  const filaNombre = obtenerDispositivos(depsSrv).listar().find((d) => d.id === tok2.split('.')[1]);
  check('[central PC única] la central ve la PC con el nombre que se cargó (no el de Windows)', filaNombre?.nombre === 'Caja 1 San Carlos', JSON.stringify(filaNombre));
  const H2 = { 'x-stockflow-dispositivo': tok2 };
  const login2 = await rpc(`${baseSolo}/lan/rpc`, { channel: 'auth:login', payload: { username: 'admin', password: 'admin36724776' } }, undefined, H2);
  const jwt2 = (login2.body as { data?: { _lanSessionToken?: string } } | null)?.data?._lanSessionToken ?? '';
  check('[central PC única] la PC de sucursal inicia sesión con el usuario de la central', login2.status === 200 && jwt2.length > 0, `${login2.status} ${JSON.stringify(login2.body).slice(0, 120)}`);
  const fisSin = await rpc(`${baseSolo}/lan/rpc`, { channel: 'fiscal:issueInvoice', payload: {} }, jwt2);
  const fisCon = await rpc(`${baseSolo}/lan/rpc`, { channel: 'fiscal:issueInvoice', payload: {} }, jwt2, H2);
  check(
    '[central PC única] sin token, facturar por internet → 403; con el token de la PC de sucursal, el canal pasa',
    fisSin.status === 403 && fisCon.status !== 403,
    `${fisSin.status}/${fisCon.status} ${JSON.stringify(fisCon.body).slice(0, 100)}`,
  );
  // PC revocada: la central igual prueba su identidad (no habilita nada) y el
  // pedido recibe el 401 de siempre, que dice qué hacer.
  check('[sucursal] revocar la PC de la central en modo PC única', obtenerDispositivos(depsSrv).revocar(tok2.split('.')[1] ?? '', { id: 'admin-1', nombre: 'Admin' }));
  const identRev = await invoke<{ central?: string; dispositivoToken: string | null }>(ht2, 'lan:identidadTerminal', { verificarCentral: true });
  check('[sucursal] PC revocada: la identidad de la central se comprueba igual', identRev.ok && identRev.data.central === 'verificada' && identRev.data.dispositivoToken === tok2, JSON.stringify(identRev));
  const trasRev = await rpc(`${baseSolo}/lan/rpc`, { channel: 'articles:list' }, jwt2, H2);
  check('[sucursal] …y el pedido recibe el 401 "ya no está autorizada"', trasRev.status === 401 && /ya no está autorizada/.test(trasRev.body?.ok === false ? trasRev.body.message : ''), JSON.stringify(trasRev.body));
  await srvSolo.stop();
  closeLocalDb(dbT2);
  rmSync(tmpTerm2, { recursive: true, force: true });

  await invoke(hs, 'auth:logout');
  const sinSesion = await invoke(hs, 'lan:emparejarGenerarCodigo');
  check('[handlers] sin sesión no se generan códigos', !sinSesion.ok);

  // --- Una PC SERVIDOR no cambia de red sin un administrador (la Activación
  // ofrece "Conectar a la casa central" sin sesión).
  const tmpSrv2 = mkdtempSync(join(tmpdir(), 'stockflow-servidor2-'));
  writeFileSync(join(tmpSrv2, 'lan.json'), JSON.stringify({ mode: 'server', port: 7777, token: '135790' }));
  const depsSrv2 = { ...depsSrv, userDataDir: tmpSrv2, sessionStore: new SessionStore() };
  const hs2 = buildAllHandlers(depsSrv2);
  const aSucursal = await invoke(hs2, 'lan:setMode', { mode: 'client', serverUrl: base, codigoEmparejamiento: 'ABCDE-FGH23' });
  check(
    '[servidor] sin sesión, la PC servidor no pasa a PC de sucursal (y lan.json queda igual)',
    !aSucursal.ok && /caja principal de este local/.test(aSucursal.ok ? '' : aSucursal.message) && new LanManager(tmpSrv2).getConfig().mode === 'server',
    JSON.stringify(aSucursal),
  );
  const aUnica = await invoke(hs2, 'lan:setMode', { mode: 'single' });
  check('[servidor] sin sesión tampoco pasa a PC única', !aUnica.ok && new LanManager(tmpSrv2).getConfig().mode === 'server', JSON.stringify(aUnica));
  await invoke(hs2, 'auth:login', { username: 'admin', password: 'admin36724776' });
  const conSesion = await invoke(hs2, 'lan:setMode', { mode: 'single' });
  check('[servidor] con un administrador, sí', conSesion.ok && new LanManager(tmpSrv2).getConfig().mode === 'single', JSON.stringify(conSesion));
  await invoke(hs2, 'auth:logout');
  rmSync(tmpSrv2, { recursive: true, force: true });
  await srvReal.stop();

  closeLocalDb(dbT);
  closeLocalDb(db);
  rmSync(tmpTerm, { recursive: true, force: true });
  rmSync(tmpDir, { recursive: true, force: true });
}
