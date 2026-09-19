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
/** Lo que el catálogo falso devuelve en GET /api/stockflow/pedidos. */
let pedidosDelCatalogo: unknown[] = [];
const fetchFalso = (async (url: any, init: any) => {
  const u = String(url);
  recibido.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
  const esListaPedidos = u.endsWith('/api/stockflow/pedidos') && (!init?.method || init.method === 'GET');
  return {
    ok: responder === 200,
    status: responder,
    json: async () => (esListaPedidos ? { pedidos: pedidosDelCatalogo } : { actualizados: 1 }),
  } as any;
}) as typeof fetch;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  console.log('\n[se publica el stock físico MENOS lo reservado por pedidos pendientes]');
  const fisico = Number((await repos.articles.findById(art.id))!.stock);
  repos.catalogoPedidos.guardar({
    ...pedido, pedidoId: 'pb-reserva-1', numero: 902,
    items: [{ sku: 'X', codigo_sistema: '7790000000001', nombre: 'Resma A4', cant: 3, precio: 9900, subtotal: 29700, servicio: false }],
  });
  await repos.articles.update(art.id, { notes: 'toco para republicar' });
  recibido.length = 0;
  await sync.correr();
  const publicadoConReserva = (recibido[0]?.body?.articulos ?? []).find((a: any) => a.codigo === '7790000000001');
  check(`con 3 unidades en un pedido pendiente publica ${fisico} - 3`, publicadoConReserva?.stock === fisico - 3, `físico ${fisico}, publicado ${publicadoConReserva?.stock}`);
  const pedReserva = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-reserva-1')!;
  repos.catalogoPedidos.marcar(pedReserva.id, 'rechazado');
  await repos.articles.update(art.id, { notes: 'toco de nuevo' });
  recibido.length = 0;
  await sync.correr();
  const publicadoSinReserva = (recibido[0]?.body?.articulos ?? []).find((a: any) => a.codigo === '7790000000001');
  check('rechazado el pedido, vuelve a publicar el físico completo', publicadoSinReserva?.stock === fisico, `publicado ${publicadoSinReserva?.stock}`);

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
  // Catálogo caído: el aviso falla y el pedido tiene que seguir pendiente de
  // aviso (no marcarse), para reintentar cuando vuelva.
  responder = 503;
  const caido = await sync.cancelarPedidosDeVentasAnuladas();
  check(
    'con el catálogo caído no marca el pedido y lo deja para reintentar',
    caido.cancelados === 0 && caido.sinAviso === 1 && repos.catalogoPedidos.buscar(pedAnular.id)!.estado === 'convertido',
    JSON.stringify(caido),
  );
  responder = 200;
  recibido.length = 0;
  const barrido = await sync.cancelarPedidosDeVentasAnuladas();
  const pedDespues = repos.catalogoPedidos.buscar(pedAnular.id)!;
  const aviso = recibido.find((r) => r.url.endsWith(`/api/stockflow/pedidos/pb-anular-1/estado`));
  check('el pedido queda rechazado y conserva la venta', pedDespues.estado === 'rechazado' && pedDespues.saleId === ventaPedido.sale.id, `${pedDespues.estado} / ${pedDespues.saleId?.slice(-6)}`);
  check('le avisa "cancelado" al catálogo', barrido.cancelados === 1 && aviso?.body?.estado === 'cancelado', JSON.stringify(aviso?.body));
  check('el stock volvió al sistema', Number((await repos.articles.findById(art.id))!.stock) === stockAntes + 1);
  recibido.length = 0;
  const segundoBarrido = await sync.cancelarPedidosDeVentasAnuladas();
  check('el barrido es idempotente: no vuelve a avisar', segundoBarrido.cancelados === 0 && recibido.length === 0);

  /* ============ Auditoría sep-2026, tanda 6 ============ */
  console.log('\n[B1] marcar() es compare-and-set');
  repos.catalogoPedidos.guardar({ ...pedido, pedidoId: 'pb-cas-1', numero: 910 });
  const pedCas = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-cas-1')!;
  const cas1 = repos.catalogoPedidos.marcar(pedCas.id, 'convertido', ventaPedido.sale.id);
  const cas2 = repos.catalogoPedidos.marcar(pedCas.id, 'rechazado');
  check('la primera resolución gana', cas1 === true);
  check('la segunda (otra terminal) no pisa y devuelve false', cas2 === false && repos.catalogoPedidos.buscar(pedCas.id)!.estado === 'convertido');
  check('resolverlo deja el aviso al catálogo como pendiente', repos.catalogoPedidos.buscar(pedCas.id)!.avisoPendiente === 'confirmado');

  repos.catalogoPedidos.guardar({ ...pedido, pedidoId: 'pb-res-1', numero: 911 });
  const pedRes = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-res-1')!;
  const res1 = repos.catalogoPedidos.reservar(pedRes.id);
  const res2 = repos.catalogoPedidos.reservar(pedRes.id);
  check('reservar() gana una sola vez (la venta se registra DESPUÉS de reservar)', res1 === true && res2 === false);
  check('reservado: convertido sin venta y sin aviso pendiente', (() => { const p = repos.catalogoPedidos.buscar(pedRes.id)!; return p.estado === 'convertido' && p.saleId == null && p.avisoPendiente == null; })());
  repos.catalogoPedidos.liberar(pedRes.id);
  check('si la venta falla, liberar() lo devuelve a pendiente', repos.catalogoPedidos.buscar(pedRes.id)!.estado === 'pendiente');
  check('y vuelve a poder reservarse', repos.catalogoPedidos.reservar(pedRes.id) === true);
  repos.catalogoPedidos.confirmarConversion(pedRes.id, ventaPedido.sale.id);
  check('confirmarConversion enlaza la venta y deja el aviso pendiente', (() => { const p = repos.catalogoPedidos.buscar(pedRes.id)!; return p.saleId === ventaPedido.sale.id && p.avisoPendiente === 'confirmado'; })());
  repos.catalogoPedidos.liberar(pedRes.id);
  check('liberar() no toca un pedido que ya tiene venta', repos.catalogoPedidos.buscar(pedRes.id)!.estado === 'convertido');
  repos.catalogoPedidos.avisoHecho(pedRes.id);

  console.log('\n[B4] el aviso al catálogo se reintenta hasta que acuse');
  responder = 503;
  recibido.length = 0;
  const intento1 = await sync.reintentarAvisosPendientes();
  check('catálogo caído: el aviso sigue pendiente', intento1.entregados === 0 && intento1.pendientes >= 1 && repos.catalogoPedidos.buscar(pedCas.id)!.avisoPendiente === 'confirmado', JSON.stringify(intento1));
  responder = 200;
  recibido.length = 0;
  const intento2 = await sync.reintentarAvisosPendientes();
  const avisoCas = recibido.find((r) => r.url.endsWith('/api/stockflow/pedidos/pb-cas-1/estado'));
  check('catálogo de vuelta: se entrega "confirmado" con el número de venta', intento2.entregados >= 1 && avisoCas?.body?.estado === 'confirmado' && /^X-\d+$/.test(avisoCas?.body?.venta_sistema ?? ''), JSON.stringify(avisoCas?.body));
  check('y ya no se debe nada', repos.catalogoPedidos.buscar(pedCas.id)!.avisoPendiente == null);
  recibido.length = 0;
  const intento3 = await sync.reintentarAvisosPendientes();
  check('sin deudas no llama al catálogo', intento3.entregados === 0 && recibido.length === 0);

  console.log('\n[B3] un pedido inválido no bloquea la cola');
  pedidosDelCatalogo = [
    { id: 'pb-malo-1', numero: 'no-es-numero', total: 'abc', cliente_nombre: 'Roto', items: 'no-es-array' },
    { id: 'pb-bueno-1', numero: 920, total: 9500, created: '2026-09-18T10:00:00Z', cliente_nombre: 'Sano', items: [{ sku: 'X', codigo_sistema: '7790000000001', nombre: 'Resma A4', cant: 1, precio: 9500, subtotal: 9500, servicio: false }, null, 'basura'] },
    null,
  ];
  recibido.length = 0;
  const bajada = await sync.traerPedidos();
  check('la bajada termina bien y trae el pedido sano', bajada.ok && bajada.nuevos === 1, JSON.stringify(bajada));
  const sano = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-bueno-1');
  check('el sano quedó guardado con sus líneas válidas solamente', !!sano && (JSON.parse(sano.items) as unknown[]).length === 1, sano?.items);
  check('el roto no se guardó', !repos.catalogoPedidos.listar().some((p) => p.pedidoId === 'pb-malo-1'));
  check('acusa "tomado" sólo el sano', recibido.some((r) => r.url.endsWith('/pedidos/pb-bueno-1/estado')) && !recibido.some((r) => r.url.endsWith('/pedidos/pb-malo-1/estado')));
  const reservas = repos.catalogo.reservadoPorPedidosPendientes();
  check('json_each ignora las líneas que no son objetos', reservas.get('7790000000001') === 1, JSON.stringify([...reservas]));
  pedidosDelCatalogo = [];
  repos.catalogoPedidos.marcar(sano!.id, 'rechazado');
  repos.catalogoPedidos.avisoHecho(sano!.id);

  console.log('\n[B2] en modo net se publica el precio FINAL');
  await repos.company.upsert({ priceMode: 'net' } as never);
  await repos.articles.update(art.id, { listPrice1: '1000.0000', vatRate: '21.00' });
  recibido.length = 0;
  await sync.correr();
  const publicadoNeto = recibido.flatMap((r) => r.body?.articulos ?? []).find((a: any) => a.codigo === '7790000000001');
  check('lista 1000 neto + 21% → publica 1210', publicadoNeto?.precio === 1210, JSON.stringify(publicadoNeto?.precio));
  await repos.company.upsert({ priceMode: 'gross' } as never);
  await esperar(5);
  await repos.articles.update(art.id, { listPrice1: '9500.0000' });
  recibido.length = 0;
  await sync.correr();
  const publicadoBruto = recibido.flatMap((r) => r.body?.articulos ?? []).find((a: any) => a.codigo === '7790000000001');
  check('en modo gross publica la lista tal cual', publicadoBruto?.precio === 9500, JSON.stringify(publicadoBruto?.precio));

  console.log('\n[B5] crear_faltantes: configurable y sólo para activos');
  const artBaja = await repos.articles.create({ barcode: '7790000000099', description: 'Discontinuado', listPrice1: '10.0000', stock: '0.000' });
  await esperar(5);
  await repos.articles.update(artBaja.id, { active: false });
  // (la sección "baja de artículo" lo había desactivado)
  await repos.articles.update(art.id, { active: true, notes: 'toco para republicar junto al de baja' });
  recibido.length = 0;
  await sync.correr();
  const postsActivos = recibido.filter((r) => r.url.endsWith('/api/stockflow/articulos') && r.body.crear_faltantes === true);
  const postsInactivos = recibido.filter((r) => r.url.endsWith('/api/stockflow/articulos') && r.body.crear_faltantes === false);
  check('los activos van con crear_faltantes=true', postsActivos.length === 1 && postsActivos[0].body.articulos.some((a: any) => a.codigo === '7790000000001') && !postsActivos[0].body.articulos.some((a: any) => a.codigo === '7790000000099'));
  check('los de baja van aparte con crear_faltantes=false', postsInactivos.length === 1 && postsInactivos[0].body.articulos.every((a: any) => a.codigo === '7790000000099' && a.activo === false));
  repos.catalogo.saveState({ crearFaltantes: false });
  await esperar(5);
  await repos.articles.update(art.id, { notes: 'toco otra vez' });
  recibido.length = 0;
  await sync.correr();
  check('apagado: una sola tanda y nunca crea', recibido.length === 1 && recibido[0].body.crear_faltantes === false);
  repos.catalogo.saveState({ crearFaltantes: true });

  console.log('\n[B6] el reinicio de operativa no revienta con pedidos web ni comprobantes');
  const raw0 = db.$client;
  const ventaConCae = await svc.sales.createSale({
    type: 'B', customerId: cf!.id,
    payments: [{ paymentMethodId: 'pm-efectivo', amount: '9500.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  repos.fiscal.createVoucher(
    {
      voucherCode: 6, letter: 'B', kind: 'invoice', salePoint: 1, number: 1, date: Date.now(),
      saleId: ventaConCae.sale.id, customerId: cf!.id, customerDocType: 99, customerDocNumber: '0', customerName: 'Consumidor Final',
      netAmount: '7851.2400', vatAmount: '1648.7600', total: '9500.0000', userId: safe.id,
      vatDetails: [{ vatId: 5, baseAmount: '7851.2400', vatAmount: '1648.7600' }],
    } as never,
    { cae: '12345678901234', caeExpiry: Date.now() + 864e5 },
  );
  const ventaComun = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: 'pm-efectivo', amount: '9500.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  repos.catalogoPedidos.guardar({ ...pedido, pedidoId: 'pb-reset-1', numero: 930 });
  const pedReset = repos.catalogoPedidos.listar().find((p) => p.pedidoId === 'pb-reset-1')!;
  repos.catalogoPedidos.marcar(pedReset.id, 'convertido', ventaComun.sale.id);
  // El POS va en una caja SIN ventas conservadas (la que se va a borrar).
  const cajaConCae = (await repos.cashRegisters.getCurrentOpen())!;
  await svc.cash.closeCashRegister(cajaConCae.id, '0.0000');
  const cajaNueva = await svc.cash.openCashRegister('0.0000');
  raw0
    .prepare("INSERT INTO mp_pos_devices (id, cash_register_id, external_pos_id, mp_pos_id, qr_url, active, created_at, updated_at) VALUES ('pos-1', ?, 'EXT-1', 'MP-1', 'https://mp/qr', 1, 0, 0)")
    .run(cajaNueva.id);
  let errReset: string | null = null;
  try {
    repos.maintenance.resetOperationalData();
  } catch (e) {
    errReset = e instanceof Error ? e.message : String(e);
  }
  check('el reinicio completa sin error de FK', errReset == null, errReset ?? '');
  check('la venta con CAE se conserva', (await repos.sales.findById(ventaConCae.sale.id)) != null);
  check('la venta común se borró', (await repos.sales.findById(ventaComun.sale.id)) == null);
  const pedTrasReset = repos.catalogoPedidos.buscar(pedReset.id)!;
  check('el pedido web queda, sin la venta borrada', pedTrasReset != null && pedTrasReset.saleId == null && pedTrasReset.estado === 'convertido');
  check('el POS de MP de la caja borrada se desasoció', (raw0.prepare('SELECT COUNT(*) AS n FROM mp_pos_devices').get() as { n: number }).n === 0);
  check('la caja de la venta con CAE sigue existiendo', (await repos.cashRegisters.findById(ventaConCae.sale.cashRegisterId)) != null);

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
