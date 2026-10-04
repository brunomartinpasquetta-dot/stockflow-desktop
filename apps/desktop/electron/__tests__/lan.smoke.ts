/**
 * Smoke test del servidor LAN: arranca `LanServer` con un `HandlerMap` mock,
 * hace HTTP POST a `/lan/rpc` y valida token, canal y respuesta.
 *
 *   pnpm --filter @stockflow/desktop test:lan
 */
import { createServer as crearServidorHttp, request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { LanServer, signJwt, verifyJwt, viaDelPedido } from '../lan/LanServer';
import {
  baseDelServidor,
  createCaller,
  MENSAJE_CENTRAL_NO_RESPONDE,
  MENSAJE_SIN_CONEXION_CENTRAL,
  normalizarUrlServidor,
  parseLanArgs,
  shouldRouteLan,
  timeoutDeCanal,
  TIMEOUT_RPC_LARGO_MS,
} from '../preload-bridge';
import type { HandlerMap } from '../ipc/handler-context';
import { obtenerTerminalActual, type TerminalActual } from '../ipc/terminal-actual';
import { puertoDeEntorno, sinMdns } from '../bootstrap/entorno';
import { emparejarConCentral, revisarCentral, verificarCentral, type IoCentral } from '../lan/conexion-central';
import { pruebaDeCentral } from '../lan/dispositivos';
import { armarMensajeSucursal, ENLACE_CONECTAR_PC, extraerDatosDeConexion } from '../lan/mensaje-sucursal';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../ipc/session-store';
import { buildGuiaHandlers } from '../ipc/handlers/guia.handlers';
import { buildNovedadesHandlers } from '../ipc/handlers/novedades.handlers';
import type { HandlerDeps } from '../ipc/handler-context';
import type { IpcResponse } from '../ipc/types';

/** POST crudo con node:http: controla exactamente los encabezados (fetch agrega Accept-Encoding solo). */
function postCrudo(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = httpRequest(
      url,
      { method, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
  // Canales de grupos que SÍ cruzan la red (LAN_ROUTED_GROUPS). `system:*`
  // quedó afuera a propósito: ver seguridad-lan.smoke.ts.
  const handlers: HandlerMap = {
    'articles:getVersion': async () =>
      ({ ok: true, data: { version: '0.1.0' } }) as IpcResponse<unknown>,
    'system:getVersion': async () =>
      ({ ok: true, data: { version: '0.1.0' } }) as IpcResponse<unknown>,
    'auth:echo': async (payload) =>
      ({ ok: true, data: payload }) as IpcResponse<unknown>,
  };

  const token = '123456';
  const server = new LanServer({
    handlers,
    port: 0, // efímero
    token,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });

  // Necesitamos que listen elija un puerto efímero — `port: 0` no es soportado por
  // nuestro start(). Refactor mínimo: pisar port después de listen. En su lugar,
  // probamos con puerto fijo razonablemente libre.
  // Hack pragmático: arrancamos en un rango alto.
  const PORT = 47733;
  const server2 = new LanServer({
    handlers,
    port: PORT,
    token,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await server2.start();

  const url = `http://127.0.0.1:${PORT}/lan/rpc`;

  // OK con token correcto
  const r1 = await postJson(url, { channel: 'articles:getVersion', payload: {}, token });
  check(
    'POST con token válido → 200 + IpcResponse ok',
    r1.status === 200 && typeof r1.body === 'object' && (r1.body as { ok?: boolean }).ok === true,
    JSON.stringify(r1).slice(0, 120),
  );

  // payload echo (preserva el body)
  const r2 = await postJson(url, { channel: 'auth:echo', payload: { foo: 'bar' }, token });
  const ok2 =
    r2.status === 200 &&
    (r2.body as { ok?: boolean; data?: { foo?: string } }).ok === true &&
    (r2.body as { data?: { foo?: string } }).data?.foo === 'bar';
  check('payload se reenvía intacto al handler', ok2, JSON.stringify(r2).slice(0, 120));

  // 401 con token inválido
  const r3 = await postJson(url, { channel: 'articles:getVersion', payload: {}, token: 'mal' });
  check('token incorrecto → 401', r3.status === 401, JSON.stringify(r3));

  // 404 con canal inexistente (de un grupo que sí cruza la red)
  const r4 = await postJson(url, { channel: 'articles:noExiste', payload: {}, token });
  check('canal inexistente → 404', r4.status === 404, JSON.stringify(r4));

  // 403 con canal de un grupo que no cruza la red, aunque esté registrado
  const r4b = await postJson(url, { channel: 'system:getVersion', payload: {}, token });
  check('canal fuera de la lista LAN → 403', r4b.status === 403, JSON.stringify(r4b));

  // 400 con body roto
  const r5 = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ esto no es json',
  });
  check('body no-JSON → 400', r5.status === 400, String(r5.status));

  // 404 con ruta distinta
  const r6 = await fetch(`http://127.0.0.1:${PORT}/otra`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check('ruta desconocida → 404', r6.status === 404, String(r6.status));

  // ping endpoint (sin auth)
  const ping = await fetch(`http://127.0.0.1:${PORT}/lan/ping`);
  check('GET /lan/ping → 200', ping.status === 200, String(ping.status));

  // JWT round-trip
  const secret = 'pin:stockflow-lan-jwt';
  const exp = Math.floor(Date.now() / 1000) + 60;
  const jwt = signJwt({ sub: 'user-1', exp }, secret);
  const verified = verifyJwt(jwt, secret);
  // REGRESIÓN (Leo Citzia, ago-2026): un auth:login llegado por LAN pisaba la
  // sesión del ESCRITORIO — el admin del servidor pasaba a ser el vendedor de
  // la terminal y le negaba módulos hasta reiniciar. El fix: setters ALS-aware
  // + rama sin-JWT del LanServer corriendo en runDetached.
  {
    const { SessionStore } = await import('../ipc/session-store');
    const store = new SessionStore();
    type U = Parameters<InstanceType<typeof SessionStore>['setSession']>[0];
    const admin = { id: 'admin-1', username: 'admin', fullName: 'Admin', role: 'admin', active: true, createdAt: 0, updatedAt: 0 } as unknown as U;
    const vendedor = { id: 'vend-1', username: 'vendedor', fullName: 'Vend', role: 'seller', active: true, createdAt: 0, updatedAt: 0 } as unknown as U;
    store.setSession(admin, 'token-escritorio');

    // login de terminal, como lo corre el LanServer (rama sin JWT → detached)
    await store.runDetached(async () => {
      store.setSession(vendedor, 'token-terminal');
      check('dentro del RPC, la sesión es la del vendedor', store.getSession()?.user.id === 'vend-1');
    });
    check(
      'un login LAN NO pisa la sesión del escritorio',
      store.getSession()?.user.id === 'admin-1',
      `quedó: ${store.getSession()?.user.username}`,
    );

    // logout de terminal: tampoco puede desloguear al escritorio
    await store.runDetached(async () => { store.clearSession(); });
    check('un logout LAN NO desloguea al escritorio', store.getSession()?.user.id === 'admin-1');
  }

  check('signJwt + verifyJwt round-trip', verified?.sub === 'user-1', JSON.stringify(verified));
  const tampered = verifyJwt(jwt + 'x', secret);
  check('JWT con firma corrupta → null', tampered === null);
  const wrongSecret = verifyJwt(jwt, 'other');
  check('JWT con secret distinto → null', wrongSecret === null);
  const expired = verifyJwt(signJwt({ sub: 'u', exp: 1 }, secret), secret);
  check('JWT expirado → null', expired === null);

  // --- Tests del preload-bridge ---
  console.log('\n  Tests preload-bridge:');
  const parsed1 = parseLanArgs(['--lan-mode=client', '--lan-server=192.168.1.50:7777', '--lan-token=abc123']);
  check(
    'parseLanArgs client',
    parsed1.mode === 'client' && parsed1.lanCfg?.serverIp === '192.168.1.50' && parsed1.lanCfg?.serverPort === 7777 && parsed1.lanCfg?.token === 'abc123',
    JSON.stringify(parsed1),
  );
  const parsed2 = parseLanArgs([]);
  check('parseLanArgs sin flags → single', parsed2.mode === 'single' && !parsed2.lanCfg);

  check('shouldRouteLan articles en client', shouldRouteLan('articles:list', 'client'));
  check('shouldRouteLan system en client → false', !shouldRouteLan('system:getVersion', 'client'));
  check('shouldRouteLan articles en single → false', !shouldRouteLan('articles:list', 'single'));

  // Single mode: todo va a invoke
  const invokeCalls: string[] = [];
  const ioSingle = {
    invoke: async (channel: string) => {
      invokeCalls.push(channel);
      return { ok: true, data: { ch: channel } } as IpcResponse<unknown>;
    },
    listeners: { on: () => {}, off: () => {} },
  };
  const callerSingle = createCaller('single', undefined, ioSingle);
  await callerSingle('articles:list');
  await callerSingle('system:getVersion');
  check('single mode: ambos canales fueron a IPC', invokeCalls.length === 2 && invokeCalls[0] === 'articles:list');

  // Client mode: routed group → fetch; local → invoke
  invokeCalls.length = 0;
  const fetchCalls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fakeFetch: typeof fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const body = String(init?.body ?? '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({ url: u, body, headers });
    // simulamos auth:login devolviendo _lanSessionToken
    if (body.includes('auth:login')) {
      return new Response(
        JSON.stringify({ ok: true, data: { user: { id: 'u1' }, sessionToken: 'core-token', _lanSessionToken: 'jwt-xyz' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as unknown as Response;
    }
    return new Response(JSON.stringify({ ok: true, data: { from: 'lan' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response;
  };
  const callerClient = createCaller(
    'client',
    { serverIp: '127.0.0.1', serverPort: 47733, token: 'pin1' },
    { ...ioSingle, fetch: fakeFetch },
  );

  await callerClient('system:getVersion'); // local
  check('client: canal local va a IPC', invokeCalls.length === 1 && invokeCalls[0] === 'system:getVersion');

  const loginRes = await callerClient('auth:login', { username: 'a', password: 'b' });
  check(
    'client: auth:login stripea _lanSessionToken del data',
    loginRes.ok && !('_lanSessionToken' in (loginRes.data as object)) && (loginRes.data as { sessionToken: string }).sessionToken === 'core-token',
    JSON.stringify(loginRes).slice(0, 160),
  );

  await callerClient('articles:list');
  const lastCall = fetchCalls[fetchCalls.length - 1]!;
  check(
    'client: tras login, articles:list manda Authorization Bearer jwt-xyz',
    lastCall.headers['authorization'] === 'Bearer jwt-xyz',
    JSON.stringify(lastCall.headers),
  );

  await callerClient('auth:logout');
  await callerClient('articles:list');
  const lastCall2 = fetchCalls[fetchCalls.length - 1]!;
  check(
    'client: tras logout, no manda Authorization',
    !('authorization' in lastCall2.headers),
    JSON.stringify(lastCall2.headers),
  );

  // Server caído → LAN_OFFLINE-ish error
  const failFetch: typeof fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  const callerOffline = createCaller(
    'client',
    { serverIp: '127.0.0.1', serverPort: 1, token: 'p' },
    { ...ioSingle, fetch: failFetch },
  );
  const offline = await callerOffline('articles:list');
  check(
    'client: servidor caído → ok:false con mensaje LAN',
    !offline.ok && offline.code === 'INTERNAL' && /servidor/i.test(offline.message),
    JSON.stringify(offline),
  );

  await server2.stop();
  // silenciar lint sobre variable no usada
  void server;

  await pruebasMultisucursal();
  pruebasPuertosDeEntorno();
  await pruebasEstadoDelPuesto();
  await pruebasConexionCentral();
  await pruebasIdentidadDeCentral();
  await pruebasPantallasSucursal();

  if (failures > 0) {
    console.error(`\nTEST LAN FALLÓ — ${failures} check(s) con error.\n`);
    process.exit(1);
  }
  console.log('\nTEST LAN OK ✅\n');
}

main().catch((err) => {
  console.error('\n✗ Excepción durante el test LAN:', err);
  process.exit(1);
});

/* ------------------------------------------------------------------------ */
/* Multisucursal etapa 1: URL, identidad, timeouts por canal, gzip            */
/* ------------------------------------------------------------------------ */
async function pruebasMultisucursal(): Promise<void> {
  console.log('\n  Terminal por dirección web:');
  const casos: [string, string | null][] = [
    ['https://comercio.mistockflow.com', 'https://comercio.mistockflow.com'],
    ['https://comercio.mistockflow.com/', 'https://comercio.mistockflow.com'],
    ['https://comercio.mistockflow.com/lan/rpc?x=1#y', 'https://comercio.mistockflow.com'],
    ['comercio.mistockflow.com', 'https://comercio.mistockflow.com'],
    ['  HTTPS://Comercio.MiStockFlow.com  ', 'https://comercio.mistockflow.com'],
    ['192.168.1.10:7777', 'http://192.168.1.10:7777'],
    ['http://192.168.1.10:7777', 'http://192.168.1.10:7777'],
    ['http://10.0.0.5:7777', 'http://10.0.0.5:7777'],
    ['http://100.70.1.2:7777', 'http://100.70.1.2:7777'],
    ['https://192.168.1.10:8443', 'https://192.168.1.10:8443'],
    ['http://comercio.mistockflow.com', null],
    ['http://8.8.8.8:7777', null],
    ['ftp://comercio.mistockflow.com', null],
    ['https://user:clave@comercio.mistockflow.com', null],
    ['', null],
    ['https://', null],
  ];
  for (const [entrada, esperado] of casos) {
    const r = normalizarUrlServidor(entrada);
    check(
      `normalizarUrlServidor(${JSON.stringify(entrada)}) → ${esperado ?? 'error'}`,
      esperado === null ? !r.ok : r.ok && r.url === esperado,
      JSON.stringify(r),
    );
  }

  const pUrl = parseLanArgs(['--lan-mode=client', '--lan-server-url=https://comercio.mistockflow.com']);
  check(
    'parseLanArgs con --lan-server-url y SIN PIN → client con base https',
    pUrl.mode === 'client' && !!pUrl.lanCfg && baseDelServidor(pUrl.lanCfg) === 'https://comercio.mistockflow.com' && pUrl.lanCfg.token === '',
    JSON.stringify(pUrl),
  );
  const pUrlLan = parseLanArgs(['--lan-mode=client', '--lan-server-url=http://192.168.1.10:7777', '--lan-token=123456']);
  check(
    'parseLanArgs con URL http de la red y PIN',
    !!pUrlLan.lanCfg && baseDelServidor(pUrlLan.lanCfg) === 'http://192.168.1.10:7777' && pUrlLan.lanCfg.token === '123456',
    JSON.stringify(pUrlLan),
  );
  const pUrlMala = parseLanArgs(['--lan-mode=client', '--lan-server-url=http://comercio.mistockflow.com']);
  check('parseLanArgs con URL http pública → no arma config (no cae a http en claro)', !pUrlMala.lanCfg, JSON.stringify(pUrlMala));
  const pViejo = parseLanArgs(['--lan-mode=client', '--lan-server=192.168.1.50:7777', '--lan-token=abc123']);
  check('parseLanArgs viejo (IP:puerto) sigue igual', !!pViejo.lanCfg && baseDelServidor(pViejo.lanCfg) === 'http://192.168.1.50:7777');

  // --- El caller usa la URL y manda la identidad en CADA pedido
  console.log('\n  Identidad de la terminal en el caller:');
  const vistos: { url: string; headers: Record<string, string> }[] = [];
  let pedidosDeIdentidad = 0;
  const fetchEco: typeof fetch = async (url: string | URL | Request, init?: RequestInit) => {
    vistos.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 }) as unknown as Response;
  };
  const io = { invoke: async () => ({ ok: true, data: null }) as IpcResponse<unknown>, listeners: { on: () => {}, off: () => {} } };
  const callerUrl = createCaller('client', pUrl.lanCfg, {
    ...io,
    fetch: fetchEco,
    identidad: async () => {
      pedidosDeIdentidad++;
      return { terminalId: 'a'.repeat(64), terminalNombre: 'Caja Señora Ñandú', dispositivoToken: 'sfd1.x.y' };
    },
  });
  await Promise.all([callerUrl('articles:list'), callerUrl('sales:get', { id: '1' })]);
  await callerUrl('customers:list');
  check('pide la identidad UNA sola vez', pedidosDeIdentidad === 1, String(pedidosDeIdentidad));
  check('pega contra la dirección web', vistos.every((v) => v.url === 'https://comercio.mistockflow.com/lan/rpc'), vistos.map((v) => v.url).join(','));
  check(
    'manda x-stockflow-terminal, el nombre codificado y el token de dispositivo',
    vistos.every(
      (v) =>
        v.headers['x-stockflow-terminal'] === 'a'.repeat(64) &&
        v.headers['x-stockflow-terminal-nombre'] === encodeURIComponent('Caja Señora Ñandú') &&
        v.headers['x-stockflow-dispositivo'] === 'sfd1.x.y',
    ),
    JSON.stringify(vistos[0]?.headers),
  );
  vistos.length = 0;
  const callerSinId = createCaller('client', pViejo.lanCfg, { ...io, fetch: fetchEco });
  await callerSinId('articles:list');
  check(
    'sin identidad (navegador sin almacenamiento, tests viejos) no manda encabezados de terminal',
    !('x-stockflow-terminal' in (vistos[0]?.headers ?? {})) && !('x-stockflow-dispositivo' in (vistos[0]?.headers ?? {})),
  );
  vistos.length = 0;
  const callerIdFalla = createCaller('client', pViejo.lanCfg, {
    ...io,
    fetch: fetchEco,
    identidad: () => {
      throw new Error('ipc caído');
    },
  });
  const rFalla = await callerIdFalla('articles:list');
  check('si pedir la identidad falla, el pedido sale igual (sin encabezados)', rFalla.ok && !('x-stockflow-terminal' in (vistos[0]?.headers ?? {})));

  // --- Terminal NUEVA contra servidor VIEJO (actualización escalonada, Leo)
  // El servidor de la 1.12 contesta el OPTIONS con allow-headers
  // "content-type,authorization": Chromium (file:// → consulta previa) bloquea
  // el pedido que lleve x-stockflow-terminal y fetch tira TypeError. Node no
  // hace CORS, así que el "servidor viejo" de la prueba corta la conexión
  // cuando ve esos encabezados, que es lo que la terminal vive en la práctica.
  console.log('\n  Terminal nueva contra servidor viejo (sin identidad):');
  let viejoAdmite = false;
  const recibidosViejo: Record<string, string | string[] | undefined>[] = [];
  const servidorViejo = crearServidorHttp((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,authorization' });
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/lan/ping') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(viejoAdmite ? { ok: true, timestamp: Date.now(), identidad: true } : { ok: true, timestamp: Date.now(), license: 'active', version: '1.12.1' }));
      return;
    }
    if (!viejoAdmite && (req.headers['x-stockflow-terminal'] || req.headers['x-stockflow-dispositivo'])) {
      req.socket.destroy(); // = Chromium bloqueando por CORS
      return;
    }
    recibidosViejo.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ ok: true, data: { atendido: true } }));
    });
  });
  await new Promise<void>((r) => servidorViejo.listen(47769, '127.0.0.1', () => r()));
  const cfgViejo = { serverIp: '127.0.0.1', serverPort: 47769, token: '123456' };
  const idNueva = async () => ({ terminalId: 'f'.repeat(64), terminalNombre: 'Caja nueva' });
  const sinSondeo = createCaller('client', cfgViejo, { ...io, identidad: idNueva });
  const rSin = await sinSondeo('articles:list');
  check('sin sondear (el error del revisor): la terminal nueva queda "sin conexión"', !rSin.ok && /Sin conexión/.test(rSin.message), JSON.stringify(rSin));
  const conSondeo = createCaller('client', cfgViejo, { ...io, identidad: idNueva, sondearIdentidad: true, revisarIdentidadMs: 0 });
  const rCon1 = await conSondeo('articles:list');
  const rCon2 = await conSondeo('auth:login', { username: 'a', password: 'b' });
  check('sondeando: contra el servidor viejo los pedidos andan', rCon1.ok && rCon2.ok, JSON.stringify([rCon1, rCon2]));
  check('…y salen sin los encabezados de identidad', recibidosViejo.length === 2 && recibidosViejo.every((h) => !h['x-stockflow-terminal']), JSON.stringify(recibidosViejo.map((h) => h['x-stockflow-terminal'] ?? null)));
  // Se actualiza el servidor: la terminal empieza a identificarse sola.
  viejoAdmite = true;
  recibidosViejo.length = 0;
  const rCon3 = await conSondeo('articles:list');
  check('actualizado el servidor, la terminal se identifica sin reiniciar', rCon3.ok && recibidosViejo[0]?.['x-stockflow-terminal'] === 'f'.repeat(64), JSON.stringify(recibidosViejo[0]?.['x-stockflow-terminal'] ?? null));
  await new Promise<void>((r) => servidorViejo.close(() => r()));

  // --- Tiempos de espera por canal
  console.log('\n  Tiempos de espera por canal:');
  check('fiscal:* espera 45 s', timeoutDeCanal('fiscal:issueInvoice', {}, 10_000) === TIMEOUT_RPC_LARGO_MS);
  check('sales:create con factura (B) espera 45 s', timeoutDeCanal('sales:create', { type: 'B' }, 10_000) === 45_000);
  check('sales:create con remito X: 10 s', timeoutDeCanal('sales:create', { type: 'X' }, 10_000) === 10_000);
  check('articles:list: 10 s', timeoutDeCanal('articles:list', undefined, 10_000) === 10_000);
  check('nunca baja el común (navegador 15 s)', timeoutDeCanal('articles:list', undefined, 15_000) === 15_000 && timeoutDeCanal('fiscal:x', {}, 60_000) === 60_000);
  // El caller usa esos tiempos de verdad: un servidor que tarda 120 ms corta
  // a articles:list (común = 40 ms) pero no a fiscal:issueInvoice (largo = 400 ms).
  const fetchLento: typeof fetch = (_u: string | URL | Request, init?: RequestInit) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify({ ok: true, data: 'tarde' }), { status: 200 }) as unknown as Response), 120);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('abortado');
        e.name = 'AbortError';
        reject(e);
      });
    });
  const callerTiempos = createCaller('client', pViejo.lanCfg, { ...io, fetch: fetchLento, httpTimeoutMs: 40, httpTimeoutLargoMs: 400 });
  const corto = await callerTiempos('articles:list');
  const largo = await callerTiempos('fiscal:issueInvoice', { saleId: 'x' });
  const ventaB = await callerTiempos('sales:create', { type: 'B' });
  check('articles:list corta por tiempo', !corto.ok && /timeout/.test(corto.message), JSON.stringify(corto));
  check('fiscal:issueInvoice espera lo suficiente', largo.ok === true, JSON.stringify(largo));
  check('sales:create con factura espera lo suficiente', ventaB.ok === true, JSON.stringify(ventaB));

  // --- Servidor: terminal actual, gzip y CORS
  console.log('\n  Servidor: terminal actual, gzip, CORS:');
  const grande = Array.from({ length: 400 }, (_, i) => ({ id: i, descripcion: `Artículo de prueba número ${i}`, precio: '1234.5600' }));
  const handlers: HandlerMap = {
    'articles:quienSoy': async () => ({ ok: true, data: obtenerTerminalActual({ machineId: 'id-del-servidor' }) }) as IpcResponse<unknown>,
    'articles:list': async () => ({ ok: true, data: grande }) as IpcResponse<unknown>,
    'articles:get': async () => ({ ok: true, data: { chico: true } }) as IpcResponse<unknown>,
  };
  const PORT = 47761;
  const PORT_TUNEL = 47762;
  const srv = new LanServer({
    handlers,
    port: PORT,
    tunnelPort: PORT_TUNEL,
    token: '123456',
    machineId: 'id-del-servidor',
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await srv.start();
  const u = `http://127.0.0.1:${PORT}/lan/rpc`;
  const uT = `http://127.0.0.1:${PORT_TUNEL}/lan/rpc`;
  const quien = async (url: string, headers: Record<string, string>): Promise<TerminalActual | null> => {
    const r = await postCrudo(url, { channel: 'articles:quienSoy', token: '123456' }, headers);
    return (JSON.parse(r.raw.toString('utf8')) as { data?: TerminalActual }).data ?? null;
  };
  const idTerm = 'b'.repeat(64);
  const t1 = await quien(u, { 'x-stockflow-terminal': idTerm, 'x-stockflow-terminal-nombre': encodeURIComponent('Caja 2 — Peña') });
  check(
    'por LAN con encabezados: id y nombre de la terminal, origen lan',
    t1?.id === idTerm && t1.nombre === 'Caja 2 — Peña' && t1.origen === 'lan' && t1.identificada && t1.dispositivoId === null,
    JSON.stringify(t1),
  );
  const t2 = await quien(u, {});
  check(
    'por LAN sin encabezados (terminal vieja): id del servidor, identificada=false',
    t2?.id === 'id-del-servidor' && t2.identificada === false && t2.origen === 'lan',
    JSON.stringify(t2),
  );
  const t3 = await quien(uT, { 'x-stockflow-terminal': idTerm });
  // Por el túnel sin PC emparejada el encabezado NO se cree (cualquiera con
  // una contraseña podría declarar la caja de otro): opera como el servidor.
  check(
    'por el túnel sin PC emparejada: origen tunel, el encabezado se ignora (id del servidor)',
    t3?.origen === 'tunel' && t3.id === 'id-del-servidor' && t3.identificada === false,
    JSON.stringify(t3),
  );
  const t4 = await quien(u, { 'x-stockflow-terminal': 'malo; DROP TABLE', 'x-stockflow-terminal-nombre': '%E0%A4%A' });
  check('id de terminal con basura → se ignora (identificada=false)', t4?.identificada === false, JSON.stringify(t4));
  const local = obtenerTerminalActual({ machineId: 'id-del-servidor' });
  check('fuera de un pedido de red (IPC local): esta PC, origen local', local.id === 'id-del-servidor' && local.origen === 'local' && local.identificada);
  // Concurrencia: dos pedidos a la vez no se pisan la terminal.
  const [ca, cb] = await Promise.all([
    quien(u, { 'x-stockflow-terminal': 'c'.repeat(64) }),
    quien(u, { 'x-stockflow-terminal': 'd'.repeat(64) }),
  ]);
  check('pedidos simultáneos: cada uno ve su terminal', ca?.id === 'c'.repeat(64) && cb?.id === 'd'.repeat(64));
  const cc = srv.getConnectedClients();
  check('el panel de terminales conoce el nombre de la PC', cc.some((c) => c.nombre === 'Caja 2 — Peña'), JSON.stringify(cc));

  // gzip
  const conGzip = await postCrudo(u, { channel: 'articles:list', token: '123456' }, { 'accept-encoding': 'gzip, deflate, br' });
  const desc = conGzip.headers['content-encoding'] === 'gzip' ? JSON.parse(gunzipSync(conGzip.raw).toString('utf8')) : null;
  check(
    'respuesta grande + Accept-Encoding gzip → comprimida y se descomprime bien',
    conGzip.headers['content-encoding'] === 'gzip' && desc?.ok === true && desc.data.length === 400,
    `${conGzip.headers['content-encoding']} ${conGzip.raw.length} bytes`,
  );
  const sinGzip = await postCrudo(u, { channel: 'articles:list', token: '123456' }, {});
  check(
    'sin Accept-Encoding (terminal vieja) → sin comprimir',
    sinGzip.headers['content-encoding'] === undefined && (JSON.parse(sinGzip.raw.toString('utf8')) as { data: unknown[] }).data.length === 400,
    String(sinGzip.headers['content-encoding']),
  );
  check('la comprimida pesa mucho menos', conGzip.raw.length * 3 < sinGzip.raw.length, `${conGzip.raw.length} vs ${sinGzip.raw.length}`);
  const q0 = await postCrudo(u, { channel: 'articles:list', token: '123456' }, { 'accept-encoding': 'gzip;q=0' });
  check('gzip;q=0 → sin comprimir', q0.headers['content-encoding'] === undefined);
  const chica = await postCrudo(u, { channel: 'articles:get', token: '123456' }, { 'accept-encoding': 'gzip' });
  check('respuesta chica (< 8 KB) → sin comprimir aunque se acepte', chica.headers['content-encoding'] === undefined);
  check('Vary: Accept-Encoding', String(conGzip.headers['vary'] ?? '').toLowerCase().includes('accept-encoding'));
  // fetch (undici y Chromium) pide gzip solo y lo descomprime solo: el caller no cambia.
  const callerReal = createCaller('client', { serverIp: '127.0.0.1', serverPort: PORT, token: '123456' }, io);
  const viaCaller = await callerReal('articles:list');
  check('el caller real (fetch) recibe la lista completa', viaCaller.ok && (viaCaller.data as unknown[]).length === 400);
  // Servidor NUEVO: el sondeo dice que sí y la terminal se identifica.
  const callerSondea = createCaller('client', { serverIp: '127.0.0.1', serverPort: PORT, token: '123456' }, {
    ...io,
    identidad: async () => ({ terminalId: 'e'.repeat(64), terminalNombre: 'Caja sondeo' }),
    sondearIdentidad: true,
  });
  const yo = await callerSondea('articles:quienSoy');
  check('servidor nuevo + sondeo: la terminal llega identificada', yo.ok && (yo.data as TerminalActual).id === 'e'.repeat(64), JSON.stringify(yo));
  // CORS: la terminal instalada habla desde file:// → consulta previa.
  const pre = await postCrudo(u, undefined, { origin: 'file://' }, 'OPTIONS');
  const permitidos = String(pre.headers['access-control-allow-headers'] ?? '');
  check(
    'OPTIONS permite los encabezados de identidad y de dispositivo',
    ['x-stockflow-terminal', 'x-stockflow-terminal-nombre', 'x-stockflow-dispositivo', 'authorization'].every((h) => permitidos.includes(h)),
    permitidos,
  );
  // Sin servicio de dispositivos, /lan/emparejar no existe.
  const sinEmp = await postCrudo(`http://127.0.0.1:${PORT}/lan/emparejar`, { codigo: 'x' });
  check('sin servicio de PC de sucursal, /lan/emparejar → 404', sinEmp.status === 404, String(sinEmp.status));
  await srv.stop();
}

/* ------------------------------------------------------------------------ */
/* Puertos por variable de entorno (sandbox de dos locales en una misma PC)  */
/* ------------------------------------------------------------------------ */
function pruebasPuertosDeEntorno(): void {
  console.log('\n[entorno] puertos y mDNS por variable de entorno');
  check('sin variable → el puerto de siempre', puertoDeEntorno('STOCKFLOW_PUERTO_TUNEL', 7788, {}) === 7788);
  check('con variable válida → ese puerto', puertoDeEntorno('STOCKFLOW_PUERTO_TUNEL', 7788, { STOCKFLOW_PUERTO_TUNEL: '17788' }) === 17788);
  check('vacía → el de siempre', puertoDeEntorno('STOCKFLOW_PUERTO_TUNEL', 7788, { STOCKFLOW_PUERTO_TUNEL: ' ' }) === 7788);
  check('basura → el de siempre', puertoDeEntorno('STOCKFLOW_PUERTO_TUNEL', 7788, { STOCKFLOW_PUERTO_TUNEL: '17788abc' }) === 7788);
  check('privilegiado (<1024) → el de siempre', puertoDeEntorno('STOCKFLOW_PUERTO_FOTOS', 7790, { STOCKFLOW_PUERTO_FOTOS: '80' }) === 7790);
  check('fuera de rango → el de siempre', puertoDeEntorno('STOCKFLOW_PUERTO_FOTOS', 7790, { STOCKFLOW_PUERTO_FOTOS: '70000' }) === 7790);
  check('negativo → el de siempre', puertoDeEntorno('STOCKFLOW_PUERTO_FOTOS', 7790, { STOCKFLOW_PUERTO_FOTOS: '-1' }) === 7790);
  check('mDNS encendido sin variable', sinMdns({}) === false);
  check('mDNS se apaga con STOCKFLOW_SIN_MDNS=1', sinMdns({ STOCKFLOW_SIN_MDNS: '1' }) === true);
  check('mDNS sigue encendido con un valor cualquiera', sinMdns({ STOCKFLOW_SIN_MDNS: '0' }) === false && sinMdns({ STOCKFLOW_SIN_MDNS: 'no' }) === false);
}

/* ------------------------------------------------------------------------ */
/* Terminal: novedades y guía sin sesión local (la sesión vive en el server)  */
/* ------------------------------------------------------------------------ */
async function pruebasEstadoDelPuesto(): Promise<void> {
  console.log('\n[puesto] novedades y guía en una terminal sin sesión local');
  const dir = mkdtempSync(join(tmpdir(), 'stockflow-puesto-'));
  try {
    const deps = { userDataDir: dir, dbPath: join(dir, 'no-existe.db'), appVersion: '1.0.0', sessionStore: new SessionStore() } as unknown as HandlerDeps;
    const h = { ...buildGuiaHandlers(deps), ...buildNovedadesHandlers(deps) };
    writeFileSync(join(dir, 'lan.json'), JSON.stringify({ mode: 'single' }));
    const g1 = await h['guia:estado']!(undefined);
    check('1 PC sin sesión: guía sigue pidiendo sesión', !g1.ok && g1.code === 'UNAUTHENTICATED');
    const n1 = await h['novedades:pendientes']!(undefined);
    check('1 PC sin sesión: novedades siguen pidiendo sesión', !n1.ok && n1.code === 'UNAUTHENTICATED');
    // El modo se lee en cada pedido: pasar a terminal no requiere reiniciar los handlers.
    writeFileSync(join(dir, 'lan.json'), JSON.stringify({ mode: 'client', serverIp: '127.0.0.1', serverPort: 7777, token: '123456' }));
    const g2 = await h['guia:estado']!(undefined);
    check('terminal: la guía responde sin sesión local', g2.ok, JSON.stringify(g2));
    const p2 = await h['guia:progreso']!({ paso: 2 });
    check('terminal: la guía guarda el progreso de ESTA PC', p2.ok);
    const n2 = await h['novedades:pendientes']!(undefined);
    check('terminal: novedades responde sin sesión local (base local vacía → oculto)', n2.ok, JSON.stringify(n2).slice(0, 120));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------ */
/* PC de sucursal nueva → casa central: un mensaje claro para cada falla     */
/* ------------------------------------------------------------------------ */
async function pruebasConexionCentral(): Promise<void> {
  console.log('\n[sucursal] conectar una PC nueva a la casa central (mensajes)');
  const errRed = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  const jsonRes = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as unknown as Response;
  const PING_OK = { ok: true, timestamp: 1, license: 'active', version: '1.13.0', identidad: true, sucursales: true };
  /** Central de mentira: ping y canje configurables; anota qué URL se pidió. */
  function central(opts: { ping?: () => Response | Promise<Response>; canje?: () => Response | Promise<Response>; internet?: boolean }): IoCentral & { pedidos: string[]; cuerpos: unknown[] } {
    const pedidos: string[] = [];
    const cuerpos: unknown[] = [];
    return {
      pedidos,
      cuerpos,
      hayInternet: async () => opts.internet ?? true,
      timeoutMs: 2000,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        pedidos.push(String(url));
        if (String(url).endsWith('/lan/ping')) return (opts.ping ?? (() => jsonRes(200, PING_OK)))();
        cuerpos.push(init?.body ? JSON.parse(String(init.body)) : null);
        return (opts.canje ?? (() => jsonRes(200, { ok: true, data: { token: 'sfd1.a.b' } })))();
      }) as typeof fetch,
    };
  }
  const pc = { nombre: 'CAJA-SANCARLOS', machineId: 'ab'.repeat(32) };

  // Dirección: con o sin https, con o sin barra final, con ruta pegada de más.
  for (const entrada of ['bruno.mistockflow.com', 'https://bruno.mistockflow.com/', '  HTTPS://Bruno.MiStockFlow.com/#/login ']) {
    const io = central({});
    const r = await emparejarConCentral(entrada, 'abcde-fgh23', pc, io);
    check(
      `dirección ${JSON.stringify(entrada)} → https://bruno.mistockflow.com y canje OK`,
      r.ok && r.url === 'https://bruno.mistockflow.com' && io.pedidos[0] === 'https://bruno.mistockflow.com/lan/ping' && io.pedidos[1] === 'https://bruno.mistockflow.com/lan/emparejar',
      JSON.stringify({ r, pedidos: io.pedidos }),
    );
  }
  const ioCod = central({});
  await emparejarConCentral('bruno.mistockflow.com', ' abcde fgh23 ', pc, ioCod);
  check('el código viaja normalizado (mayúsculas, sin espacios ni guion)', (ioCod.cuerpos[0] as { codigo?: string })?.codigo === 'ABCDEFGH23', JSON.stringify(ioCod.cuerpos));

  const casos: { nombre: string; entrada?: string; codigo?: string; io: IoCentral & { pedidos: string[] }; motivo: string; re: RegExp; sinPedidos?: boolean }[] = [
    { nombre: 'dirección http pública', entrada: 'http://bruno.mistockflow.com', io: central({}), motivo: 'direccion', re: /https:\/\/.*Ejemplo: https:\/\/sucomercio/, sinPedidos: true },
    { nombre: 'dirección vacía', entrada: '  ', io: central({}), motivo: 'direccion', re: /Ingrese la dirección/, sinPedidos: true },
    { nombre: 'código vacío', codigo: '', io: central({}), motivo: 'codigo_formato', re: /Ingrese el código/, sinPedidos: true },
    { nombre: 'código incompleto (no gasta intentos en la central)', codigo: 'ABCDE', io: central({}), motivo: 'codigo_formato', re: /10 letras y números/, sinPedidos: true },
    { nombre: 'código con 0/O (no existen en los códigos)', codigo: 'ABCD0-FGH23', io: central({}), motivo: 'codigo_formato', re: /no lleva 0, 1, O ni I/, sinPedidos: true },
    { nombre: 'proxy o antivirus que intercepta https', io: central({ ping: () => { throw errRed('UNABLE_TO_VERIFY_LEAF_SIGNATURE'); } }), motivo: 'conexion_segura', re: /conexión segura.*antivirus/ },
    { nombre: 'sin internet', io: central({ ping: () => { throw errRed('ENOTFOUND'); }, internet: false }), motivo: 'sin_internet', re: /no tiene conexión a internet/ },
    { nombre: 'dirección mal escrita (no existe)', entrada: 'brunno.mistockflow.com', io: central({ ping: () => { throw errRed('ENOTFOUND'); } }), motivo: 'no_existe', re: /No existe la dirección «brunno\.mistockflow\.com»/ },
    { nombre: 'central apagada / túnel caído (Cloudflare 530)', io: central({ ping: () => new Response('error code: 1033', { status: 530 }) as unknown as Response }), motivo: 'no_responde', re: /no responde.*Acceso remoto/ },
    { nombre: 'StockFlow cerrado en la central (502)', io: central({ ping: () => new Response('Bad gateway', { status: 502 }) as unknown as Response }), motivo: 'no_responde', re: /apagada|cerrado/ },
    { nombre: 'sin respuesta a tiempo', io: central({ ping: () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }), motivo: 'no_responde', re: /no responde/ },
    { nombre: 'conexión rechazada en la red local', entrada: 'http://192.168.1.10:7777', io: central({ ping: () => { throw errRed('ECONNREFUSED'); } }), motivo: 'no_responde', re: /No responde ningún StockFlow en «192\.168\.1\.10:7777»/ },
    { nombre: 'la dirección de la red local de la central, desde otro local', entrada: 'http://192.168.18.179:17777', io: central({ ping: () => { throw errRed('ECONNREFUSED'); } }), motivo: 'no_responde', re: /sólo sirve dentro del local de la casa central.*PC de sucursal \(empieza con https:\/\/\)/ },
    { nombre: 'certificado "todavía no válido" (reloj de la PC atrasado)', io: central({ ping: () => { throw errRed('CERT_NOT_YET_VALID'); } }), motivo: 'conexion_segura', re: /fecha y la hora de esta PC \(figura \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\).*automáticamente/ },
    { nombre: 'certificado "vencido" (reloj de la PC adelantado)', io: central({ ping: () => { throw errRed('CERT_HAS_EXPIRED'); } }), motivo: 'conexion_segura', re: /fecha y la hora de esta PC/ },
    { nombre: 'la central rechaza por otra causa (500): sin HTTP ni texto técnico', io: central({ canje: () => jsonRes(500, { ok: false, message: 'Error interno del handler' }) }), motivo: 'otro', re: /^La casa central no aceptó la conexión\. Vuelva a intentar en unos minutos; si sigue igual, avise a la casa central\.$/ },
    { nombre: 'otra página en esa dirección (HTML)', io: central({ ping: () => new Response('<html>hola</html>', { status: 200 }) as unknown as Response }), motivo: 'no_es_stockflow', re: /no hay un StockFlow/ },
    { nombre: 'certificado inválido', io: central({ ping: () => { throw errRed('ERR_TLS_CERT_ALTNAME_INVALID'); } }), motivo: 'conexion_segura', re: /conexión segura.*antivirus/ },
    { nombre: 'central sin licencia', io: central({ ping: () => jsonRes(200, { ...PING_OK, license: 'unlicensed' }) }), motivo: 'sin_licencia', re: /no tiene una licencia activa/ },
    { nombre: 'central SIN edición Multisucursal', io: central({ ping: () => jsonRes(200, { ...PING_OK, sucursales: false }) }), motivo: 'sin_edicion', re: /La casa central no tiene habilitada la edición Multisucursal/ },
    { nombre: 'central con versión vieja (no informa sucursales)', io: central({ ping: () => jsonRes(200, { ok: true, timestamp: 1, license: 'active', version: '1.12.1' }) }), motivo: 'version_vieja', re: /versión de StockFlow que no admite/ },
    { nombre: 'la central bajó de edición entre el ping y el canje (404)', io: central({ canje: () => jsonRes(404, { ok: false, message: 'Ruta inexistente' }) }), motivo: 'sin_edicion', re: /edición Multisucursal/ },
    { nombre: 'código vencido (motivo del servidor)', io: central({ canje: () => jsonRes(401, { ok: false, motivo: 'vencido', message: 'x' }) }), motivo: 'codigo_vencido', re: /venció \(dura 15 minutos\)/ },
    { nombre: 'código vencido (servidor sin "motivo", por el texto)', io: central({ canje: () => jsonRes(401, { ok: false, message: 'El código de emparejamiento venció. Genere uno nuevo en el servidor.' }) }), motivo: 'codigo_vencido', re: /venció/ },
    { nombre: 'código ya usado o mal copiado', io: central({ canje: () => jsonRes(401, { ok: false, motivo: 'invalido', message: 'x' }) }), motivo: 'codigo_invalido', re: /no es válido o ya se usó/ },
    { nombre: 'PC ya emparejada (409)', io: central({ canje: () => jsonRes(409, { ok: false, message: 'x' }) }), motivo: 'pc_ya_emparejada', re: /ya figura emparejada.*revóquela/ },
    { nombre: 'demasiados intentos (429): el mensaje de la central', io: central({ canje: () => jsonRes(429, { ok: false, message: 'Demasiados intentos de emparejamiento fallidos. Espere 600 segundos y vuelva a intentar.' }) }), motivo: 'bloqueado', re: /Espere 600 segundos/ },
    { nombre: 'se corta internet en el canje', io: central({ canje: () => { throw errRed('ENETUNREACH'); }, internet: false }), motivo: 'sin_internet', re: /no tiene conexión a internet/ },
  ];
  for (const c of casos) {
    const r = await emparejarConCentral(c.entrada ?? 'https://bruno.mistockflow.com', c.codigo ?? 'ABCDE-FGH23', pc, c.io);
    check(
      `${c.nombre} → ${c.motivo}`,
      !r.ok && r.motivo === c.motivo && c.re.test(r.mensaje) && (!c.sinPedidos || c.io.pedidos.length === 0),
      JSON.stringify(r),
    );
  }
  // "Probar conexión" informa sin decidir sobre la edición.
  const rev = await revisarCentral('bruno.mistockflow.com', central({ ping: () => jsonRes(200, { ...PING_OK, sucursales: false }) }));
  check('revisarCentral: conecta y avisa sucursales=false (no es error de conexión)', rev.ok && rev.sucursales === false, JSON.stringify(rev));
  const revViejo = await revisarCentral('bruno.mistockflow.com', central({ ping: () => jsonRes(200, { ok: true, timestamp: 1 }) }));
  check('revisarCentral: central vieja → sucursales null', revViejo.ok && revViejo.sucursales === null, JSON.stringify(revViejo));
}

/* ------------------------------------------------------------------------ */
/* PC de sucursal: ¿es SU casa central? Sin redirecciones; http sólo en la red */
/* ------------------------------------------------------------------------ */
async function pruebasIdentidadDeCentral(): Promise<void> {
  console.log('\n[sucursal] identidad de la casa central, redirecciones y http por internet');
  const jsonRes = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) as unknown as Response;
  const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const SECRETO = 'secreto-de-la-pc-de-sucursal';
  const TOKEN = `sfd1.${ID}.${SECRETO}`;
  const HASH = createHash('sha256').update(SECRETO, 'utf8').digest('hex');
  /** Central de mentira: contesta /lan/central con lo que diga `responder`. */
  function centralFalsa(responder: (body: { dispositivoId: string; nonce: string }) => Response | Promise<Response>): IoCentral & { pedidos: { url: string; init?: RequestInit }[] } {
    const pedidos: { url: string; init?: RequestInit }[] = [];
    return {
      pedidos,
      hayInternet: async () => true,
      timeoutMs: 2000,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        pedidos.push({ url: String(url), init });
        return responder(JSON.parse(String(init?.body ?? '{}')) as { dispositivoId: string; nonce: string });
      }) as typeof fetch,
    };
  }
  const buena = centralFalsa((b) => jsonRes(200, { ok: true, prueba: pruebaDeCentral(HASH, b.dispositivoId, b.nonce) }));
  const rBuena = await verificarCentral('https://coronda.mistockflow.com', TOKEN, buena);
  check('la central de verdad (tiene el hash) → verificada', rBuena.ok, JSON.stringify(rBuena));
  const cuerpo = JSON.parse(String(buena.pedidos[0]?.init?.body ?? '{}')) as { dispositivoId?: string; nonce?: string };
  check(
    'el pedido de identidad NO lleva el token: sólo el id y un número al azar',
    cuerpo.dispositivoId === ID && typeof cuerpo.nonce === 'string' && cuerpo.nonce.length >= 22 && !String(buena.pedidos[0]?.init?.body).includes(SECRETO),
    String(buena.pedidos[0]?.init?.body),
  );
  check('el pedido de identidad no sigue redirecciones', buena.pedidos[0]?.init?.redirect === 'error');
  const dos = centralFalsa((b) => jsonRes(200, { ok: true, prueba: pruebaDeCentral(HASH, b.dispositivoId, b.nonce) }));
  await verificarCentral('https://coronda.mistockflow.com', TOKEN, dos);
  await verificarCentral('https://coronda.mistockflow.com', TOKEN, dos);
  const nonces = dos.pedidos.map((p) => (JSON.parse(String(p.init?.body)) as { nonce: string }).nonce);
  check('cada verificación usa un número nuevo (una respuesta vieja no sirve)', nonces.length === 2 && nonces[0] !== nonces[1]);

  const casos: { nombre: string; io: IoCentral; motivo: string; re: RegExp }[] = [
    { nombre: 'otro StockFlow en esa dirección (prueba que no coincide)', io: centralFalsa(() => jsonRes(200, { ok: true, prueba: 'a'.repeat(64) })), motivo: 'suplantacion', re: /no responde como la casa central.*no le envía su usuario ni su contraseña/ },
    { nombre: 'una respuesta repetida de otra vez (otro número)', io: centralFalsa(() => jsonRes(200, { ok: true, prueba: pruebaDeCentral(HASH, ID, 'otro-numero-cualquiera-0123456789') })), motivo: 'suplantacion', re: /no responde como la casa central/ },
    { nombre: 'sin la ruta (404 pelado)', io: centralFalsa(() => jsonRes(404, { ok: false, message: 'Ruta inexistente' })), motivo: 'suplantacion', re: /no responde como la casa central/ },
    { nombre: 'otra página (HTML)', io: centralFalsa(() => new Response('<html>hola</html>', { status: 200 }) as unknown as Response), motivo: 'suplantacion', re: /no responde como la casa central/ },
    { nombre: 'la central no conoce esta PC (404 desconocida)', io: centralFalsa(() => jsonRes(404, { ok: false, motivo: 'desconocida' })), motivo: 'pc_desconocida', re: /no reconoce esta PC.*Conectar esta PC con un código nuevo/ },
    { nombre: 'central apagada (Cloudflare 530)', io: centralFalsa(() => new Response('error code: 1033', { status: 530 }) as unknown as Response), motivo: 'no_responde', re: /no responde.*apagada/ },
  ];
  for (const c of casos) {
    const r = await verificarCentral('https://coronda.mistockflow.com', TOKEN, c.io);
    check(`${c.nombre} → ${c.motivo}`, !r.ok && r.motivo === c.motivo && c.re.test(r.mensaje), JSON.stringify(r));
  }
  const tokMalo = await verificarCentral('https://coronda.mistockflow.com', 'cualquier-cosa', buena);
  check('token guardado dañado → pide volver a conectar (sin consultar)', !tokMalo.ok && tokMalo.motivo === 'pc_desconocida', JSON.stringify(tokMalo));

  // --- El puente: si la central no está verificada, NO sale nada.
  const salidos: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchAnota: typeof fetch = async (url: string | URL | Request, init?: RequestInit) => {
    salidos.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
    if (String(url).endsWith('/lan/ping')) return jsonRes(200, { ok: true, timestamp: 1 }); // "no admito identidad"
    return jsonRes(200, { ok: true, data: { _lanSessionToken: 'jwt' } });
  };
  const ioBase = { invoke: async () => ({ ok: true, data: null }) as IpcResponse<unknown>, listeners: { on: () => {}, off: () => {} } };
  const cfgSucursal = parseLanArgs(['--lan-mode=client', '--lan-server-url=https://coronda.mistockflow.com']).lanCfg;
  const pedidas: (boolean | undefined)[] = [];
  const rechazada = createCaller('client', cfgSucursal, {
    ...ioBase,
    fetch: fetchAnota,
    sondearIdentidad: true,
    identidad: async (o) => {
      pedidas.push(o?.verificarCentral);
      return { terminalId: 'b'.repeat(64), terminalNombre: 'Caja 1', dispositivoToken: null, central: 'rechazada', motivoCentral: 'No es su casa central (prueba).' };
    },
  });
  const login = await rechazada('auth:login', { username: 'cajero', password: 'clave-secreta' });
  const lista = await rechazada('articles:list');
  check(
    'central NO verificada: el login vuelve con el motivo y NO se manda nada (ni la contraseña)',
    !login.ok && login.code === 'UNAUTHENTICATED' && login.message === 'No es su casa central (prueba).' && !lista.ok && salidos.length === 0,
    JSON.stringify({ login, n: salidos.length }),
  );
  check('al iniciar sesión se pide verificar a la central en ese momento', pedidas[0] === true, JSON.stringify(pedidas));
  check('una falla no se recuerda: el pedido siguiente vuelve a preguntar', pedidas.length === 2, JSON.stringify(pedidas));
  // Verificada: los encabezados viajan aunque el sondeo diga que no (lo contesta la misma dirección).
  const verificada = createCaller('client', cfgSucursal, {
    ...ioBase,
    fetch: fetchAnota,
    sondearIdentidad: true,
    identidad: async () => ({ terminalId: 'b'.repeat(64), terminalNombre: 'Caja 1', dispositivoToken: TOKEN, central: 'verificada' }),
  });
  await verificada('articles:list');
  const rpc = salidos.find((s) => s.url.endsWith('/lan/rpc'));
  check(
    'central verificada: el token viaja (no depende del sondeo que contesta esa dirección)',
    rpc?.headers['x-stockflow-dispositivo'] === TOKEN,
    JSON.stringify(rpc?.headers),
  );

  // --- Redirecciones: con fetch de verdad contra servidores locales.
  const golpesDestino: string[] = [];
  const destino = crearServidorHttp((req, res) => {
    golpesDestino.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, timestamp: 1, license: 'active', identidad: true, sucursales: true, data: { token: 'robado' } }));
  });
  await new Promise<void>((r) => destino.listen(47774, '127.0.0.1', () => r()));
  const redirige = crearServidorHttp((req, res) => {
    if (req.method === 'GET' && req.url === '/lan/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, timestamp: 1, license: 'active', identidad: true, sucursales: true }));
      return;
    }
    res.writeHead(307, { location: `http://127.0.0.1:47774${req.url}` });
    res.end();
  });
  await new Promise<void>((r) => redirige.listen(47775, '127.0.0.1', () => r()));
  const pingRedirige = crearServidorHttp((_req, res) => {
    res.writeHead(308, { location: 'http://127.0.0.1:47774/lan/ping' });
    res.end();
  });
  await new Promise<void>((r) => pingRedirige.listen(47776, '127.0.0.1', () => r()));
  try {
    const revR = await revisarCentral('http://127.0.0.1:47776');
    check('la dirección redirige → "no hay un StockFlow" (no se sigue)', !revR.ok && revR.motivo === 'no_es_stockflow', JSON.stringify(revR));
    const empR = await emparejarConCentral('http://127.0.0.1:47775', 'ABCDE-FGH23', { nombre: 'Caja', machineId: 'ab'.repeat(32) });
    check('el canje con redirección no se sigue: el código no viaja a otro lado', !empR.ok && golpesDestino.length === 0, JSON.stringify({ empR, golpesDestino }));
    const verR = await verificarCentral('http://127.0.0.1:47775', TOKEN);
    check('la verificación con redirección → suplantación (no se sigue)', !verR.ok && verR.motivo === 'suplantacion' && golpesDestino.length === 0, JSON.stringify({ verR, golpesDestino }));
    const callerR = createCaller('client', { serverIp: '127.0.0.1', serverPort: 47775, token: '123456' }, ioBase);
    const rpcR = await callerR('articles:list');
    check('el puente no sigue redirecciones en /lan/rpc', !rpcR.ok && golpesDestino.length === 0, JSON.stringify({ rpcR, golpesDestino }));
  } finally {
    await Promise.all([destino, redirige, pingRedirige].map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}

/* ------------------------------------------------------------------------ */
/* Pantallas de la PC de sucursal: mensaje para mandar, errores, app/navegador */
/* ------------------------------------------------------------------------ */
async function pruebasPantallasSucursal(): Promise<void> {
  console.log('\n[sucursal] mensaje para la sucursal, errores de la casa central y app/navegador');
  const vence = new Date(2026, 9, 4, 2, 58).getTime();
  const msj = armarMensajeSucursal('https://coronda.mistockflow.com', 'R3VWU-RZFDE', vence);
  check(
    'el mensaje trae dónde se carga, la dirección, el código con su vencimiento y el usuario',
    msj.includes(`«${ENLACE_CONECTAR_PC}»`) && msj.includes('Dirección: https://coronda.mistockflow.com ') && msj.includes('Código: R3VWU-RZFDE (vence a las 02:58)') && /usuario y contraseña/.test(msj),
    msj,
  );
  const ida = extraerDatosDeConexion(msj);
  check('pegado entero: salen la dirección y el código', ida.direccion === 'https://coronda.mistockflow.com' && ida.codigo === 'R3VWU-RZFDE', JSON.stringify(ida));
  const casos: [string, { direccion?: string; codigo?: string }][] = [
    ['Dirección: https://coronda.mistockflow.com. Código: r3vwu rzfde', { direccion: 'https://coronda.mistockflow.com' }],
    ['https://coronda.mistockflow.com código: r3vwurzfde', { direccion: 'https://coronda.mistockflow.com', codigo: 'R3VWU-RZFDE' }],
    ['PC de la sucursal R3VWURZFDE en https://x.mistockflow.com/', { direccion: 'https://x.mistockflow.com/', codigo: 'R3VWU-RZFDE' }],
    ['https://coronda.mistockflow.com', { direccion: 'https://coronda.mistockflow.com' }],
    ['ABCDE-FGH23', { codigo: 'ABCDE-FGH23' }],
    ['código: ABCD0-FGH23 (con un cero)', {}],
    ['Para conectar la PC de la sucursal: hola', {}],
  ];
  for (const [texto, esperado] of casos) {
    const r = extraerDatosDeConexion(texto);
    check(`extraerDatosDeConexion(${JSON.stringify(texto)})`, r.direccion === esperado.direccion && r.codigo === esperado.codigo, JSON.stringify(r));
  }

  // --- La PC de sucursal no llega a la casa central: mensajes que dicen dónde está el problema.
  const ioBase = { invoke: async () => ({ ok: true, data: null }) as IpcResponse<unknown>, listeners: { on: () => {}, off: () => {} } };
  const cfgSucursal = parseLanArgs(['--lan-mode=client', '--lan-server-url=https://coronda.mistockflow.com']).lanCfg;
  check('parseLanArgs con dirección web marca la PC como sucursal', cfgSucursal?.esSucursal === true);
  const con = (respuesta: () => Response | Promise<Response>) =>
    createCaller('client', cfgSucursal, { ...ioBase, fetch: (async () => respuesta()) as unknown as typeof fetch });
  const r530 = await con(() => new Response('error code: 1033', { status: 530 }) as unknown as Response)('auth:login', { username: 'a', password: 'b' });
  check('central apagada (Cloudflare 530) → "La casa central no responde…"', !r530.ok && r530.message === MENSAJE_CENTRAL_NO_RESPONDE, JSON.stringify(r530));
  const rHtml = await con(() => new Response('<html>Bad gateway</html>', { status: 502 }) as unknown as Response)('articles:list');
  check('502 con HTML → el mismo mensaje (no "Respuesta inválida del servidor LAN")', !rHtml.ok && rHtml.message === MENSAJE_CENTRAL_NO_RESPONDE, JSON.stringify(rHtml));
  const rRed = await con(() => { throw new TypeError('Failed to fetch'); })('articles:list');
  check('sin red → "Sin conexión con la casa central…"', !rRed.ok && rRed.message === MENSAJE_SIN_CONEXION_CENTRAL, JSON.stringify(rRed));
  const rLan = await createCaller('client', { serverIp: '127.0.0.1', serverPort: 7777, token: '123456' }, {
    ...ioBase,
    fetch: (async () => new Response('<html/>', { status: 200 })) as unknown as typeof fetch,
  })('articles:list');
  check('terminal de red local: el mensaje de siempre', !rLan.ok && rLan.message === 'Respuesta inválida del servidor LAN', JSON.stringify(rLan));

  // --- App instalada o navegador (el user-agent de Electron también dice "Mozilla").
  const ua = (u?: string) => ({ headers: u === undefined ? {} : { 'user-agent': u } });
  check(
    'user-agent de Electron → app instalada',
    viaDelPedido(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) StockFlow/1.13.0 Chrome/124.0.6367.243 Electron/30.5.1 Safari/537.36')) === 'app',
  );
  check('user-agent de Chrome → navegador', viaDelPedido(ua('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36')) === 'navegador');
  check('sin user-agent (terminal vieja, curl) → app', viaDelPedido(ua()) === 'app' && viaDelPedido(ua('node')) === 'app');
}
