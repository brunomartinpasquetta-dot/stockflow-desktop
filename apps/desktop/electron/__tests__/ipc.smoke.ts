/**
 * Test de integración del bridge IPC, sin levantar Electron (corre con `tsx`).
 *
 *   pnpm --filter @stockflow/desktop test:ipc
 *
 * Arma los handlers con `buildAllHandlers` sobre una DB temporal y los invoca
 * manualmente con payloads de prueba, verificando el contrato `{ ok, ... }`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { BackupService } from '../backup/BackupService';
import { HardwareManager } from '../hardware/HardwareManager';
import { ExcelImportService } from '../import/ExcelImportService';
import { LicenseManager } from '../license/LicenseManager';
import { buildAllHandlers } from '../ipc/index';
import { SessionStore } from '../ipc/session-store';
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

async function invoke<T = unknown>(
  handlers: HandlerMap,
  channel: string,
  payload?: unknown,
): Promise<IpcResponse<T>> {
  const handler = handlers[channel];
  if (!handler) throw new Error(`canal IPC no registrado: ${channel}`);
  return (await handler(payload)) as IpcResponse<T>;
}

process.env.NODE_ENV = 'test';
process.env.STOCKFLOW_SESSION_SECRET = 'ipc-smoke-secret';

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-ipc-smoke-'));
const dbPath = join(tmpDir, 'stockflow.db');
console.log(`\nTest de integración IPC — DB temporal: ${dbPath}\n`);

async function main(): Promise<void> {
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);
  const sessionStore = new SessionStore();
  const licenseManager = new LicenseManager({
    userDataDir: tmpDir,
    machineId: 'test-machine',
    apiUrl: 'http://localhost:1',
    publicKeyPem: '',
  });
  const hardware = new HardwareManager({ userDataDir: tmpDir });
  const backup = new BackupService({ dbPath, backupDir: tmpDir, appVersion: '0.0.0-test' });
  const importService = new ExcelImportService();
  const handlers = buildAllHandlers({
    db,
    repos,
    sessionStore,
    machineId: 'test-machine',
    appVersion: '0.0.0-test',
    dbPath,
    licenseManager,
    hardware,
    backup,
    importService,
    emit: () => { /* noop */ },
  });
  check('buildAllHandlers registra >= 40 canales', Object.keys(handlers).length >= 40, `${Object.keys(handlers).length} canales`);

  // system (sin sesión)
  const ver = await invoke<{ version: string }>(handlers, 'system:getVersion');
  check('system:getVersion', ver.ok && ver.data.version === '0.0.0-test', JSON.stringify(ver));

  // call que requiere sesión, sin login → UNAUTHENTICATED
  const noSession = await invoke(handlers, 'articles:list');
  check('articles:list sin sesión → UNAUTHENTICATED', !noSession.ok && noSession.code === 'UNAUTHENTICATED', JSON.stringify(noSession));

  // login
  const login = await invoke<{ user: { username: string; role: string }; sessionToken: string }>(
    handlers,
    'auth:login',
    { username: 'admin', password: 'admin' },
  );
  check(
    'auth:login admin/admin',
    login.ok && login.data.user.username === 'admin' && login.data.user.role === 'admin' && typeof login.data.sessionToken === 'string' && login.data.sessionToken.length > 0,
    login.ok ? '' : JSON.stringify(login),
  );

  const badLogin = await invoke(handlers, 'auth:login', { username: 'admin', password: 'mala' });
  check('auth:login contraseña errónea → VALIDATION', !badLogin.ok && badLogin.code === 'VALIDATION', JSON.stringify(badLogin));
  // re-login para asegurar sesión activa
  await invoke(handlers, 'auth:login', { username: 'admin', password: 'admin' });

  const me = await invoke<{ username: string } | null>(handlers, 'auth:getCurrentUser');
  check('auth:getCurrentUser', me.ok && me.data?.username === 'admin', JSON.stringify(me));

  // customers:list incluye CONSUMIDOR FINAL (seed)
  const customers = await invoke<Array<{ id: string; lastName: string }>>(handlers, 'customers:list');
  const cf = customers.ok ? customers.data.find((c) => c.lastName === 'CONSUMIDOR FINAL') : undefined;
  check('customers:list devuelve el seed (CONSUMIDOR FINAL)', !!cf, cf ? `id=${cf.id}` : JSON.stringify(customers).slice(0, 200));
  if (!cf) throw new Error('Falta el cliente CONSUMIDOR FINAL del seed');

  // articles:create + articles:list
  const created = await invoke<{ id: string; barcode: string; stock: string }>(handlers, 'articles:create', {
    barcode: '7790000099999',
    description: 'Producto IPC test',
    listPrice1: '500.0000',
    stock: '20.000',
    minStock: '5.000',
  });
  check('articles:create', created.ok && created.data.barcode === '7790000099999', JSON.stringify(created));
  if (!created.ok) throw new Error('articles:create falló');

  const list = await invoke<Array<{ id: string }>>(handlers, 'articles:list');
  check('articles:list incluye el artículo recién creado', list.ok && list.data.some((a) => a.id === created.data.id), JSON.stringify(list).slice(0, 200));

  // paymentMethods:list (seed: 4 medios)
  const pms = await invoke<Array<{ id: string; name: string; isPhysicalCash: boolean }>>(handlers, 'paymentMethods:list');
  const efectivo = pms.ok ? pms.data.find((p) => p.id === 'pm-efectivo') : undefined;
  check(
    'paymentMethods:list devuelve los 4 medios del seed (Efectivo con efectivo físico)',
    pms.ok && pms.data.length === 4 && !!efectivo && efectivo.isPhysicalCash === true,
    pms.ok ? pms.data.map((p) => p.name).join(', ') : JSON.stringify(pms),
  );

  // company:get / company:upsert (priceMode)
  const comp1 = await invoke<{ priceMode: string }>(handlers, 'company:get');
  check('company:get priceMode default = gross', comp1.ok && comp1.data.priceMode === 'gross', JSON.stringify(comp1));
  const compUp = await invoke<{ priceMode: string }>(handlers, 'company:upsert', { name: 'Mi Empresa', priceMode: 'net' });
  check('company:upsert priceMode = net', compUp.ok && compUp.data.priceMode === 'net', JSON.stringify(compUp));
  await invoke(handlers, 'company:upsert', { name: 'Mi Empresa', priceMode: 'gross' }); // restaurar

  // supplierAccounts:listBalances (vacío al inicio, pero el canal debe responder ok)
  const supBal = await invoke<unknown[]>(handlers, 'supplierAccounts:listBalances');
  check('supplierAccounts:listBalances responde ok (sin deuda inicial)', supBal.ok && Array.isArray(supBal.data) && supBal.data.length === 0, JSON.stringify(supBal));

  // cash:open
  const cashOpen = await invoke<{ id: string; status: string }>(handlers, 'cash:open', { openingAmount: '1000.0000' });
  check('cash:open', cashOpen.ok && cashOpen.data.status === 'open', JSON.stringify(cashOpen));

  // sales:create end-to-end con el nuevo formato (payments: [{ paymentMethodId, amount }])
  const sale = await invoke<{ sale: { total: string; status: string; isAccountSale: boolean }; lines: unknown[]; payments: unknown[]; accountReceivable: unknown }>(
    handlers,
    'sales:create',
    {
      type: 'B',
      customerId: cf.id,
      payments: [{ paymentMethodId: 'pm-efectivo', amount: '1000.0000' }],
      lines: [{ articleId: created.data.id, quantity: '2.000' }],
    },
  );
  check(
    'sales:create end-to-end (precio resuelto, stock, caja, 1 pago en efectivo)',
    sale.ok && sale.data.sale.total === '1000.0000' && sale.data.lines.length === 1 && sale.data.payments.length === 1 && sale.data.accountReceivable === null && sale.data.sale.isAccountSale === false,
    sale.ok ? `total=${sale.data.sale.total}` : JSON.stringify(sale),
  );

  const articleAfter = await invoke<{ stock: string } | null>(handlers, 'articles:get', { id: created.data.id });
  check('sales:create descontó stock', articleAfter.ok && articleAfter.data?.stock === '18.000', articleAfter.ok ? `stock=${articleAfter.data?.stock}` : JSON.stringify(articleAfter));

  // cash:getReport (incluye desglose por medio de pago)
  const report = await invoke<{ incomeTotal: string; expectedCash: string; byPaymentMethod: Array<{ paymentMethodId: string | null; net: string }> }>(
    handlers,
    'cash:getReport',
    { registerId: cashOpen.ok ? cashOpen.data.id : '' },
  );
  const efectivoBd = report.ok ? report.data.byPaymentMethod.find((b) => b.paymentMethodId === 'pm-efectivo') : undefined;
  check(
    'cash:getReport (ingresos en efectivo + desglose)',
    report.ok && report.data.incomeTotal === '1000.0000' && report.data.expectedCash === '2000.0000' && efectivoBd?.net === '1000.0000',
    JSON.stringify(report).slice(0, 300),
  );

  // error tipado: sales:get inexistente → NOT_FOUND
  const notFound = await invoke(handlers, 'sales:get', { id: 'no-existe' });
  check('sales:get id inexistente → NOT_FOUND', !notFound.ok && notFound.code === 'NOT_FOUND', JSON.stringify(notFound));

  // logout → vuelve a UNAUTHENTICATED
  await invoke(handlers, 'auth:logout');
  const afterLogout = await invoke(handlers, 'articles:list');
  check('articles:list tras logout → UNAUTHENTICATED', !afterLogout.ok && afterLogout.code === 'UNAUTHENTICATED', JSON.stringify(afterLogout));

  closeLocalDb(db);
}

main()
  .catch((err) => {
    console.error('\n✗ Excepción durante el test:', err);
    failures++;
  })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
    if (failures > 0) {
      console.error(`\nTEST IPC FALLÓ — ${failures} check(s) con error.\n`);
      process.exit(1);
    }
    console.log('\nTEST IPC OK ✅\n');
  });
