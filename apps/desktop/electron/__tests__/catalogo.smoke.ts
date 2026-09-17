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

  console.log('\n[empate de updated_at no pierde artículos]');
  // Un UPDATE masivo (p.ej. el reset de operativa) deja a varios artículos con
  // el MISMO milisegundo. Si la tanda corta justo en medio de ese grupo, el
  // resto tiene que venir igual — no puede quedar del otro lado de un cursor
  // que ya no los alcanza.
  const empatados = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      repos.articles.create({
        barcode: `779000000101${i}`,
        description: `Empatado ${i}`,
        listPrice1: '100.0000',
        stock: '5.000',
      }),
    ),
  );
  const mismoInstante = Date.now();
  for (const a of empatados) {
    db.$client.prepare('UPDATE articles SET updated_at = ? WHERE id = ?').run(mismoInstante, a.id);
  }
  repos.catalogo.saveState({ cursor: mismoInstante - 1 });
  // TANDA real es 500; para forzar el corte en medio del empate sin crear 500
  // artículos, se llama al repositorio directo con un límite chico.
  const pagina = repos.catalogo.listarParaPublicar({ desde: mismoInstante - 1, limite: 2, precioLista: 1 });
  check(
    'la página se estira para no partir el grupo empatado',
    pagina.articulos.length === 3,
    `trajo ${pagina.articulos.length} (esperados los 3 empatados, aunque el límite era 2)`,
  );
  check(
    'los 3 códigos empatados están, ninguno quedó afuera',
    empatados.every((a) => pagina.articulos.some((p) => p.codigo === a.barcode)),
  );

  console.log('\n[redondeo exacto, sin el error de punto flotante]');
  const conBorde = await repos.articles.create({
    barcode: '7790000002000',
    description: 'Precio borde',
    listPrice1: '1.0050',
    stock: '5.000',
  });
  recibido.length = 0;
  await sync.correr();
  const bordeEnviado = (recibido[0]?.body?.articulos ?? []).find((a: any) => a.codigo === conBorde.barcode);
  check(
    'un precio como 1.005 redondea a 1.01, no a 1.00 (el bug clásico de *100/100)',
    bordeEnviado?.precio === 1.01,
    `enviado: ${bordeEnviado?.precio}`,
  );

  console.log('\n[guardar() no revienta ante un pedido repetido]');
  const pedido = {
    pedidoId: 'pb-dup-1',
    numero: 900,
    fecha: Date.now(),
    clienteNombre: 'Duplicado',
    entrega: 'retiro' as const,
    total: '100.0000',
    pagado: false,
    items: [],
  };
  const primera = repos.catalogoPedidos.guardar(pedido);
  let segundaOk = false;
  let segundaValor: boolean | null = null;
  try {
    segundaValor = repos.catalogoPedidos.guardar(pedido);
    segundaOk = true;
  } catch {
    segundaOk = false;
  }
  check('la primera vez guarda', primera === true);
  check(
    'la segunda vez NO revienta — devuelve false, como dice el comentario',
    segundaOk && segundaValor === false,
    segundaOk ? `devolvió ${segundaValor}` : 'tiró una excepción',
  );

  console.log('\n[pagado: un pedido ya cobrado en el catálogo se guarda como tal]');
  const pedidoPagado = { ...pedido, pedidoId: 'pb-pagado-1', pagado: true };
  repos.catalogoPedidos.guardar(pedidoPagado);
  const guardadoPagado = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-pagado-1');
  const guardadoNoPagado = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-dup-1');
  check('pagado:true queda pagado=true', guardadoPagado?.pagado === true, JSON.stringify(guardadoPagado?.pagado));
  check('pagado:false queda pagado=false', guardadoNoPagado?.pagado === false, JSON.stringify(guardadoNoPagado?.pagado));

  console.log('\n[anular la venta cancela el pedido en el catálogo]');
  const precioActual = (await repos.articles.findById(art.id))!.listPrice1;
  const ventaPedido = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: 'pm-efectivo', amount: precioActual }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  repos.catalogoPedidos.guardar({ ...pedido, pedidoId: 'pb-anular-1', numero: 901 });
  const pedAnular = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-anular-1')!;
  repos.catalogoPedidos.marcar(pedAnular.id, 'convertido', ventaPedido.sale.id);
  recibido.length = 0;
  const antesDeAnular = await sync.cancelarPedidosDeVentasAnuladas();
  check('con la venta vigente no cancela nada', antesDeAnular.cancelados === 0 && recibido.length === 0);
  const stockAntes = Number((await repos.articles.findById(art.id))!.stock);
  await svc.sales.voidSale(ventaPedido.sale.id);
  const barrido = await sync.cancelarPedidosDeVentasAnuladas();
  const pedDespues = repos.catalogoPedidos.buscar(pedAnular.id)!;
  const aviso = recibido.find((r) => r.url.endsWith(`/api/stockflow/pedidos/pb-anular-1/estado`));
  check('el pedido queda rechazado y conserva la venta', pedDespues.estado === 'rechazado' && pedDespues.saleId === ventaPedido.sale.id, `${pedDespues.estado} / ${pedDespues.saleId?.slice(-6)}`);
  check('le avisa "cancelado" al catálogo', barrido.cancelados === 1 && aviso?.body?.estado === 'cancelado', JSON.stringify(aviso?.body));
  check('el stock volvió al sistema', Number((await repos.articles.findById(art.id))!.stock) === stockAntes + 1);
  recibido.length = 0;
  const segundoBarrido = await sync.cancelarPedidosDeVentasAnuladas();
  check('el barrido es idempotente: no vuelve a avisar', segundoBarrido.cancelados === 0 && recibido.length === 0);

  console.log('\n[integridad de catalogo_pedidos: FK y CHECK vigentes]');
  const raw = db.$client;
  let fkRechazo = false;
  try {
    raw
      .prepare(
        "INSERT INTO catalogo_pedidos (id, pedido_id, numero, fecha, cliente_nombre, entrega, total, items, estado, sale_id, created_at, updated_at) VALUES ('x-fk','pb-fk',1,0,'x','retiro','0','[]','pendiente','no-existe',0,0)",
      )
      .run();
  } catch {
    fkRechazo = true;
  }
  check('un sale_id que no existe en sales es rechazado (FK)', fkRechazo);

  let checkRechazo = false;
  try {
    raw
      .prepare(
        "INSERT INTO catalogo_pedidos (id, pedido_id, numero, fecha, cliente_nombre, entrega, total, items, estado, created_at, updated_at) VALUES ('x-check','pb-check',1,0,'x','retiro','0','[]','no-es-un-estado-valido',0,0)",
      )
      .run();
  } catch {
    checkRechazo = true;
  }
  check('un estado fuera de la lista es rechazado (CHECK)', checkRechazo);

  closeLocalDb(db);
  rmSync(dir, { recursive: true, force: true });
  console.log(fallas === 0 ? '\n✅ TODO OK\n' : `\n❌ ${fallas} FALLAS\n`);
  process.exit(fallas === 0 ? 0 : 1);
};
void main();
