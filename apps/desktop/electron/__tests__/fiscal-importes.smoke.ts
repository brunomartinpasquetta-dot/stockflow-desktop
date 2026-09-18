/**
 * Smoke de IMPORTES hacia ARCA y del REINTENTO de un CAE con respuesta perdida.
 * Corre con:
 *   pnpm --filter @stockflow/desktop test:fiscal-importes
 *
 * Qué verifica:
 *  1. `arcaAmounts` sobre una grilla: totales enteros de 1 a 10.000 a 21 %,
 *     con descuentos globales de 5/10/15 %, y combinaciones 21 % + 10,5 %.
 *     En TODOS los casos ImpNeto + ImpIVA = ImpTotal, Σ BaseImp = ImpNeto y
 *     Σ Importe = ImpIVA (las tres identidades que ARCA valida al centavo:
 *     error 10048 y familia), y el total coincide con el de la venta.
 *  2. El XML real que sale hacia ARCA (WsfeClient) para una factura con
 *     descuento global, una con dos alícuotas y la nota de crédito de cada una,
 *     cumple las mismas identidades: las bases de AlicIva ya llevan el
 *     descuento prorrateado (antes ImpNeto 909,09 contra BaseImp 1000).
 *  3. Reintento con `FECompConsultar` simulado: si ARCA autorizó pero la
 *     respuesta se perdió (timeout), el reintento ADOPTA ese comprobante en vez
 *     de emitir otro por la misma venta —también si entre el corte y el
 *     reintento se facturó otra venta (otra terminal o el mismo cajero), porque
 *     consulta el número que pidió y no el último—; si el comprobante de ARCA
 *     no coincide (otro importe), NO lo adopta y emite el siguiente número; y
 *     un rechazo explícito de ARCA no habilita adopción alguna, aunque en ese
 *     número haya un comprobante ajeno idéntico (base migrada).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { FiscalService, createServiceContext, createServices, fechaArcaLocal } from '@stockflow/core';
import { arcaAmounts, proratedVatBreakdown, subDecimal, addDecimal } from '@stockflow/shared';

import { WsfeClient } from '../fiscal/WsfeClient';

const PM_CASH = 'pm-efectivo';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const cents = (v: number | string): number => Math.round(Number(v) * 100);

/* ------------------------------------------------------------------ */
/* 1. Grilla de importes (puro, sin base)                              */
/* ------------------------------------------------------------------ */

interface Caso {
  lines: { lineTotal: string; vatRate: string }[];
  discount: string;
  mode: 'gross' | 'net';
}

/** Las tres identidades + el total de la venta. Devuelve el motivo si falla. */
function verificar(c: Caso): string | null {
  const a = arcaAmounts(c.lines, c.discount, c.mode);
  const neto = cents(a.netAmount);
  const iva = cents(a.vatAmount);
  const total = cents(a.total);
  if (neto + iva !== total) return `neto ${a.netAmount} + IVA ${a.vatAmount} ≠ total ${a.total}`;
  const sumaBases = a.vatDetails.reduce((acc, d) => acc + cents(d.baseAmount), 0);
  if (sumaBases !== neto) return `Σ BaseImp ${sumaBases / 100} ≠ neto ${a.netAmount}`;
  const sumaIva = a.vatDetails.reduce((acc, d) => acc + cents(d.amount), 0);
  if (sumaIva !== iva) return `Σ Importe ${sumaIva / 100} ≠ IVA ${a.vatAmount}`;
  for (const d of a.vatDetails) {
    // ARCA tolera un centavo entre Importe y BaseImp × alícuota.
    const esperado = (d.baseAmount * Number(d.rate)) / 100;
    if (Math.abs(d.amount - esperado) > 0.0101) {
      return `alícuota ${d.rate}: Importe ${d.amount} vs base × tasa ${esperado.toFixed(4)}`;
    }
  }
  // El total tiene que ser el que cobró la venta (misma regla que
  // SaleRepository.createWithLines).
  const subtotal = c.lines.reduce((acc, l) => addDecimal(acc, l.lineTotal, 4), '0.0000');
  const { vatAmount } = proratedVatBreakdown(c.lines, c.discount, subtotal, c.mode);
  const totalVenta =
    c.mode === 'gross'
      ? subDecimal(subtotal, c.discount, 4)
      : subDecimal(addDecimal(subtotal, vatAmount, 4), c.discount, 4);
  if (cents(totalVenta) !== total) return `total ARCA ${a.total} ≠ total venta ${totalVenta}`;
  return null;
}

function grilla(): void {
  console.log('[grilla de importes: 1..10.000 a 21 %, descuentos 5/10/15 %, 21 % + 10,5 %]');
  const pcts = [0, 5, 10, 15];
  let casos = 0;
  const fallas: string[] = [];
  for (let t = 1; t <= 10_000; t++) {
    for (const pct of pcts) {
      const disc = ((t * pct) / 100).toFixed(4);
      // Una sola alícuota.
      casos++;
      let why = verificar({ lines: [{ lineTotal: t.toFixed(4), vatRate: '21.00' }], discount: disc, mode: 'gross' });
      if (why) fallas.push(`$${t} @21 % desc ${pct} %: ${why}`);
      // Dos alícuotas: la segunda línea es pseudoaleatoria pero determinista.
      const t2 = ((t * 7919) % 997) + 1;
      casos++;
      why = verificar({
        lines: [
          { lineTotal: t.toFixed(4), vatRate: '21.00' },
          { lineTotal: t2.toFixed(4), vatRate: '10.50' },
        ],
        discount: disc,
        mode: 'gross',
      });
      if (why) fallas.push(`$${t} @21 % + $${t2} @10,5 % desc ${pct} %: ${why}`);
    }
  }
  // Modo 'net' (precios sin IVA), muestra más chica.
  for (let t = 1; t <= 2_000; t++) {
    for (const pct of pcts) {
      const disc = ((t * pct) / 100).toFixed(4);
      casos++;
      const why = verificar({
        lines: [
          { lineTotal: t.toFixed(4), vatRate: '21.00' },
          { lineTotal: ((t * 31) % 500 + 1).toFixed(4), vatRate: '10.50' },
        ],
        discount: disc,
        mode: 'net',
      });
      if (why) fallas.push(`net $${t} desc ${pct} %: ${why}`);
    }
  }
  check(`${casos} casos: neto + IVA = total, Σ BaseImp = neto, Σ Importe = IVA, total = el de la venta`, fallas.length === 0, fallas.slice(0, 5).join(' | '));

  // Los dos casos del informe, explícitos.
  const a1006 = arcaAmounts([{ lineTotal: '1006.0000', vatRate: '21.00' }]);
  check(
    '$1006 @21 %: cierra al centavo (antes 831,41 + 174,60 = 1006,01)',
    cents(a1006.netAmount) + cents(a1006.vatAmount) === 100600,
    `${a1006.netAmount} + ${a1006.vatAmount} = ${a1006.total}`,
  );
  const aDesc = arcaAmounts([{ lineTotal: '1210.0000', vatRate: '21.00' }], '110.0000');
  check(
    '$1210 con descuento $110: BaseImp lleva el descuento (909,09, no 1000)',
    aDesc.vatDetails[0]?.baseAmount === 909.09 && aDesc.netAmount === 909.09 && aDesc.total === 1100,
    `base ${aDesc.vatDetails[0]?.baseAmount} neto ${aDesc.netAmount} total ${aDesc.total}`,
  );
  const aDos = arcaAmounts([
    { lineTotal: '1.0000', vatRate: '21.00' },
    { lineTotal: '1.0000', vatRate: '10.50' },
  ]);
  check(
    '$1 @21 % + $1 @10,5 %: Σ bases = neto (antes 1,74 vs 1,73)',
    aDos.vatDetails.reduce((acc, d) => acc + cents(d.baseAmount), 0) === cents(aDos.netAmount) &&
      cents(aDos.netAmount) + cents(aDos.vatAmount) === 200,
    `bases ${aDos.vatDetails.map((d) => d.baseAmount).join('+')} neto ${aDos.netAmount} IVA ${aDos.vatAmount}`,
  );
}

/* ------------------------------------------------------------------ */
/* 2 y 3. ARCA simulado (XML real de WsfeClient) + reintento          */
/* ------------------------------------------------------------------ */

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-fiscal-importes-'));
const dbPath = join(tmpDir, 'stockflow.db');

const enviados: string[] = [];
const realFetch = globalThis.fetch;
let ultimoNumero = 200;
/** Comprobantes "en ARCA" por número: lo que FECompConsultar devuelve. */
const enArca = new Map<number, { total: string; fecha: string; docTipo: number; docNro: string }>();
/** Si está activo, la próxima FECAESolicitar autoriza en ARCA pero la respuesta "se pierde". */
let perderProximaRespuesta: { total: string } | null = null;
/** Si está activo, la próxima FECAESolicitar es RECHAZADA por ARCA (no consume numeración). */
let rechazarProxima = false;

function sobre(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

function tag(xml: string, t: string): string {
  return new RegExp(`<ar:${t}>([^<]*)</ar:${t}>`).exec(xml)?.[1] ?? '';
}

globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ?? '';
  enviados.push(body);
  if (body.includes('FECAESolicitar')) {
    if (rechazarProxima) {
      rechazarProxima = false;
      return {
        text: async () =>
          sobre(
            '<FECAESolicitarResponse><FECAESolicitarResult><FeCabResp><Resultado>R</Resultado></FeCabResp><Errors><Err><Code>10016</Code><Msg>El numero o fecha del comprobante no se corresponde con el proximo a autorizar.</Msg></Err></Errors></FECAESolicitarResult></FECAESolicitarResponse>',
          ),
      } as Response;
    }
    const numero = ++ultimoNumero;
    enArca.set(numero, {
      total: perderProximaRespuesta?.total ?? tag(body, 'ImpTotal'),
      fecha: tag(body, 'CbteFch'),
      docTipo: Number(tag(body, 'DocTipo')),
      docNro: tag(body, 'DocNro'),
    });
    if (perderProximaRespuesta) {
      perderProximaRespuesta = null;
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    return {
      text: async () =>
        sobre(
          `<FECAESolicitarResponse><FECAESolicitarResult><FeCabResp><Resultado>A</Resultado></FeCabResp><FeDetResp><FECAEDetResponse><CbteDesde>${numero}</CbteDesde><Resultado>A</Resultado><CAE>7500000000${String(numero).padStart(4, '0')}</CAE><CAEFchVto>20261231</CAEFchVto></FECAEDetResponse></FeDetResp></FECAESolicitarResult></FECAESolicitarResponse>`,
        ),
    } as Response;
  }
  if (body.includes('FECompConsultar')) {
    const numero = Number(tag(body, 'CbteNro'));
    const c = enArca.get(numero);
    if (!c) {
      return {
        text: async () =>
          sobre(
            '<FECompConsultarResponse><FECompConsultarResult><Errors><Err><Code>602</Code><Msg>No existen datos en nuestros registros para los parametros ingresados.</Msg></Err></Errors></FECompConsultarResult></FECompConsultarResponse>',
          ),
      } as Response;
    }
    return {
      text: async () =>
        sobre(
          `<FECompConsultarResponse><FECompConsultarResult><ResultGet><CbteDesde>${numero}</CbteDesde><CbteFch>${c.fecha}</CbteFch><ImpTotal>${c.total}</ImpTotal><DocTipo>${c.docTipo}</DocTipo><DocNro>${c.docNro}</DocNro><CodAutorizacion>7500000000${String(numero).padStart(4, '0')}</CodAutorizacion><FchVto>20261231</FchVto></ResultGet></FECompConsultarResult></FECompConsultarResponse>`,
        ),
    } as Response;
  }
  return {
    text: async () =>
      sobre(
        `<FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult><CbteNro>${ultimoNumero}</CbteNro></FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse>`,
      ),
  } as Response;
}) as unknown as typeof fetch;

const client = new WsfeClient('https://wswhomo.afip.gov.ar/wsfev1/service.asmx', {
  token: 'token-de-prueba',
  sign: 'firma-de-prueba',
  cuit: '20331225577',
});

const gateway = {
  lastAuthorized: (salePoint: number, voucherCode: number) => client.lastAuthorized(salePoint, voucherCode),
  requestCae: (req: Parameters<typeof client.requestCae>[0]) => client.requestCae(req),
  buildQrUrl: () => 'https://www.afip.gob.ar/fe/qr/?p=x',
  findVoucher: (salePoint: number, voucherCode: number, number: number) =>
    client.getVoucher(salePoint, voucherCode, number),
};

function ultimoPedidoCae(): string {
  return [...enviados].reverse().find((x) => x.includes('FECAESolicitar')) ?? '';
}
const pedidosDeCae = () => enviados.filter((x) => x.includes('FECAESolicitar')).length;
const consultas = () => enviados.filter((x) => x.includes('FECompConsultar')).length;
function ultimaConsulta(): string {
  return [...enviados].reverse().find((x) => x.includes('FECompConsultar')) ?? '';
}

/** Identidades sobre el XML que salió a ARCA. */
function verificarXml(label: string, xml: string): void {
  const neto = cents(tag(xml, 'ImpNeto'));
  const iva = cents(tag(xml, 'ImpIVA'));
  const total = cents(tag(xml, 'ImpTotal'));
  const bases = [...xml.matchAll(/<ar:BaseImp>([^<]*)<\/ar:BaseImp>/g)].map((m) => cents(m[1]!));
  const importes = [...xml.matchAll(/<ar:Importe>([^<]*)<\/ar:Importe>/g)].map((m) => cents(m[1]!));
  check(
    `${label}: ImpNeto + ImpIVA = ImpTotal`,
    neto + iva === total,
    `${neto / 100} + ${iva / 100} = ${total / 100}`,
  );
  check(
    `${label}: Σ BaseImp = ImpNeto y Σ Importe = ImpIVA`,
    bases.reduce((a, b) => a + b, 0) === neto && importes.reduce((a, b) => a + b, 0) === iva,
    `bases ${bases.map((b) => b / 100).join('+')} · importes ${importes.map((i) => i / 100).join('+')}`,
  );
}

async function main(): Promise<void> {
  console.log(`\nSmoke test FISCAL — importes y reintento — DB temporal: ${dbPath}\n`);

  grilla();

  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);
  const admin = await repos.users.findByUsername('admin');
  if (!admin) throw new Error('falta el usuario admin del seed');
  const { passwordHash: _omit, ...adminSafe } = admin;
  const ctx = createServiceContext(db, adminSafe);
  const services = createServices(ctx);

  repos.fiscal.saveConfig({
    environment: 'homologacion',
    cuit: '20331225577',
    vatCondition: 'RI',
    enabled: true,
  });
  await services.cash.openCashRegister('1000.0000');

  const art21 = await repos.articles.create({
    barcode: '7790000000021',
    description: 'Artículo al 21',
    listPrice1: '1210.0000',
    costPrice: '800.0000',
    vatRate: '21.00',
    stock: '500.000',
  });
  const art105 = await repos.articles.create({
    barcode: '7790000000105',
    description: 'Artículo al 10,5',
    listPrice1: '1.0000',
    costPrice: '0.5000',
    vatRate: '10.50',
    stock: '500.000',
  });
  const ri = await repos.customers.create({
    lastName: 'CLIENTE RI',
    category: 'RI',
    docType: 'CUIT',
    docNumber: '30111111118',
  });
  const cf = await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
  if (!cf) throw new Error('falta el CONSUMIDOR FINAL del seed');

  const service = new FiscalService(ctx, gateway);

  /* ---- 2. XML real: descuento global y dos alícuotas (y sus notas) ---- */
  console.log('\n[XML hacia ARCA: descuento global y dos alícuotas]');
  {
    const r = await services.sales.createSale({
      type: 'A',
      customerId: ri.id,
      discount: '110.0000',
      payments: [{ paymentMethodId: PM_CASH, amount: '1100.0000' }],
      lines: [{ articleId: art21.id, quantity: '1.000' }],
    });
    const v = await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
    const xml = ultimoPedidoCae();
    verificarXml('Factura A $1210 con descuento $110', xml);
    check(
      '… la base de la alícuota lleva el descuento prorrateado (909,09, no 1000)',
      tag(xml, 'BaseImp') === '909.09' && tag(xml, 'ImpNeto') === '909.09' && tag(xml, 'ImpTotal') === '1100.00',
      `BaseImp ${tag(xml, 'BaseImp')} ImpNeto ${tag(xml, 'ImpNeto')} ImpTotal ${tag(xml, 'ImpTotal')}`,
    );
    const guardado = repos.fiscal.vatDetailsFor(v.id);
    check(
      '… y lo persistido coincide con lo enviado',
      guardado.length === 1 && cents(guardado[0]!.baseAmount) === 90909 && cents(guardado[0]!.vatAmount) === 19091,
      guardado.map((g) => `${g.baseAmount}/${g.vatAmount}`).join(','),
    );
    await service.issueNote({ relatedVoucherId: v.id, kind: 'credit_note', total: '550.0000' });
    verificarXml('Nota de crédito parcial ($550) sobre esa factura', ultimoPedidoCae());
  }
  {
    const r = await services.sales.createSale({
      type: 'A',
      customerId: ri.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1211.0000' }],
      lines: [
        { articleId: art21.id, quantity: '1.000' },
        { articleId: art105.id, quantity: '1.000' },
      ],
    });
    const v = await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
    const xml = ultimoPedidoCae();
    verificarXml('Factura A $1210 @21 % + $1 @10,5 %', xml);
    check(
      '… con las dos alícuotas informadas',
      (xml.match(/<ar:AlicIva>/g) ?? []).length === 2 && xml.includes('<ar:Id>4</ar:Id>') && xml.includes('<ar:Id>5</ar:Id>'),
    );
    await service.issueNote({ relatedVoucherId: v.id, kind: 'credit_note' });
    verificarXml('Nota de crédito total sobre la de dos alícuotas', ultimoPedidoCae());
  }

  /* ---- 3. Reintento: respuesta perdida después de que ARCA autorizó ---- */
  console.log('\n[reintento con FECompConsultar: respuesta perdida]');
  {
    const r = await services.sales.createSale({
      type: 'B',
      customerId: cf.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
      lines: [{ articleId: art21.id, quantity: '1.000' }],
    });
    perderProximaRespuesta = { total: '1210.00' };
    try {
      await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
      check('primer intento: ARCA autoriza pero la respuesta se pierde → error', false, 'no lanzó');
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : String(e);
      check('primer intento: ARCA autoriza pero la respuesta se pierde → error de timeout', /30 segundos/.test(mensaje), mensaje);
    }
    const numeroEnArca = ultimoNumero;
    const intentos = repos.fiscal.findFailuresBySale(r.sale.id);
    check(
      '… el intento quedó registrado como SIN RESPUESTA, con el número que pidió',
      intentos.length === 1 && intentos[0]!.status === 'error' && intentos[0]!.requestedNumber === numeroEnArca,
      `status ${intentos[0]?.status} · pedido ${intentos[0]?.requestedNumber} (ARCA ${numeroEnArca})`,
    );
    check('… y sin comprobante aprobado local', repos.fiscal.findVoucherBySale(r.sale.id) === null);

    const pedidosAntes = pedidosDeCae();
    const consultasAntes = consultas();
    const v = await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
    check(
      'reintento: consulta FECompConsultar por ESE número antes de emitir',
      consultas() === consultasAntes + 1 && tag(ultimaConsulta(), 'CbteNro') === String(numeroEnArca),
      `CbteNro ${tag(ultimaConsulta(), 'CbteNro')}`,
    );
    check(
      '… ADOPTA el comprobante que ARCA ya autorizó (mismo número, sin FECAESolicitar nuevo)',
      v.number === numeroEnArca && pedidosDeCae() === pedidosAntes,
      `número ${v.number} (ARCA ${numeroEnArca}) · pedidos ${pedidosAntes} → ${pedidosDeCae()}`,
    );
    check('… con el CAE de ARCA', v.cae === `7500000000${String(numeroEnArca).padStart(4, '0')}`, v.cae);
    const guardado = repos.fiscal.findVoucherBySale(r.sale.id);
    check('… y queda persistido como aprobado', guardado?.status === 'approved' && guardado.number === numeroEnArca);
  }

  /* ---- 3b. El comprobante de ARCA no coincide: NO se adopta ---- */
  console.log('\n[reintento con FECompConsultar: el comprobante de ARCA es de otro importe]');
  {
    const r = await services.sales.createSale({
      type: 'B',
      customerId: cf.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
      lines: [{ articleId: art21.id, quantity: '1.000' }],
    });
    // ARCA autorizó "algo" con ese número, pero por $999: no es esta venta.
    perderProximaRespuesta = { total: '999.00' };
    try {
      await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
    } catch {
      /* esperado */
    }
    const numeroAjeno = ultimoNumero;
    check(
      'el segundo intento sin respuesta del mismo tipo también queda registrado (antes chocaba en el índice único)',
      repos.fiscal.findFailuresBySale(r.sale.id).length === 1,
    );
    const pedidosAntes = pedidosDeCae();
    const v = await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
    check(
      'reintento: el comprobante de ARCA no coincide → emite el número siguiente',
      v.number === numeroAjeno + 1 && pedidosDeCae() === pedidosAntes + 1,
      `número ${v.number} (ajeno ${numeroAjeno}) · pedidos ${pedidosAntes} → ${pedidosDeCae()}`,
    );
    check(
      '… y el XML pide exactamente ese número',
      tag(ultimoPedidoCae(), 'CbteDesde') === String(numeroAjeno + 1),
      `CbteDesde ${tag(ultimoPedidoCae(), 'CbteDesde')}`,
    );
  }

  /* ---- 3c. Otra venta facturada entre el corte y el reintento ---- */
  console.log('\n[reintento con FECompConsultar: otra venta facturada entre medio]');
  {
    const perdida = await services.sales.createSale({
      type: 'B',
      customerId: cf.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
      lines: [{ articleId: art21.id, quantity: '1.000' }],
    });
    perderProximaRespuesta = { total: '1210.00' };
    try {
      await service.issueInvoiceForSale({ saleId: perdida.sale.id, salePoint: 1 });
    } catch {
      /* esperado: timeout */
    }
    const numeroPerdido = ultimoNumero;
    // Otra terminal (o el mismo cajero, que sigue vendiendo) factura otra venta
    // del MISMO importe antes del reintento: el último autorizado ya no es el
    // nuestro.
    const otra = await services.sales.createSale({
      type: 'B',
      customerId: cf.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
      lines: [{ articleId: art21.id, quantity: '1.000' }],
    });
    const vOtra = await service.issueInvoiceForSale({ saleId: otra.sale.id, salePoint: 1 });
    check('otra venta facturada entre medio toma el número siguiente', vOtra.number === numeroPerdido + 1, `número ${vOtra.number}`);

    const pedidosAntes = pedidosDeCae();
    const consultasAntes = consultas();
    const v = await service.issueInvoiceForSale({ saleId: perdida.sale.id, salePoint: 1 });
    check(
      'reintento de la perdida: consulta el número que PIDIÓ, no el último autorizado',
      consultas() === consultasAntes + 1 && tag(ultimaConsulta(), 'CbteNro') === String(numeroPerdido),
      `CbteNro ${tag(ultimaConsulta(), 'CbteNro')} (pedido ${numeroPerdido}, último ${ultimoNumero})`,
    );
    check(
      '… ADOPTA su comprobante sin emitir otro (antes emitía N+2 y el N quedaba huérfano)',
      v.number === numeroPerdido && pedidosDeCae() === pedidosAntes,
      `número ${v.number} · pedidos ${pedidosAntes} → ${pedidosDeCae()}`,
    );
    check(
      '… y cada venta queda con su comprobante',
      repos.fiscal.findVoucherBySale(perdida.sale.id)?.number === numeroPerdido &&
        repos.fiscal.findVoucherBySale(otra.sale.id)?.number === numeroPerdido + 1,
    );
  }

  /* ---- 3d. Rechazo explícito de ARCA: no hay nada que adoptar ---- */
  console.log('\n[reintento tras un RECHAZO de ARCA: no consulta ni adopta]');
  {
    const r = await services.sales.createSale({
      type: 'B',
      customerId: cf.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
      lines: [{ articleId: art21.id, quantity: '1.000' }],
    });
    rechazarProxima = true;
    let msg = '';
    try {
      await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    const intento = repos.fiscal.findFailuresBySale(r.sale.id)[0];
    check(
      'ARCA rechaza (10016) → queda como RECHAZADO, no como respuesta perdida',
      /10016/.test(msg) && intento?.status === 'rejected' && intento.requestedNumber === ultimoNumero + 1,
      `status ${intento?.status} · pedido ${intento?.requestedNumber}`,
    );
    // Base migrada: en ese mismo número ARCA tiene un comprobante que esta base
    // no conoce (lo emitió el sistema anterior), del MISMO importe, a consumidor
    // final y de hoy. Con la adopción disparada por cualquier rechazo se lo
    // quedaba, y la venta nunca se facturaba de verdad.
    const numeroAjeno = ++ultimoNumero;
    enArca.set(numeroAjeno, { total: '1210.00', fecha: fechaArcaLocal(Date.now()), docTipo: 99, docNro: '0' });

    const pedidosAntes = pedidosDeCae();
    const consultasAntes = consultas();
    const v = await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1 });
    check('reintento tras rechazo: NO consulta FECompConsultar', consultas() === consultasAntes);
    check(
      '… y emite un comprobante nuevo en vez de adoptar el ajeno idéntico',
      v.number === numeroAjeno + 1 && pedidosDeCae() === pedidosAntes + 1,
      `número ${v.number} (ajeno ${numeroAjeno}) · pedidos ${pedidosAntes} → ${pedidosDeCae()}`,
    );
  }

  /* ---- Letra que el emisor no puede emitir ---- */
  console.log('\n[letra según el emisor]');
  {
    const r = await services.sales.createSale({
      type: 'C',
      customerId: cf.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
      lines: [{ articleId: art21.id, quantity: '1.000' }],
    });
    const antes = pedidosDeCae();
    let msg = '';
    try {
      await service.issueInvoiceForSale({ saleId: r.sale.id, salePoint: 1, letter: 'C' });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check('emisor RI que fuerza Factura C → se frena sin pedir el CAE', /Responsable Inscripto/.test(msg) && pedidosDeCae() === antes, msg);
  }

  closeLocalDb(db);
  globalThis.fetch = realFetch;
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(failures === 0 ? '\n✅ TODO OK\n' : `\n❌ ${failures} FALLAS\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('\n💥 el smoke reventó:', err);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
});
