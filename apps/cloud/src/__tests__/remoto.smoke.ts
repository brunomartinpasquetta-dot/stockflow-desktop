/**
 * Smoke del alta del acceso remoto: una dirección NO se le quita a otro comercio.
 *
 * Contra un Cloudflare de mentira (túneles y registros DNS en memoria, con
 * `fetch` reemplazado): no habla con internet ni necesita credenciales.
 *
 * Ejecutar: pnpm --filter @stockflow/cloud run test:remoto
 */
import { randomUUID } from 'node:crypto';

import { RemoteAccessService } from '../services/RemoteAccessService';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
}

interface Tunel { id: string; name: string; deleted_at: string | null }
interface Registro { id: string; type: string; name: string; content: string; proxied?: boolean }

const ACC = 'cuenta';
const ZONA = 'zona';
const tuneles = new Map<string, Tunel>();
const registros = new Map<string, Registro>();
const pedidos: string[] = [];

function respuesta(status: number, result: unknown, success = status < 400): Response {
  return new Response(JSON.stringify({ success, result, errors: success ? [] : [{ message: 'error' }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = (async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(entrada));
  const metodo = (init?.method ?? 'GET').toUpperCase();
  const ruta = url.pathname.replace('/client/v4', '');
  pedidos.push(`${metodo} ${ruta}${url.search}`);
  const cuerpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  let m: RegExpExecArray | null;
  if (ruta === `/accounts/${ACC}/cfd_tunnel` && metodo === 'GET') {
    const nombre = url.searchParams.get('name');
    return respuesta(200, [...tuneles.values()].filter((t) => t.name === nombre && !t.deleted_at));
  }
  if (ruta === `/accounts/${ACC}/cfd_tunnel` && metodo === 'POST') {
    const t: Tunel = { id: randomUUID(), name: String(cuerpo.name), deleted_at: null };
    tuneles.set(t.id, t);
    return respuesta(200, t);
  }
  if ((m = new RegExp(`^/accounts/${ACC}/cfd_tunnel/([^/]+)$`).exec(ruta))) {
    const t = tuneles.get(m[1]!);
    if (!t) return respuesta(404, null, false);
    if (metodo === 'DELETE') {
      t.deleted_at = new Date().toISOString();
      return respuesta(200, t);
    }
    return respuesta(200, t);
  }
  if (ruta === `/zones/${ZONA}/dns_records` && metodo === 'GET') {
    const nombre = url.searchParams.get('name');
    return respuesta(200, [...registros.values()].filter((r) => r.name === nombre));
  }
  if (ruta === `/zones/${ZONA}/dns_records` && metodo === 'POST') {
    const r: Registro = { id: randomUUID(), type: String(cuerpo.type), name: String(cuerpo.name), content: String(cuerpo.content) };
    registros.set(r.id, r);
    return respuesta(200, r);
  }
  if ((m = new RegExp(`^/zones/${ZONA}/dns_records/([^/]+)$`).exec(ruta)) && metodo === 'PUT') {
    const r = registros.get(m[1]!);
    if (!r) return respuesta(404, null, false);
    Object.assign(r, { type: String(cuerpo.type), content: String(cuerpo.content) });
    return respuesta(200, r);
  }
  return respuesta(404, null, false);
}) as typeof fetch;

const svc = new RemoteAccessService({ apiToken: 'x', accountId: ACC, zoneId: ZONA, dominio: 'mistockflow.com' });
const destinoDe = (host: string): string | undefined => [...registros.values()].find((r) => r.name === host)?.content;
const tunelDe = (tenant: string): Tunel | undefined =>
  [...tuneles.values()].find((t) => t.name === `stockflow-${tenant}` && !t.deleted_at);

async function main(): Promise<void> {
  console.log('\n[remoto] el alta no le quita la dirección a otro comercio');
  const coronda = 'aaaa1111-2222-4333-8444-555566667777';
  const intruso = 'bbbb9999-8888-4777-8666-555544443333';

  // 1. Comercio nuevo: su nombre, libre → se crea.
  const a1 = await svc.alta(coronda, 'Novo Hogar');
  check('comercio nuevo: recibe su nombre', a1.hostname === 'novo-hogar.mistockflow.com', a1);
  check('…apuntado a SU túnel', destinoDe('novo-hogar.mistockflow.com') === `${a1.tunnelId}.cfargotunnel.com`);

  // 2. Una prueba gratis con el MISMO nombre: no se queda con la dirección.
  const b1 = await svc.alta(intruso, 'Novo Hogar');
  check('otro comercio con el mismo nombre: recibe el nombre con sufijo', b1.hostname === 'novo-hogar-bbbb.mistockflow.com', b1);
  check(
    '…y la dirección del primero sigue apuntando al primero',
    destinoDe('novo-hogar.mistockflow.com') === `${a1.tunnelId}.cfargotunnel.com`,
    destinoDe('novo-hogar.mistockflow.com'),
  );

  // 3. El primero reinstala (pide el alta otra vez): mismo nombre, túnel nuevo.
  const a2 = await svc.alta(coronda, 'Novo Hogar');
  check('al reinstalar, el comercio recupera SU dirección', a2.hostname === 'novo-hogar.mistockflow.com' && a2.reusado, a2);
  check('…apuntada al túnel nuevo', destinoDe('novo-hogar.mistockflow.com') === `${a2.tunnelId}.cfargotunnel.com` && tunelDe(coronda)?.id === a2.tunnelId);

  // 4. El intruso reinstala: vuelve a recibir el suyo, con sufijo (estable).
  const b2 = await svc.alta(intruso, 'Novo Hogar');
  check('el segundo, al reinstalar, recibe otra vez su nombre con sufijo', b2.hostname === 'novo-hogar-bbbb.mistockflow.com', b2);

  // 5. Registros que no son túneles de un comercio (la web, el correo, el túnel del dueño): no se tocan.
  registros.set('web', { id: 'web', type: 'CNAME', name: 'bpsg-web.mistockflow.com', content: 'paginas.ejemplo.com' });
  const tunelDuenio: Tunel = { id: randomUUID(), name: 'stockflow-bruno', deleted_at: null };
  tuneles.set(tunelDuenio.id, tunelDuenio);
  registros.set('duenio', { id: 'duenio', type: 'CNAME', name: 'bruno.mistockflow.com', content: `${tunelDuenio.id}.cfargotunnel.com` });
  const c = await svc.alta('cccc0000-1111-4222-8333-444455556666', 'Bruno');
  check('un comercio llamado como el túnel del dueño no se lo lleva', c.hostname === 'bruno-cccc.mistockflow.com' && destinoDe('bruno.mistockflow.com') === `${tunelDuenio.id}.cfargotunnel.com`, c);
  const d = await svc.alta('dddd0000-1111-4222-8333-444455556666', 'BPSG Web');
  check('un registro que no es un túnel (la web) no se pisa', d.hostname === 'bpsg-web-dddd.mistockflow.com' && destinoDe('bpsg-web.mistockflow.com') === 'paginas.ejemplo.com', d);

  // 6. Una dirección vieja de OTRO comercio (su túnel ya borrado) tampoco se toma.
  const viejo: Tunel = { id: randomUUID(), name: 'stockflow-eeee0000-1111-4222-8333-444455556666', deleted_at: new Date().toISOString() };
  tuneles.set(viejo.id, viejo);
  registros.set('viejo', { id: 'viejo', type: 'CNAME', name: 'ferreteria-sur.mistockflow.com', content: `${viejo.id}.cfargotunnel.com` });
  const f = await svc.alta('ffff0000-1111-4222-8333-444455556666', 'Ferretería Sur');
  check('la dirección de otro comercio con el túnel borrado: se usa otro nombre', f.hostname === 'ferreteria-sur-ffff.mistockflow.com' && destinoDe('ferreteria-sur.mistockflow.com') === `${viejo.id}.cfargotunnel.com`, f);
  // …pero si es del MISMO comercio (túnel viejo suyo, borrado), es suya.
  const e = await svc.alta('eeee0000-1111-4222-8333-444455556666', 'Ferretería Sur');
  check('el dueño de esa dirección vieja la recupera', e.hostname === 'ferreteria-sur.mistockflow.com' && destinoDe('ferreteria-sur.mistockflow.com') === `${e.tunnelId}.cfargotunnel.com`, e);

  // 7. Nombres reservados.
  const w = await svc.alta('abab0000-1111-4222-8333-444455556666', 'WWW');
  check('un comercio llamado "www" no recibe www.mistockflow.com', w.hostname === 'www-abab.mistockflow.com', w);

  // 8. Sólo se reapuntaron registros propios: los tres "reinstalar" de arriba.
  const puts = pedidos.filter((p) => p.startsWith('PUT /zones/'));
  check('se reapuntaron sólo las tres direcciones propias (ninguna ajena)', puts.length === 3, puts);

  if (failures > 0) {
    console.error(`\nTEST REMOTO FALLÓ — ${failures} check(s) con error.\n`);
    process.exit(1);
  }
  console.log('\nTEST REMOTO OK ✅\n');
}

main().catch((err) => {
  console.error('\n✗ Excepción durante el test remoto:', err);
  process.exit(1);
});
