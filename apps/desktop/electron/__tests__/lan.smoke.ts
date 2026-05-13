/**
 * Smoke test del servidor LAN: arranca `LanServer` con un `HandlerMap` mock,
 * hace HTTP POST a `/lan/rpc` y valida token, canal y respuesta.
 *
 *   pnpm --filter @stockflow/desktop test:lan
 */
import { LanServer, signJwt, verifyJwt } from '../lan/LanServer';
import { createCaller, parseLanArgs, shouldRouteLan } from '../preload-bridge';
import type { HandlerMap } from '../ipc/handler-context';
import type { IpcResponse } from '../ipc/types';

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
  const handlers: HandlerMap = {
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
  const r1 = await postJson(url, { channel: 'system:getVersion', payload: {}, token });
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
  const r3 = await postJson(url, { channel: 'system:getVersion', payload: {}, token: 'mal' });
  check('token incorrecto → 401', r3.status === 401, JSON.stringify(r3));

  // 404 con canal inexistente
  const r4 = await postJson(url, { channel: 'no:existe', payload: {}, token });
  check('canal inexistente → 404', r4.status === 404, JSON.stringify(r4));

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
