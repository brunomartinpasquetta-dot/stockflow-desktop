/**
 * QR de Mercado Pago de punta a punta contra un Mercado Pago SIMULADO (servidor
 * HTTP local que imita los endpoints reales): generar el punto de cobro, cobrar
 * en la caja de hoy, cerrar, abrir la de mañana y volver a cobrar. Lo que se
 * verifica es a qué punto de cobro llega cada orden en el simulador: tiene que
 * ser SIEMPRE el primero (el cartel impreso), aunque haya quedado un segundo
 * punto de cobro creado por error (lo que pasó en Denver, 11-oct-2026).
 *   pnpm --filter @stockflow/desktop test:mp-qr-flujo
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { closeLocalDb, createRepositories, initLocalDb, mpConfig, mpPosDevices } from '@stockflow/db';
import { CashService, MpQrService, type ServiceContext } from '@stockflow/core';

const dir = mkdtempSync(join(tmpdir(), 'stockflow-mp-qr-flujo-'));
let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

// ── Mercado Pago simulado ────────────────────────────────────────────────────
interface Pos { id: string; external_id: string; store_id: string; config: { qr: { operating_mode: string } } }
const puntosDeCobro: Pos[] = [];
const ordenes: { user: string; ext: string; body: Record<string, unknown> }[] = [];
const borradas: { user: string; ext: string }[] = [];
const pagadas = new Set<string>();
let altasDePos = 0;
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function leerCuerpo(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => ok(s));
  });
}

let base = '';
const servidor = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const cuerpo = req.method === 'PUT' || req.method === 'POST' ? JSON.parse((await leerCuerpo(req)) || '{}') : {};
  let m: RegExpMatchArray | null;
  if (req.method === 'GET' && p === '/users/me') return json(200, { id: 25734945, nickname: 'FABRI_277' });
  if (req.method === 'GET' && p === '/pos') return json(200, { results: puntosDeCobro });
  if (req.method === 'POST' && p === '/v2/pos') {
    altasDePos++;
    const pos: Pos = { id: `pos-${altasDePos}`, external_id: String(cuerpo.external_id), store_id: String(cuerpo.store_id), config: { qr: { operating_mode: 'pdv' } } };
    puntosDeCobro.push(pos);
    return json(201, pos);
  }
  if ((m = p.match(/^\/instore\/qr\/seller\/collectors\/(\w+)\/pos\/(\w+)\/qrs$/)) && req.method === 'GET') {
    return json(200, { qr_template_image: `${base}/qr/${m[2]}.png` });
  }
  if ((m = p.match(/^\/qr\/(\w+)\.png$/))) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(PNG_1x1);
  }
  if ((m = p.match(/^\/instore\/orders\/qr\/seller\/collectors\/(\w+)\/pos\/(\w+)\/qrs$/))) {
    if (req.method === 'PUT') {
      ordenes.push({ user: m[1], ext: m[2], body: cuerpo });
      return json(201, {});
    }
    if (req.method === 'DELETE') {
      borradas.push({ user: m[1], ext: m[2] });
      return json(200, {});
    }
  }
  if (req.method === 'GET' && p === '/v1/payments/search') {
    const ref = url.searchParams.get('external_reference') ?? '';
    return json(200, { results: pagadas.has(ref) ? [{ id: 777, status: 'approved', external_reference: ref }] : [] });
  }
  return json(404, { message: 'Si quieres conocer los recursos de la API visita el sitio de desarrolladores' });
});

async function main(): Promise<void> {
  await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;

  const { db } = initLocalDb(join(dir, 'stockflow.db'));
  const repos = createRepositories(db);
  const admin = await repos.users.findByUsername('admin');
  if (!admin) throw new Error('falta el usuario admin del seed');
  const ctx = { db, repos, currentUser: admin } as unknown as ServiceContext;
  const cash = new CashService(ctx);
  const mp = new MpQrService(ctx, { encrypt: (s: string) => s, decrypt: (s: string) => s } as never, base);

  const ahora = Date.now();
  db.insert(mpConfig)
    .values({ id: 'cfg-1', companyId: null, mpUserId: '25734945', accessTokenEncrypted: 'APP_USR-simulado', webhookSecret: 'x', storeId: 'store-1', webhookUrlConfigured: 0, createdAt: ahora, updatedAt: ahora } as never)
    .run();

  // ── Día 1: vincular (se crea UN punto de cobro en MP) y cobrar ────────────
  const cajaA = await cash.openCashRegister('1000.0000');
  const cartel = await mp.createPosDevice({ cashRegisterId: cajaA.id });
  check(altasDePos === 1, 'día 1: «Generar QR» crea UN punto de cobro en Mercado Pago');
  check(/^[A-Za-z0-9]+$/.test(cartel.externalPosId), 'la identificación externa es sólo letras y números (sin guiones)', cartel.externalPosId);
  check(puntosDeCobro[0]?.config.qr.operating_mode === 'pdv', 'el punto de cobro queda en modo ATENDIDO (el importe viaja al escanear)');
  check(!!cartel.qrImageBase64, 'el cartel (imagen del QR) quedó guardado para imprimir');

  const orden1 = await mp.createOrder({ cashRegisterId: cajaA.id, amount: '1500', description: 'Venta de prueba 1' });
  check(ordenes.length === 1 && ordenes[0].ext === cartel.externalPosId, 'día 1: la orden llega al punto de cobro del cartel');
  check(ordenes[0]?.body.total_amount === 1500, 'con el importe de la venta (1500)', JSON.stringify(ordenes[0]?.body.total_amount));
  check(ordenes[0]?.user === '25734945', 'y al usuario de la cuenta de cobro');

  pagadas.add(orden1.externalReference);
  const verificada = await mp.verifyPayment(orden1.id);
  check(verificada.status === 'approved', 'al pagar el cliente, el sistema lo detecta (approved)');

  // ── Cierre del día y apertura del siguiente ────────────────────────────────
  await cash.closeCashRegister(cajaA.id, '2500.0000');
  const cajaB = await cash.openCashRegister('1000.0000');

  const generarB = await mp.createPosDevice({ cashRegisterId: cajaB.id });
  check(generarB.id === cartel.id && altasDePos === 1, 'día 2: «Generar QR» NO crea otro punto de cobro en Mercado Pago (sigue habiendo uno)');
  const orden2 = await mp.createOrder({ cashRegisterId: cajaB.id, amount: '2300', description: 'Venta de prueba 2' });
  check(ordenes.length === 2 && ordenes[1].ext === cartel.externalPosId, 'día 2: la orden llega al MISMO cartel impreso', JSON.stringify(ordenes[1]));
  check(orden2.mpPosDeviceId === cartel.id, 'día 2: la orden queda registrada sobre el punto de cobro original');
  const activa = await mp.getActiveOrder(cajaB.id);
  check(activa?.id === orden2.id, 'día 2: Ventas encuentra la orden en curso de la caja nueva');
  await mp.cancelOrder(orden2.id);
  check(borradas.length === 1 && borradas[0].ext === cartel.externalPosId, 'cancelar borra la orden en el cartel correcto');

  // ── Lo de Denver: quedó un segundo punto de cobro creado por error ────────
  db.insert(mpPosDevices)
    .values({ id: 'dev-sobrante', cashRegisterId: cajaB.id, externalPosId: 'CAJASOBRANTE1', mpPosId: 'pos-sobrante', qrUrl: `${base}/qr/CAJASOBRANTE1.png`, qrImageBase64: null, active: 1, createdAt: ahora + 60_000, updatedAt: ahora + 60_000 } as never)
    .run();
  await mp.createOrder({ cashRegisterId: cajaB.id, amount: '999', description: 'Venta de prueba 3' });
  check(ordenes[2]?.ext === cartel.externalPosId, 'con un punto de cobro de más, la orden sigue yendo al cartel ORIGINAL', JSON.stringify(ordenes[2]));

  // ── Día 3 ──────────────────────────────────────────────────────────────────
  await cash.closeCashRegister(cajaB.id, '1000.0000');
  const cajaC = await cash.openCashRegister('1000.0000');
  await mp.createOrder({ cashRegisterId: cajaC.id, amount: '400', description: 'Venta de prueba 4' });
  check(ordenes[3]?.ext === cartel.externalPosId && altasDePos === 1, 'día 3: mismo cartel, ningún punto de cobro nuevo');

  closeLocalDb(db);
}

main()
  .catch((e) => {
    fallas++;
    console.error('❌ excepción:', e);
  })
  .finally(() => {
    servidor.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
    process.exit(fallas ? 1 : 0);
  });
