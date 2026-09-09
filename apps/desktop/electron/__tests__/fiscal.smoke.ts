/**
 * Smoke test de FACTURACIÓN ELECTRÓNICA — RG 5616 (condición frente al IVA del
 * receptor). Corre con:
 *   pnpm --filter @stockflow/desktop test:fiscal
 *
 * Qué verifica:
 *  1. El XML que se le manda a ARCA lleva <CondicionIVAReceptorId> con el
 *     código correcto y en la POSICIÓN que exige el esquema (después de
 *     MonCotiz, antes de CbtesAsoc/Iva). Se comprueba interceptando el `fetch`
 *     de `WsfeClient`: es el XML real que saldría a la red.
 *  2. Una factura por cada condición — Responsable Inscripto (1), Exento (4),
 *     Consumidor Final (5) y Monotributo (6). Consumidor final NO está exento
 *     de informarla.
 *  3. La letra que corresponde a cada cliente (RG 5616: al monotributista se le
 *     emite Factura A, no B).
 *  4. Las combinaciones que ARCA rechaza (error 10243) se frenan ANTES de pedir
 *     el CAE, para no quemar numeración.
 *  5. La condición queda guardada en el comprobante y la nota de crédito la
 *     repite (incluso sobre comprobantes viejos que no la tienen guardada).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { FiscalService, ValidationError, createServiceContext, createServices } from '@stockflow/core';
import {
  RECEIVER_VAT_CONDITION_IDS,
  resolveVoucherLetter,
  validateForLetter,
} from '@stockflow/shared';

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

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-fiscal-smoke-'));
const dbPath = join(tmpDir, 'stockflow.db');

/* ------------------------------------------------------------------ */
/* ARCA simulado: guarda el XML recibido y responde un CAE válido.     */
/* ------------------------------------------------------------------ */

const enviados: string[] = [];
const realFetch = globalThis.fetch;
let ultimoNumero = 100;

function respuestaCae(numero: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body><FECAESolicitarResponse><FECAESolicitarResult>
  <FeCabResp><Resultado>A</Resultado></FeCabResp>
  <FeDetResp><FECAEDetResponse>
    <CbteDesde>${numero}</CbteDesde><Resultado>A</Resultado>
    <CAE>75000000000001</CAE><CAEFchVto>20261231</CAEFchVto>
  </FECAEDetResponse></FeDetResp>
 </FECAESolicitarResult></FECAESolicitarResponse></soap:Body></soap:Envelope>`;
}

function respuestaUltimo(numero: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
 <soap:Body><FECompUltimoAutorizadoResponse><FECompUltimoAutorizadoResult>
  <CbteNro>${numero}</CbteNro>
 </FECompUltimoAutorizadoResult></FECompUltimoAutorizadoResponse></soap:Body></soap:Envelope>`;
}

globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ?? '';
  enviados.push(body);
  const xml = body.includes('FECAESolicitar')
    ? respuestaCae(++ultimoNumero)
    : respuestaUltimo(ultimoNumero);
  return { text: async () => xml } as Response;
}) as unknown as typeof fetch;

/* WsfeClient real (es quien arma el XML), sin pasar por WSAA. */
const client = new WsfeClient('https://wswhomo.afip.gov.ar/wsfev1/service.asmx', {
  token: 'token-de-prueba',
  sign: 'firma-de-prueba',
  cuit: '20331225577',
});

const gateway = {
  lastAuthorized: (salePoint: number, voucherCode: number) =>
    client.lastAuthorized(salePoint, voucherCode),
  requestCae: (req: Parameters<typeof client.requestCae>[0]) => client.requestCae(req),
  buildQrUrl: () => 'https://www.afip.gob.ar/fe/qr/?p=x',
};

/** Último XML de solicitud de CAE que se mandó. */
function ultimoPedidoCae(): string {
  return [...enviados].reverse().find((x) => x.includes('FECAESolicitar')) ?? '';
}

function condicionEnviada(xml: string): number | null {
  const m = /<ar:CondicionIVAReceptorId>(\d+)<\/ar:CondicionIVAReceptorId>/.exec(xml);
  return m?.[1] ? Number(m[1]) : null;
}

function pedidosDeCae(): number {
  return enviados.filter((x) => x.includes('FECAESolicitar')).length;
}

async function main(): Promise<void> {
  console.log(`\nSmoke test FISCAL (RG 5616) — DB temporal: ${dbPath}\n`);

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

  const articulo = await repos.articles.create({
    barcode: '7790000012345',
    description: 'Artículo de prueba',
    listPrice1: '1210.0000',
    costPrice: '800.0000',
    vatRate: '21.00',
    stock: '500.000',
  });

  const service = new FiscalService(ctx, gateway);

  async function venderA(customerId: string, tipo: 'A' | 'B' | 'C'): Promise<string> {
    const r = await services.sales.createSale({
      type: tipo,
      customerId,
      payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
      lines: [{ articleId: articulo.id, quantity: '1.000' }],
    });
    return r.sale.id;
  }

  /* --------- Una factura por cada condición frente al IVA --------- */
  console.log('[condición IVA del receptor en el XML que va a ARCA]');

  const casos = [
    { categoria: 'RI' as const, docType: 'CUIT' as const, doc: '30111111118', letra: 'A' as const, codigo: 1, nombre: 'Responsable Inscripto' },
    { categoria: 'MT' as const, docType: 'CUIT' as const, doc: '27222222228', letra: 'A' as const, codigo: 6, nombre: 'Monotributo' },
    { categoria: 'CF' as const, docType: 'DNI' as const, doc: '33122557', letra: 'B' as const, codigo: 5, nombre: 'Consumidor Final' },
    { categoria: 'EX' as const, docType: 'CUIT' as const, doc: '30333333339', letra: 'B' as const, codigo: 4, nombre: 'Exento' },
  ];

  const emitidos: { caso: (typeof casos)[number]; voucherId: string; customerId: string }[] = [];

  for (const caso of casos) {
    const cliente = await repos.customers.create({
      lastName: `CLIENTE ${caso.nombre.toUpperCase()}`,
      category: caso.categoria,
      docType: caso.docType,
      docNumber: caso.doc,
    });

    const letra = resolveVoucherLetter('RI', caso.categoria);
    check(`${caso.nombre} → Factura ${caso.letra}`, letra === caso.letra, `deducida: ${letra}`);

    const saleId = await venderA(cliente.id, letra);
    const v = await service.issueInvoiceForSale({ saleId, salePoint: 1 });
    emitidos.push({ caso, voucherId: v.id, customerId: cliente.id });

    const xml = ultimoPedidoCae();
    check(
      `${caso.nombre}: el pedido lleva CondicionIVAReceptorId = ${caso.codigo}`,
      condicionEnviada(xml) === caso.codigo,
      `enviado: ${condicionEnviada(xml)}`,
    );

    // El esquema de ARCA es posicional.
    const posCond = xml.indexOf('<ar:CondicionIVAReceptorId>');
    const posMonCotiz = xml.indexOf('<ar:MonCotiz>');
    const posIva = xml.indexOf('<ar:Iva>');
    check(
      `${caso.nombre}: el campo va después de MonCotiz y antes de Iva`,
      posCond > posMonCotiz && (posIva === -1 || posCond < posIva),
      `MonCotiz@${posMonCotiz} Cond@${posCond} Iva@${posIva}`,
    );

    const guardado = repos.fiscal.findVoucherById(v.id);
    check(
      `${caso.nombre}: la condición queda guardada en el comprobante`,
      guardado?.customerVatConditionId === caso.codigo,
      `guardado: ${guardado?.customerVatConditionId}`,
    );
  }

  /* ---------------- Consumidor final NO está exento ----------------- */
  console.log('\n[consumidor final del mostrador]');
  const cfSeed = await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
  if (cfSeed) {
    const saleId = await venderA(cfSeed.id, 'B');
    await service.issueInvoiceForSale({ saleId, salePoint: 1 });
    const xml = ultimoPedidoCae();
    check(
      'venta a CONSUMIDOR FINAL sin datos: informa el código 5 igual',
      condicionEnviada(xml) === RECEIVER_VAT_CONDITION_IDS.CF,
      `enviado: ${condicionEnviada(xml)}`,
    );
    check(
      '… y el receptor va sin identificar (DocTipo 99, DocNro 0), como antes',
      xml.includes('<ar:DocTipo>99</ar:DocTipo>') && xml.includes('<ar:DocNro>0</ar:DocNro>'),
    );
  } else {
    check('existe el cliente CONSUMIDOR FINAL del seed', false);
  }

  /* ------------- Combinaciones que ARCA rechaza (10243) -------------- */
  console.log('\n[validaciones locales: no se pide CAE si ARCA lo va a rechazar]');
  const cuit = { docType: 80, docNumber: '27222222228' };
  const bAMonotributo = validateForLetter('B', cuit, RECEIVER_VAT_CONDITION_IDS.MT);
  check(
    'Factura B a un Monotributista se frena antes de ARCA',
    !bAMonotributo.ok,
    bAMonotributo.ok ? '' : bAMonotributo.reason,
  );
  const aAConsumidorFinal = validateForLetter('A', cuit, RECEIVER_VAT_CONDITION_IDS.CF);
  check(
    'Factura A a un Consumidor Final se frena antes de ARCA',
    !aAConsumidorFinal.ok,
    aAConsumidorFinal.ok ? '' : aAConsumidorFinal.reason,
  );
  check(
    'Factura A a un Responsable Inscripto es válida',
    validateForLetter('A', cuit, RECEIVER_VAT_CONDITION_IDS.RI).ok,
  );
  check(
    'Factura A a un Monotributista es válida (RG 5616)',
    validateForLetter('A', cuit, RECEIVER_VAT_CONDITION_IDS.MT).ok,
  );

  // Forzar a mano una letra incompatible tiene que fallar SIN pedir el CAE.
  const clienteMT = emitidos.find((e) => e.caso.categoria === 'MT');
  if (clienteMT) {
    const saleId = await venderA(clienteMT.customerId, 'B');
    const antes = pedidosDeCae();
    try {
      await service.issueInvoiceForSale({ saleId, salePoint: 1, letter: 'B' });
      check('forzar Factura B a un Monotributista → error', false, 'no lanzó');
    } catch (e) {
      check(
        'forzar Factura B a un Monotributista → error claro',
        e instanceof ValidationError,
        e instanceof Error ? e.message : String(e),
      );
    }
    check(
      '… y NO se llegó a pedir el CAE (no se quema numeración)',
      pedidosDeCae() === antes,
      `pedidos: ${antes} → ${pedidosDeCae()}`,
    );
  }

  /* ---------------- La nota de crédito repite la condición ----------- */
  console.log('\n[notas de crédito]');
  const primero = emitidos[0];
  if (primero) {
    const nota = await service.issueNote({
      relatedVoucherId: primero.voucherId,
      kind: 'credit_note',
    });
    check(
      'la nota de crédito repite la condición del comprobante que ajusta',
      condicionEnviada(ultimoPedidoCae()) === primero.caso.codigo,
      `enviado: ${condicionEnviada(ultimoPedidoCae())} (esperado ${primero.caso.codigo})`,
    );
    const guardada = repos.fiscal.findVoucherById(nota.id);
    check(
      '… y la guarda en la nota',
      guardada?.customerVatConditionId === primero.caso.codigo,
      `guardado: ${guardada?.customerVatConditionId}`,
    );
  }

  /* ---- Comprobante viejo (sin condición guardada) se puede ajustar --- */
  const viejo = emitidos[1];
  if (viejo) {
    // Simula un comprobante emitido antes de esta versión.
    db.$client
      .prepare('UPDATE fiscal_vouchers SET customer_vat_condition_id = NULL WHERE id = ?')
      .run(viejo.voucherId);
    const nota = await service.issueNote({ relatedVoucherId: viejo.voucherId, kind: 'credit_note' });
    check(
      'nota sobre un comprobante viejo (sin condición guardada): la deduce del cliente',
      condicionEnviada(ultimoPedidoCae()) === viejo.caso.codigo,
      `enviado: ${condicionEnviada(ultimoPedidoCae())} (esperado ${viejo.caso.codigo})`,
    );
    check('… y la nota sale con CAE', nota.cae.length > 0, nota.cae);
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
