/**
 * CAJA POR PC (ítem 12 del plan multisucursal), de punta a punta.
 *
 *   pnpm --filter @stockflow/desktop test:caja-terminal
 *
 * Levanta un LanServer de verdad con los handlers reales sobre una base
 * temporal y le pega por HTTP como lo hacen las terminales, cada una con su
 * encabezado `x-stockflow-terminal`. Cubre:
 *
 *   [1] Base "de antes de actualizar": la caja abierta con el id del servidor
 *       (como la abría la versión anterior para TODAS las PC) pasa a caja
 *       compartida al migrar; las cerradas no se tocan.
 *   [2] Transición: con esa caja abierta, el servidor, dos terminales nuevas y
 *       una terminal vieja (sin encabezado) siguen vendiendo en ella. Nadie
 *       queda sin poder vender a mitad de turno.
 *   [3] Después de cerrarla: cada PC abre y arquea su propia caja; la venta de
 *       cada una cae en la suya.
 *   [4] Anular con la caja original cerrada: el efectivo sale del cajón de la
 *       PC que anula, no del de otra.
 *   [5] Movimiento manual y Flowy ("cuánto hay en caja") miran la caja de la
 *       PC que pregunta.
 *   [6] Ventas y compras sin duplicar (ítem 13): la misma clave de intento
 *       dos veces (también a la vez, y con la caja ya cerrada) = una sola
 *       venta y la misma respuesta. La clave de la pantalla se reusa sólo
 *       mientras el carrito no cambie.
 *   [7] Punto de venta recordado por PC (ítem 15): cada PC arranca con el
 *       último PV que usó; con uno solo activo, nada cambia.
 *   [8] La caja por PC es una OPCIÓN (revisión de la etapa 1): apagada, todo
 *       como en la 1.12 (una caja del local para todas las PC, también por el
 *       túnel); prendida, el dueño desde su casa usa la caja del servidor;
 *       prender/apagar no deja a nadie sin caja.
 *
 * [2]–[6] corren con la opción PRENDIDA (`lan:setCajaPorPc`).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { BackupService } from '../backup/BackupService';
import { HardwareManager } from '../hardware/HardwareManager';
import { ExcelImportService } from '../import/ExcelImportService';
import { LicenseManager } from '../license/LicenseManager';
import { buildAllHandlers } from '../ipc/index';
import { SessionStore } from '../ipc/session-store';
import type { IpcResponse } from '../ipc/types';
import { LanManager } from '../lan/LanManager';
import { LanServer } from '../lan/LanServer';
import { IntentoDeOperacion, nuevaClaveIdempotencia } from '../../src/lib/idempotencia';
import { elegirPuntoDeVenta, guardarPuntoDeVentaPC, leerPuntoDeVentaPC } from '../../src/lib/puntoDeVentaPC';

let fallas = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    fallas++;
  }
}

process.env.NODE_ENV = 'test';
process.env.STOCKFLOW_SESSION_SECRET = 'caja-terminal-secret';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MIGR = join(AQUI, '..', '..', '..', '..', 'packages/db/migrations/local');

const ID_SERVIDOR = 'e5'.repeat(32);
const ID_A = 'a1'.repeat(32);
const ID_B = 'b2'.repeat(32);
const PIN = '246810';
const PORT = 47791;
const URL_RPC = `http://127.0.0.1:${PORT}/lan/rpc`;
const PORT_TUNEL = 47792;
const URL_TUNEL = `http://127.0.0.1:${PORT_TUNEL}/lan/rpc`;
const PM_CASH = 'pm-efectivo';

const tmp = mkdtempSync(join(tmpdir(), 'caja-terminal-'));
const dbPath = join(tmp, 'stockflow.db');

interface Terminal {
  id: string | null;
  nombre: string;
}
const TA: Terminal = { id: ID_A, nombre: 'Caja A — Mostrador' };
const TB: Terminal = { id: ID_B, nombre: 'Caja B — Depósito' };
const VIEJA: Terminal = { id: null, nombre: '' };

async function main(): Promise<void> {
  /* ------------------------------------------------------------------ */
  console.log('\n[1] Base de antes de actualizar: la caja abierta pasa a compartida');
  // Migraciones hasta la 0041 = la versión anterior.
  const viejas = join(tmp, 'migr-viejas');
  mkdirSync(viejas, { recursive: true });
  cpSync(MIGR, viejas, { recursive: true });
  const jPath = join(viejas, 'meta/_journal.json');
  const j = JSON.parse(readFileSync(jPath, 'utf8')) as { entries: { tag: string }[] };
  j.entries = j.entries.filter((e) => e.tag < '0042');
  writeFileSync(jPath, JSON.stringify(j, null, 2));
  {
    const { db } = initLocalDb(dbPath, { migrationsFolder: viejas });
    const r = createRepositories(db);
    const admin = (await r.users.findByUsername('admin'))!;
    // Como lo hacía la versión anterior: toda PC abría con el id del SERVIDOR.
    const cerrada = await r.cashRegisters.openRegister({ openingAmount: '0.0000', userId: admin.id, terminalId: ID_SERVIDOR, terminalName: 'SERVIDOR' });
    await r.cashRegisters.closeRegister(cerrada.id, { closingAmount: '0.0000' });
    await r.cashRegisters.openRegister({ openingAmount: '1000.0000', userId: admin.id, terminalId: ID_SERVIDOR, terminalName: 'SERVIDOR' });
    closeLocalDb(db);
  }
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);
  const cajas0 = db.$client.prepare('SELECT id, status, terminal_id, terminal_name FROM cash_registers ORDER BY number').all() as {
    id: string; status: string; terminal_id: string | null; terminal_name: string | null;
  }[];
  const compartida = cajas0.find((c) => c.status === 'open')!;
  check('la caja abierta quedó compartida (terminal_id NULL)', compartida.terminal_id === null, JSON.stringify(cajas0));
  check('conserva el nombre de la PC que la abrió', compartida.terminal_name === 'SERVIDOR');
  check('la caja cerrada conserva su terminal', cajas0.find((c) => c.status === 'closed')?.terminal_id === ID_SERVIDOR);

  /* ------------------------------------------------------------------ */
  const sessionStore = new SessionStore();
  const hardware = new HardwareManager({ userDataDir: tmp });
  // Sin backup automático al cerrar caja: es fire-and-forget y chocaría con el
  // borrado de la carpeta temporal al terminar.
  hardware.setBackupConfig({ destination: join(tmp, 'backups'), autoOnCashClose: false, autoOnAppQuit: false });
  const licenseManager = new LicenseManager({ userDataDir: tmp, machineId: ID_SERVIDOR, apiUrl: 'http://localhost:1', publicKeyPem: '' });
  const handlers = buildAllHandlers({
    db,
    repos,
    sessionStore,
    machineId: ID_SERVIDOR,
    appVersion: '0.0.0-test',
    dbPath,
    userDataDir: tmp,
    licenseManager,
    hardware,
    backup: new BackupService({ dbPath, backupDir: tmp, appVersion: '0.0.0-test' }),
    importService: new ExcelImportService(),
    emit: () => {},
  });
  const server = new LanServer({
    handlers,
    port: PORT,
    tunnelPort: PORT_TUNEL,
    token: PIN,
    jwtSecret: 'secreto-caja-terminal',
    machineId: ID_SERVIDOR,
    sessionStore,
    resolveUser: async (id: string) => {
      const u = await repos.users.findById(id);
      if (!u) return null;
      const { passwordHash: _p, ...safe } = u;
      void _p;
      return safe as never;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await server.start();

  // IPC local = la PC servidor.
  const local = async <T>(channel: string, payload?: unknown): Promise<IpcResponse<T>> =>
    (await handlers[channel]!(payload)) as IpcResponse<T>;
  await local('auth:login', { username: 'admin', password: 'admin36724776' });
  // Esta PC es el servidor de la red del local.
  new LanManager(tmp).setConfig({ mode: 'server', port: PORT, token: PIN });
  const cfg0 = await local<{ cajaPorPc?: boolean; cajaPorPcForzada?: boolean }>('lan:getConfig');
  check('por defecto (licencia común) la caja por PC está APAGADA', cfg0.ok && cfg0.data.cajaPorPc === false && cfg0.data.cajaPorPcForzada === false, JSON.stringify(cfg0));
  const prende = await local<{ cajaPorPc: boolean }>('lan:setCajaPorPc', { activa: true });
  check('el administrador la prende desde Configuración', prende.ok && prende.data.cajaPorPc === true, JSON.stringify(prende));

  // Login por la red (una vez; el JWT sirve para cualquier terminal).
  const login = await fetch(URL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'auth:login', payload: { username: 'admin', password: 'admin36724776' }, token: PIN }),
  });
  const jwt = ((await login.json()) as { data?: { _lanSessionToken?: string } }).data?._lanSessionToken ?? '';
  check('login por la red', jwt.length > 20);

  const remoto = async <T>(t: Terminal, channel: string, payload?: unknown, url = URL_RPC): Promise<IpcResponse<T>> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${jwt}` };
    if (t.id) {
      headers['x-stockflow-terminal'] = t.id;
      headers['x-stockflow-terminal-nombre'] = encodeURIComponent(t.nombre);
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ channel, payload, token: PIN }) });
    return (await res.json()) as IpcResponse<T>;
  };
  /** Por la puerta del túnel (internet), sin PC emparejada: el dueño desde su casa. */
  const tunel = <T,>(t: Terminal, channel: string, payload?: unknown) => remoto<T>(t, channel, payload, URL_TUNEL);

  const cf = (await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' }))!;
  await repos.company.upsert({ name: 'Prueba', priceMode: 'gross', allowNegativeStock: true } as never);
  const art = await repos.articles.create({ barcode: 'CT-1', description: 'Artículo caja', listPrice1: '100.0000', stock: '500.000' });
  const venta = (monto = '100.0000') => ({
    type: 'X',
    customerId: cf.id,
    payments: [{ paymentMethodId: PM_CASH, amount: monto }],
    lines: [{ articleId: art.id, quantity: String(Number(monto) / 100) + '.000' }],
  });
  type Caja = { id: string; terminalId: string | null; terminalName: string | null; status: string };
  type Venta = { sale: { id: string; cashRegisterId: string; number: number } };

  /* ------------------------------------------------------------------ */
  console.log('\n[2] Transición: todos siguen vendiendo en la caja compartida');
  const gA = await remoto<Caja | null>(TA, 'cash:getCurrent');
  const gB = await remoto<Caja | null>(TB, 'cash:getCurrent');
  const gV = await remoto<Caja | null>(VIEJA, 'cash:getCurrent');
  const gS = await local<Caja | null>('cash:getCurrent');
  check('terminal A ve la caja compartida', gA.ok && gA.data?.id === compartida.id, JSON.stringify(gA));
  check('terminal B ve la caja compartida', gB.ok && gB.data?.id === compartida.id);
  check('terminal vieja (sin encabezado) ve la caja compartida', gV.ok && gV.data?.id === compartida.id);
  check('el servidor ve la caja compartida', gS.ok && gS.data?.id === compartida.id);
  const vA0 = await remoto<Venta>(TA, 'sales:create', venta());
  const vB0 = await remoto<Venta>(TB, 'sales:create', venta());
  const vV0 = await remoto<Venta>(VIEJA, 'sales:create', venta());
  const vS0 = await local<Venta>('sales:create', venta());
  check(
    'las ventas de A, B, la terminal vieja y el servidor entran a la compartida',
    [vA0, vB0, vV0, vS0].every((v) => v.ok && v.data.sale.cashRegisterId === compartida.id),
    JSON.stringify([vA0, vB0, vV0, vS0].map((v) => (v.ok ? v.data.sale.cashRegisterId : v))),
  );
  const cierreComp = await remoto<{ report: { expectedCash: string } }>(TB, 'cash:close', { registerId: compartida.id, closingAmount: '1400.0000' });
  check('la compartida se cierra con las 4 ventas (1000 + 4×100)', cierreComp.ok && Number(cierreComp.data.report.expectedCash) === 1400, JSON.stringify(cierreComp).slice(0, 200));

  /* ------------------------------------------------------------------ */
  console.log('\n[3] Cada PC abre y arquea su propia caja');
  const sinA = await remoto<Caja | null>(TA, 'cash:getCurrent');
  check('cerrada la compartida, A no tiene caja', sinA.ok && sinA.data === null, JSON.stringify(sinA));
  const abreA = await remoto<Caja>(TA, 'cash:open', { openingAmount: '100.0000' });
  check('A abre la suya, con su id y el nombre de la PC', abreA.ok && abreA.data.terminalId === ID_A && abreA.data.terminalName === TA.nombre, JSON.stringify(abreA));
  const bNoVeA = await remoto<Caja | null>(TB, 'cash:getCurrent');
  check('B NO ve la caja de A', bNoVeA.ok && bNoVeA.data === null, JSON.stringify(bNoVeA));
  const abreB = await remoto<Caja>(TB, 'cash:open', { openingAmount: '200.0000' });
  check('B abre la suya (la de A no la bloquea)', abreB.ok && abreB.data.terminalId === ID_B && abreB.data.id !== (abreA.ok ? abreA.data.id : ''), JSON.stringify(abreB));
  const dobleA = await remoto<Caja>(TA, 'cash:open', { openingAmount: '0.0000' });
  check('A no puede abrir una segunda caja', !dobleA.ok && /ya tiene una caja abierta/.test((dobleA as { message?: string }).message ?? ''), JSON.stringify(dobleA));
  const sNoVe = await local<Caja | null>('cash:getCurrent');
  check('el servidor no ve ni la de A ni la de B', sNoVe.ok && sNoVe.data === null, JSON.stringify(sNoVe));
  const abreS = await local<Caja>('cash:open', { openingAmount: '300.0000' });
  check('el servidor abre la suya con su propio id', abreS.ok && abreS.data.terminalId === ID_SERVIDOR, JSON.stringify(abreS));
  const cajaA = abreA.ok ? abreA.data.id : '';
  const cajaB = abreB.ok ? abreB.data.id : '';
  const cajaS = abreS.ok ? abreS.data.id : '';

  const vA = await remoto<Venta>(TA, 'sales:create', venta('100.0000'));
  const vB = await remoto<Venta>(TB, 'sales:create', venta('200.0000'));
  const vS = await local<Venta>('sales:create', venta('300.0000'));
  check('la venta de A cae en la caja de A', vA.ok && vA.data.sale.cashRegisterId === cajaA, JSON.stringify(vA).slice(0, 200));
  check('la venta de B cae en la caja de B', vB.ok && vB.data.sale.cashRegisterId === cajaB, JSON.stringify(vB).slice(0, 200));
  check('la venta del servidor cae en la suya', vS.ok && vS.data.sale.cashRegisterId === cajaS);
  // Pedidos simultáneos de las dos terminales: cada venta a su caja.
  const [pA, pB] = await Promise.all([remoto<Venta>(TA, 'sales:create', venta()), remoto<Venta>(TB, 'sales:create', venta())]);
  check('ventas simultáneas de A y B: cada una en su caja', pA.ok && pB.ok && pA.data.sale.cashRegisterId === cajaA && pB.data.sale.cashRegisterId === cajaB);

  const repA = await remoto<{ expectedCash: string }>(TA, 'cash:getReport', { registerId: cajaA });
  const repB = await remoto<{ expectedCash: string }>(TB, 'cash:getReport', { registerId: cajaB });
  check('arqueo de A: 100 + 100 + 100 = 300', repA.ok && Number(repA.data.expectedCash) === 300, repA.ok ? repA.data.expectedCash : JSON.stringify(repA));
  check('arqueo de B: 200 + 200 + 100 = 500', repB.ok && Number(repB.data.expectedCash) === 500, repB.ok ? repB.data.expectedCash : JSON.stringify(repB));
  const viejaVe = await remoto<Caja | null>(VIEJA, 'cash:getCurrent');
  check('una terminal vieja sin encabezado sigue con la caja del servidor (como antes)', viejaVe.ok && viejaVe.data?.id === cajaS);

  /* ------------------------------------------------------------------ */
  console.log('\n[4] Anular con la caja original cerrada: el efectivo sale del cajón de quien anula');
  const ventaDeB = vB.ok ? vB.data.sale.id : '';
  const cierreB = await remoto(TB, 'cash:close', { registerId: cajaB, closingAmount: '500.0000' });
  check('B cierra su caja', cierreB.ok, JSON.stringify(cierreB).slice(0, 200));
  const anula = await remoto(TA, 'sales:void', { id: ventaDeB, reason: 'prueba' });
  check('A anula una venta de la caja (cerrada) de B', anula.ok, JSON.stringify(anula).slice(0, 200));
  const movsA = await repos.cashMovements.findByRegister(cajaA);
  const movsS = await repos.cashMovements.findByRegister(cajaS);
  check('el reverso en efectivo entró a la caja de A', movsA.some((m) => m.type === 'expense' && m.relatedSaleId === ventaDeB && m.amount === '200.0000'));
  check('la caja del servidor no recibió nada', !movsS.some((m) => m.relatedSaleId === ventaDeB));
  const sinCaja = await remoto(TB, 'sales:void', { id: vA.ok ? vA.data.sale.id : '', reason: 'x' });
  check('la venta de A sigue en su caja abierta: B puede anularla (va a la caja original)', sinCaja.ok, JSON.stringify(sinCaja).slice(0, 200));
  // B sin caja abierta y una venta de una caja cerrada: se le pide abrir caja,
  // no se usa la de otra PC.
  const vS2 = await local<Venta>('sales:create', venta('100.0000'));
  await local('cash:close', { registerId: cajaS, closingAmount: '400.0000' });
  const bSinCaja = await remoto<unknown>(TB, 'sales:void', { id: vS2.ok ? vS2.data.sale.id : '', reason: 'x' });
  check(
    'B sin caja propia no puede sacar el efectivo del cajón de A',
    !bSinCaja.ok && /caja/i.test((bSinCaja as { message?: string }).message ?? ''),
    JSON.stringify(bSinCaja).slice(0, 200),
  );

  /* ------------------------------------------------------------------ */
  console.log('\n[5] Movimiento manual y Flowy miran la caja de la PC que pregunta');
  const mov = await remoto<{ cashRegisterId: string }>(TA, 'cash:addMovement', { type: 'income', amount: '50.0000', description: 'Cambio' });
  check('el ingreso manual de A va a la caja de A', mov.ok && mov.data.cashRegisterId === cajaA, JSON.stringify(mov).slice(0, 200));
  const flowyA = await remoto<{ reply: string }>(TA, 'assistant:ask', { messages: [{ role: 'user', content: 'cuanto hay en caja' }] });
  const flowyB = await remoto<{ reply: string }>(TB, 'assistant:ask', { messages: [{ role: 'user', content: 'cuanto hay en caja' }] });
  // Caja de A: 100 de apertura + 2 ventas de 100 − 200 (reverso de la venta de
  // B) − 100 (anulación de la venta de A) + 50 (ingreso manual) = 50.
  check('Flowy en A habla de la caja de A (efectivo 50)', flowyA.ok && /50,00 en efectivo/.test(flowyA.data.reply), JSON.stringify(flowyA).slice(0, 200));
  check('Flowy en B: no hay caja abierta en esa PC', flowyB.ok && /ninguna caja/i.test(flowyB.data.reply), JSON.stringify(flowyB).slice(0, 200));

  /* ------------------------------------------------------------------ */
  console.log('\n[6] Ventas y compras sin duplicar (misma clave de intento)');
  type VentaCompleta = { sale: { id: string; number: number; total: string; cashRegisterId: string }; lines: { id: string }[]; payments: { id: string }[] };
  const contarVentas = () => (db.$client.prepare('SELECT COUNT(*) n FROM sales').get() as { n: number }).n;
  const stockDe = async () => (await repos.articles.findById(art.id))!.stock;
  const movsDeCaja = async () => (await repos.cashMovements.findByRegister(cajaA)).length;
  const clave = nuevaClaveIdempotencia();
  check('la clave es un uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(clave), clave);
  const n0 = contarVentas();
  const s0 = await stockDe();
  const m0 = await movsDeCaja();
  const conClave = { ...venta('200.0000'), idempotencyKey: clave };
  const p1 = await remoto<VentaCompleta>(TA, 'sales:create', conClave);
  const p2 = await remoto<VentaCompleta>(TA, 'sales:create', conClave);
  check('primera vez: la venta entra', p1.ok, JSON.stringify(p1).slice(0, 200));
  check('segunda vez con la misma clave: misma venta (id y número)', p1.ok && p2.ok && p2.data.sale.id === p1.data.sale.id && p2.data.sale.number === p1.data.sale.number);
  check(
    'misma respuesta: líneas, pagos y total',
    p1.ok && p2.ok &&
      JSON.stringify(p2.data.lines.map((l) => l.id)) === JSON.stringify(p1.data.lines.map((l) => l.id)) &&
      JSON.stringify(p2.data.payments.map((x) => x.id)) === JSON.stringify(p1.data.payments.map((x) => x.id)) &&
      p2.data.sale.total === p1.data.sale.total,
  );
  check('una sola venta en la base', contarVentas() === n0 + 1, `${n0} → ${contarVentas()}`);
  check('el stock bajó una sola vez (2 unidades)', Number(await stockDe()) === Number(s0) - 2, `${s0} → ${await stockDe()}`);
  check('un solo cobro en la caja', (await movsDeCaja()) === m0 + 1);
  // Dos pedidos con la misma clave A LA VEZ (el primero tardó, el cajero
  // volvió a cobrar): uno crea, el otro devuelve el mismo.
  const clave2 = nuevaClaveIdempotencia();
  const [c1, c2] = await Promise.all([
    remoto<VentaCompleta>(TA, 'sales:create', { ...venta(), idempotencyKey: clave2 }),
    remoto<VentaCompleta>(TA, 'sales:create', { ...venta(), idempotencyKey: clave2 }),
  ]);
  check('simultáneos con la misma clave: una sola venta', c1.ok && c2.ok && c1.data.sale.id === c2.data.sale.id && contarVentas() === n0 + 2, JSON.stringify([c1.ok, c2.ok, contarVentas() - n0]));
  // Sin clave (terminal vieja): igual que siempre, dos ventas.
  await remoto(TA, 'sales:create', venta());
  await remoto(TA, 'sales:create', venta());
  check('sin clave: dos ventas, como antes', contarVentas() === n0 + 4);
  // La misma clave para OTRA venta (otro comprobante): se rechaza.
  const otroTipo = await remoto(TA, 'sales:create', { ...venta('200.0000'), type: 'B', idempotencyKey: clave });
  check('la misma clave en otra venta se rechaza', !otroTipo.ok && (otroTipo as { constraint?: string }).constraint === 'IDEMPOTENCY_KEY_REUSED', JSON.stringify(otroTipo).slice(0, 200));
  const mala = await remoto(TA, 'sales:create', { ...venta(), idempotencyKey: 'x' });
  check('una clave con formato inválido se rechaza', !mala.ok && (mala as { code?: string }).code === 'VALIDATION', JSON.stringify(mala).slice(0, 160));
  // Se perdió la respuesta y en el medio se cerró la caja: el reintento
  // devuelve la venta que ya entró en vez de decir "no hay caja abierta".
  const clave3 = nuevaClaveIdempotencia();
  const antesDeCerrar = await remoto<VentaCompleta>(TA, 'sales:create', { ...venta(), idempotencyKey: clave3 });
  await remoto(TA, 'cash:close', { registerId: cajaA, closingAmount: '0.0000' });
  const tras = await remoto<VentaCompleta>(TA, 'sales:create', { ...venta(), idempotencyKey: clave3 });
  check('reintento con la caja ya cerrada: devuelve la venta registrada', antesDeCerrar.ok && tras.ok && tras.data.sale.id === antesDeCerrar.data.sale.id, JSON.stringify(tras).slice(0, 200));
  const sinCajaNueva = await remoto(TA, 'sales:create', { ...venta(), idempotencyKey: nuevaClaveIdempotencia() });
  check('una venta NUEVA sin caja sigue rechazándose', !sinCajaNueva.ok);

  // Compras: misma clave dos veces = una sola compra y el stock sube una vez.
  const prov = await repos.suppliers.create({ code: 'P-CT', name: 'Proveedor caja' } as never);
  const compra = {
    type: 'X',
    supplierId: prov.id,
    isAccountPurchase: true,
    lines: [{ articleId: art.id, quantity: '10.000', costPrice: '50.0000' }],
    idempotencyKey: nuevaClaveIdempotencia(),
  };
  const sc0 = await stockDe();
  const nc0 = (db.$client.prepare('SELECT COUNT(*) n FROM purchases').get() as { n: number }).n;
  const k1 = await remoto<{ purchase: { id: string } }>(TA, 'purchases:create', compra);
  const k2 = await remoto<{ purchase: { id: string } }>(TA, 'purchases:create', compra);
  const nc1 = (db.$client.prepare('SELECT COUNT(*) n FROM purchases').get() as { n: number }).n;
  check('compra repetida: misma compra', k1.ok && k2.ok && k1.data.purchase.id === k2.data.purchase.id, JSON.stringify(k1).slice(0, 200));
  check('una sola compra en la base y el stock sube una vez (+10)', nc1 === nc0 + 1 && Number(await stockDe()) === Number(sc0) + 10, `${nc0}→${nc1}, ${sc0}→${await stockDe()}`);
  const cuentas = db.$client.prepare('SELECT COUNT(*) n FROM supplier_accounts_payable WHERE purchase_id = ?').get(k1.ok ? k1.data.purchase.id : '') as { n: number };
  check('una sola deuda con el proveedor', cuentas.n === 1);

  // La pantalla: misma operación sin confirmar = misma clave.
  let n = 0;
  const intento = new IntentoDeOperacion(() => `clave-${++n}-xxxxxxxx`);
  const carrito = { customerId: 'c', lines: [{ articleId: 'a', quantity: '1' }] };
  const k_1 = intento.clavePara(carrito);
  const k_2 = intento.clavePara({ lines: [{ quantity: '1', articleId: 'a' }], customerId: 'c' });
  check('pantalla: reintentar el mismo carrito reusa la clave (el orden de los campos no importa)', k_1 === k_2, `${k_1} ${k_2}`);
  const k_3 = intento.clavePara({ ...carrito, lines: [{ articleId: 'a', quantity: '2' }] });
  check('pantalla: si cambió el carrito, clave nueva', k_3 !== k_1);
  intento.confirmar();
  const k_4 = intento.clavePara({ ...carrito, lines: [{ articleId: 'a', quantity: '2' }] });
  check('pantalla: tras una venta confirmada, la siguiente (aunque sea igual) lleva clave nueva', k_4 !== k_3);
  // Sin crypto.randomUUID (terminal por navegador en http://IP): igual da un uuid v4.
  const original = globalThis.crypto.randomUUID;
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  const sinUuid = nuevaClaveIdempotencia();
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
  check('sin randomUUID (http://) igual genera un uuid v4', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sinUuid), sinUuid);

  /* ------------------------------------------------------------------ */
  console.log('\n[7] Punto de venta recordado por PC');
  // Cada PC tiene su propio almacenamiento (Electron por PC, navegador por
  // navegador): se simulan dos con dos localStorage distintos.
  const almacen = (): Storage => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    } as Storage;
  };
  const pcA = almacen();
  const pcB = almacen();
  const g = globalThis as { localStorage?: Storage };
  const usar = (st: Storage | undefined) => {
    Object.defineProperty(globalThis, 'localStorage', { value: st, configurable: true, writable: true });
  };
  const previo = g.localStorage;
  const tres = [{ number: 2 }, { number: 4 }, { number: 7 }];
  usar(pcA);
  check('PC nueva sin recuerdo: el primer PV activo (como hoy)', elegirPuntoDeVenta(tres, null) === 2);
  guardarPuntoDeVentaPC(4);
  usar(pcB);
  guardarPuntoDeVentaPC(7);
  usar(pcA);
  check('PC A recuerda el 4', leerPuntoDeVentaPC() === 4 && elegirPuntoDeVenta(tres, null) === 4);
  usar(pcB);
  check('PC B recuerda el 7 (no pisa a A)', leerPuntoDeVentaPC() === 7 && elegirPuntoDeVenta(tres, null) === 7);
  check('lo elegido en pantalla gana sobre lo recordado', elegirPuntoDeVenta(tres, 2) === 2);
  check('con un solo PV activo, ése (aunque se recuerde otro)', elegirPuntoDeVenta([{ number: 2 }], null) === 2);
  check('recordado dado de baja: cae al primero activo', elegirPuntoDeVenta([{ number: 2 }, { number: 4 }], null) === 2);
  check('sin PV activos: ninguno', elegirPuntoDeVenta([], null) === null);
  usar(undefined);
  check('sin localStorage (modo privado): no rompe, primer activo', leerPuntoDeVentaPC() === null && elegirPuntoDeVenta(tres, null) === 2);
  guardarPuntoDeVentaPC(4);
  usar(previo);

  /* ------------------------------------------------------------------ */
  console.log('\n[8] La caja por PC es una opción: túnel, apagarla y prenderla');
  const WEB: Terminal = { id: 'web-0123456789abcdef', nombre: 'Navegador' };
  // Prendida: el dueño entra por el túnel (sin PC emparejada) declarando el id
  // de A. No opera sobre la caja de A: opera como el servidor, como antes.
  const abreA8 = await remoto<Caja>(TA, 'cash:open', { openingAmount: '10.0000' });
  const abreS8 = await local<Caja>('cash:open', { openingAmount: '20.0000' });
  const cajaA8 = abreA8.ok ? abreA8.data.id : '';
  const cajaS8 = abreS8.ok ? abreS8.data.id : '';
  check('prendida: A y el servidor tienen cada uno su caja', abreA8.ok && abreS8.ok && cajaA8 !== cajaS8, JSON.stringify([abreA8.ok, abreS8.ok]));
  const tunGet = await tunel<Caja | null>(TA, 'cash:getCurrent');
  check('túnel declarando el id de A → ve la caja del SERVIDOR, no la de A', tunGet.ok && tunGet.data?.id === cajaS8, JSON.stringify(tunGet).slice(0, 160));
  const tunVenta = await tunel<Venta>(TA, 'sales:create', venta());
  check('la venta del dueño por el túnel cae en la caja del servidor', tunVenta.ok && tunVenta.data.sale.cashRegisterId === cajaS8, JSON.stringify(tunVenta).slice(0, 160));
  const tunMov = await tunel<{ cashRegisterId: string }>(TA, 'cash:addMovement', { type: 'expense', amount: '1.0000', description: 'Egreso remoto' });
  check('un egreso por el túnel NO entra a la caja de A', tunMov.ok && tunMov.data.cashRegisterId === cajaS8, JSON.stringify(tunMov).slice(0, 160));

  // Apagarla con cajas abiertas de otras PC: no (quedarían sin pantalla).
  const apagaMal = await local('lan:setCajaPorPc', { activa: false });
  check('no se apaga con la caja de A abierta (pide cerrarla antes)', !apagaMal.ok && /Historial de cajas/.test((apagaMal as { message?: string }).message ?? ''), JSON.stringify(apagaMal));
  const cierraA8 = await local('cash:close', { registerId: cajaA8, closingAmount: '10.0000' });
  check('el administrador cierra la caja de A desde el servidor (cash:close con su id)', cierraA8.ok, JSON.stringify(cierraA8).slice(0, 160));
  const apaga = await local<{ cajaPorPc: boolean }>('lan:setCajaPorPc', { activa: false });
  check('cerrada la de A, se apaga', apaga.ok && apaga.data.cajaPorPc === false, JSON.stringify(apaga));
  const cierraS8 = await local('cash:close', { registerId: cajaS8, closingAmount: '0.0000' });
  check('se cierra la del servidor', cierraS8.ok);

  // APAGADA = la 1.12. El caso del revisor: el lunes se abre la caja en la PC
  // servidor; las otras PC (instaladas o por navegador) venden en ELLA.
  const lunes = await local<Caja>('cash:open', { openingAmount: '1000.0000' });
  const cajaL = lunes.ok ? lunes.data.id : '';
  check('apagada: el servidor abre la caja del local (con su id, como siempre)', lunes.ok && lunes.data.terminalId === ID_SERVIDOR, JSON.stringify(lunes).slice(0, 160));
  const veA = await remoto<Caja | null>(TA, 'cash:getCurrent');
  const veB = await remoto<Caja | null>(TB, 'cash:getCurrent');
  const veW = await remoto<Caja | null>(WEB, 'cash:getCurrent');
  const veT = await tunel<Caja | null>(WEB, 'cash:getCurrent');
  check('A, B, el navegador y el túnel ven la caja del servidor', [veA, veB, veW, veT].every((r) => r.ok && r.data?.id === cajaL), JSON.stringify([veA, veB, veW, veT].map((r) => (r.ok ? r.data?.id : r))));
  const abreOtra = await remoto<Caja>(TA, 'cash:open', { openingAmount: '0.0000' });
  check('A no abre una segunda caja (ya hay una del local), igual que en la 1.12', !abreOtra.ok, JSON.stringify(abreOtra).slice(0, 160));
  const lA = await remoto<Venta>(TA, 'sales:create', venta('100.0000'));
  const lB = await remoto<Venta>(TB, 'sales:create', venta('200.0000'));
  const lW = await remoto<Venta>(WEB, 'sales:create', venta('300.0000'));
  check('las ventas de A, B y el navegador entran a la caja del local', [lA, lB, lW].every((v) => v.ok && v.data.sale.cashRegisterId === cajaL), JSON.stringify([lA, lB, lW].map((v) => (v.ok ? v.data.sale.cashRegisterId : v))));
  const movB = await remoto<{ cashRegisterId: string }>(TB, 'cash:addMovement', { type: 'income', amount: '50.0000', description: 'Cambio' });
  check('el ingreso manual de B va a la caja del local', movB.ok && movB.data.cashRegisterId === cajaL, JSON.stringify(movB).slice(0, 160));
  // Anular una venta de una caja ya cerrada desde una PC que no abrió caja: el
  // reverso va a la caja abierta del local (en la 1.12 era así).
  const anulaL = await remoto(TB, 'sales:void', { id: tunVenta.ok ? tunVenta.data.sale.id : '', reason: 'prueba' });
  check('B anula una venta de una caja cerrada: el reverso va a la caja del local', anulaL.ok && (await repos.cashMovements.findByRegister(cajaL)).some((m) => m.type === 'expense' && m.relatedSaleId === (tunVenta.ok ? tunVenta.data.sale.id : '')), JSON.stringify(anulaL).slice(0, 160));
  const flowyL = await remoto<{ reply: string }>(TA, 'assistant:ask', { messages: [{ role: 'user', content: 'cuanto hay en caja' }] });
  check('Flowy en A habla de la caja del local', flowyL.ok && !/ninguna caja/i.test(flowyL.data.reply), JSON.stringify(flowyL).slice(0, 160));
  const cierreL = await remoto<{ report: { expectedCash: string } }>(TA, 'cash:close', { registerId: cajaL, closingAmount: '1550.0000' });
  // 1000 + 100 + 200 + 300 + 50 − 100 (reverso) = 1550: UN arqueo para todo el local.
  check('un solo arqueo con todo el local (1000+100+200+300+50−100 = 1550)', cierreL.ok && Number(cierreL.data.report.expectedCash) === 1550, JSON.stringify(cierreL).slice(0, 200));

  // Prenderla con la caja del local abierta: pasa a compartida, nadie se queda sin caja.
  const martes = await local<Caja>('cash:open', { openingAmount: '500.0000' });
  const prende2 = await local<{ cajaPorPc: boolean }>('lan:setCajaPorPc', { activa: true });
  const veA2 = await remoto<Caja | null>(TA, 'cash:getCurrent');
  const veS2 = await local<Caja | null>('cash:getCurrent');
  check(
    'prenderla a mitad de turno: la caja del local pasa a compartida y A sigue vendiendo en ella',
    martes.ok && prende2.ok && veA2.ok && veS2.ok && veA2.data?.id === martes.data.id && veS2.data?.id === martes.data.id && veA2.data?.terminalId === null,
    JSON.stringify([veA2.ok && veA2.data, veS2.ok && veS2.data?.id]).slice(0, 200),
  );
  const prendidaFunc = await remoto<{ cajaPorPc?: boolean }>(TA, 'funciones:estado');
  check('funciones:estado informa la caja por PC a las terminales', prendidaFunc.ok && prendidaFunc.data.cajaPorPc === true, JSON.stringify(prendidaFunc));
  const desdeTerminal = await fetch(URL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}`, 'x-stockflow-terminal': ID_A },
    body: JSON.stringify({ channel: 'lan:setCajaPorPc', payload: { activa: false }, token: PIN }),
  });
  check('una terminal no puede cambiar la opción (lan:* no cruza la red → 403)', desdeTerminal.status === 403, String(desdeTerminal.status));
  const auditOpc = db.$client.prepare(`SELECT description FROM audit_log WHERE channel = 'lan:setCajaPorPc'`).all() as { description: string }[];
  check('prender y apagar queda en la auditoría', auditOpc.length >= 3, JSON.stringify(auditOpc));

  await server.stop();
  closeLocalDb(db);
}

main()
  .catch((e) => {
    console.error(e);
    fallas++;
  })
  .finally(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    if (fallas > 0) {
      console.error(`\n✗ TEST CAJA POR TERMINAL: ${fallas} falla(s)`);
      process.exit(1);
    }
    console.log('\nTEST CAJA POR TERMINAL OK ✅');
    process.exit(0);
  });
