/**
 * Smoke test del servidor LAN: arranca `LanServer` con un `HandlerMap` mock,
 * hace HTTP POST a `/lan/rpc` y valida token, canal y respuesta.
 *
 *   pnpm --filter @stockflow/desktop test:lan
 */
import { LanServer } from '../lan/LanServer';
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
