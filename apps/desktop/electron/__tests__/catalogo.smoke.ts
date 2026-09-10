/**
 * ESPEJO DEL CATÁLOGO WEB — qué se publica y qué pasa cuando el catálogo falla.
 *   pnpm --filter @stockflow/desktop test:catalogo
 *
 * El catálogo es un doble que guarda lo que recibe: se verifica el pedido REAL
 * que saldría a la red, sin depender de que haya un catálogo levantado.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { createServiceContext, createServices } from '@stockflow/core';
import { CatalogoSync } from '../catalogo/CatalogoSync';

let fallas = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) fallas++;
  console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'catsync-'));
const { db } = initLocalDb(join(dir, 'x.db'));
const repos = createRepositories(db);

// Catálogo simulado: guarda lo que recibe.
const recibido: any[] = [];
let responder = 200;
const fetchFalso = (async (url: any, init: any) => {
  recibido.push({ url: String(url), body: JSON.parse(init.body) });
  return { ok: responder === 200, status: responder, json: async () => ({ actualizados: 1 }) } as any;
}) as typeof fetch;

const main = async () => {
  const admin = await repos.users.findByUsername('admin');
  const { passwordHash: _p, ...safe } = admin!;
  const ctx = createServiceContext(db, safe);
  const svc = createServices(ctx);
  const cf = await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });

  await repos.company.upsert({ name: 'Prueba', catalogoUrl: 'https://catalogo.test/', catalogoToken: 'secreto' } as never);
  const art = await repos.articles.create({
    barcode: '7790000000001', description: 'Resma A4', listPrice1: '9500.0000', stock: '20.000',
  });

  console.log('\n[apagado por defecto]');
  const sync = new CatalogoSync({ repos, fetchImpl: fetchFalso });
  let r = await sync.correr();
  check('sin activar no manda nada', r.publicados === 0 && recibido.length === 0, r.motivo);

  console.log('\n[primera publicación]');
  repos.catalogo.saveState({ enabled: true });
  r = await sync.correr();
  const env = recibido[0]?.body?.articulos ?? [];
  const nuestro = env.find((a: any) => a.codigo === '7790000000001');
  check('publica los artículos', r.ok && env.length > 0, `${env.length} artículos`);
  check('va a /api/stockflow/articulos', recibido[0]?.url.endsWith('/api/stockflow/articulos'), recibido[0]?.url);
  check('manda código, nombre, precio y stock', !!nuestro && nuestro.nombre === 'Resma A4' && nuestro.precio === 9500 && nuestro.stock === 20, JSON.stringify(nuestro));

  console.log('\n[solo lo que cambió]');
  recibido.length = 0;
  r = await sync.correr();
  check('sin cambios no vuelve a mandar nada', r.publicados === 0 && recibido.length === 0);

  console.log('\n[una venta actualiza el stock publicado]');
  await svc.cash.openCashRegister('0.0000');
  await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: 'pm-efectivo', amount: '19000.0000' }],
    lines: [{ articleId: art.id, quantity: '2.000' }],
  });
  recibido.length = 0;
  r = await sync.correr();
  const tras = (recibido[0]?.body?.articulos ?? []).find((a: any) => a.codigo === '7790000000001');
  check('tras vender 2, publica 18', tras?.stock === 18, `stock enviado: ${tras?.stock}`);
  check('publica SOLO el artículo que cambió', recibido[0]?.body?.articulos?.length === 1, `${recibido[0]?.body?.articulos?.length}`);

  console.log('\n[el catálogo caído no rompe nada]');
  await repos.articles.update(art.id, { listPrice1: '9900.0000' } as never);
  responder = 502;
  recibido.length = 0;
  const antes = repos.catalogo.getState().cursor;
  r = await sync.correr();
  check('avisa el error', !r.ok && (r.motivo ?? '').includes('502'), r.motivo);
  check('NO avanza el cursor', repos.catalogo.getState().cursor === antes);
  responder = 200;
  recibido.length = 0;
  r = await sync.correr();
  const reintento = (recibido[0]?.body?.articulos ?? []).find((a: any) => a.codigo === '7790000000001');
  check('al volver el catálogo, reintenta y manda el precio nuevo', reintento?.precio === 9900, `precio: ${reintento?.precio}`);

  console.log('\n[baja de artículo]');
  await repos.articles.update(art.id, { active: false } as never);
  recibido.length = 0;
  await sync.correr();
  const baja = (recibido[0]?.body?.articulos ?? []).find((a: any) => a.codigo === '7790000000001');
  check('el artículo dado de baja viaja como inactivo', baja?.activo === false, JSON.stringify(baja?.activo));

  closeLocalDb(db);
  rmSync(dir, { recursive: true, force: true });
  console.log(fallas === 0 ? '\n✅ TODO OK\n' : `\n❌ ${fallas} FALLAS\n`);
  process.exit(fallas === 0 ? 0 : 1);
};
void main();
