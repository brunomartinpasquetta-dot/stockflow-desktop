/**
 * Test de integración del bridge IPC, sin levantar Electron (corre con `tsx`).
 *
 *   pnpm --filter @stockflow/desktop test:ipc
 *
 * Arma los handlers con `buildAllHandlers` sobre una DB temporal y los invoca
 * manualmente con payloads de prueba, verificando el contrato `{ ok, ... }`.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

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
    userDataDir: tmpDir,
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

  // ---------------------- articles: imagen (upload/get/remove)
  // PNG 1x1 transparente válido.
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  );
  const tmpPngPath = join(tmpDir, 'sample.png');
  writeFileSync(tmpPngPath, PNG_1x1);
  const upload = await invoke<{ imagePath: string }>(handlers, 'articles:uploadImage', {
    articleId: created.data.id,
    sourcePath: tmpPngPath,
  });
  check(
    'articles:uploadImage copia y persiste imagePath',
    upload.ok && upload.data.imagePath.endsWith('.png') && existsSync(join(tmpDir, upload.data.imagePath)),
    JSON.stringify(upload),
  );
  const dataUrl = await invoke<{ dataUrl: string | null }>(handlers, 'articles:getImageDataUrl', {
    articleId: created.data.id,
  });
  check(
    'articles:getImageDataUrl devuelve data:image/...',
    dataUrl.ok && !!dataUrl.data.dataUrl && dataUrl.data.dataUrl.startsWith('data:image/'),
    dataUrl.ok ? `prefix=${dataUrl.data.dataUrl?.slice(0, 24)}` : JSON.stringify(dataUrl),
  );
  const removeImg = await invoke<{ ok: true }>(handlers, 'articles:removeImage', {
    articleId: created.data.id,
  });
  const afterRemove = await invoke<{ imagePath: string | null } | null>(handlers, 'articles:get', {
    id: created.data.id,
  });
  check(
    'articles:removeImage borra archivo + setea imagePath=null',
    removeImg.ok &&
      afterRemove.ok &&
      afterRemove.data?.imagePath == null &&
      !existsSync(join(tmpDir, 'article-images', `${created.data.id}.png`)),
    JSON.stringify({ removeImg, afterRemove }).slice(0, 200),
  );

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

  // cash:listHistorical y cash:getHistoricalReport
  const histList = await invoke<Array<{ id: string; totalIncome: string; userName: string; movementCount: number }>>(
    handlers,
    'cash:listHistorical',
    { from: 0, to: Date.now() + 86_400_000 },
  );
  check(
    'cash:listHistorical devuelve la caja abierta con ingresos calculados',
    histList.ok && histList.data.length >= 1 && histList.data.some((r) => r.totalIncome === '1000.0000' && r.userName.length > 0),
    histList.ok ? `len=${histList.data.length}` : JSON.stringify(histList),
  );
  const histReport = await invoke<{ register: { id: string }; byPaymentMethod: Array<{ paymentMethodId: string | null; incomeTotal: string }>; movementsDetail: unknown[] }>(
    handlers,
    'cash:getHistoricalReport',
    { cashRegisterId: cashOpen.ok ? cashOpen.data.id : '' },
  );
  const histEfectivo = histReport.ok ? histReport.data.byPaymentMethod.find((b) => b.paymentMethodId === 'pm-efectivo') : undefined;
  check(
    'cash:getHistoricalReport (byPaymentMethod efectivo + movementsDetail)',
    histReport.ok && histEfectivo?.incomeTotal === '1000.0000' && histReport.data.movementsDetail.length >= 1,
    histReport.ok ? `mov=${histReport.data.movementsDetail.length}` : JSON.stringify(histReport).slice(0, 300),
  );

  // error tipado: sales:get inexistente → NOT_FOUND
  const notFound = await invoke(handlers, 'sales:get', { id: 'no-existe' });
  check('sales:get id inexistente → NOT_FOUND', !notFound.ok && notFound.code === 'NOT_FOUND', JSON.stringify(notFound));

  // priceUpdate flow: preview → apply → rollback sobre el artículo creado.
  const puPreview = await invoke<{ articlesAffected: number; entries: Array<{ field: string; newValue: string }> }>(
    handlers,
    'priceUpdate:preview',
    {
      filter: { scope: 'manual', articleIds: [created.data.id], onlyActive: true },
      rule: { type: 'percentage', value: '10', direction: 'increase', fields: ['listPrice1'] },
    },
  );
  check(
    'priceUpdate:preview +10% listPrice1 sobre artículo seleccionado',
    puPreview.ok && puPreview.data.articlesAffected === 1 && puPreview.data.entries[0]?.newValue === '550.0000',
    puPreview.ok ? `nv=${puPreview.data.entries[0]?.newValue}` : JSON.stringify(puPreview),
  );
  const puApply = await invoke<{ batchId: string; articlesAffected: number; entries: number }>(
    handlers,
    'priceUpdate:apply',
    {
      filter: { scope: 'manual', articleIds: [created.data.id], onlyActive: true },
      rule: { type: 'percentage', value: '10', direction: 'increase', fields: ['listPrice1'] },
      description: 'Suba IPC',
    },
  );
  check('priceUpdate:apply', puApply.ok && puApply.data.articlesAffected === 1 && puApply.data.entries === 1, JSON.stringify(puApply));
  const articleAfterPu = await invoke<{ listPrice1: string } | null>(handlers, 'articles:get', { id: created.data.id });
  check(
    'priceUpdate:apply actualizó listPrice1 a 550.0000',
    articleAfterPu.ok && articleAfterPu.data?.listPrice1 === '550.0000',
    JSON.stringify(articleAfterPu),
  );
  const puRollback = await invoke<{ entriesReverted: number }>(handlers, 'priceUpdate:rollback', {
    batchId: puApply.ok ? puApply.data.batchId : '',
  });
  check('priceUpdate:rollback', puRollback.ok && puRollback.data.entriesReverted === 1, JSON.stringify(puRollback));

  // búsqueda global (P-BUSQUEDA): el artículo creado contiene "Producto IPC test".
  const searchRes = await invoke<{ articles: Array<{ id: string }>; customers: Array<unknown>; suppliers: Array<unknown>; sales: Array<unknown>; purchases: Array<unknown> }>(
    handlers,
    'search:global',
    { query: 'producto' },
  );
  check(
    'search:global devuelve el artículo recién creado',
    searchRes.ok && searchRes.data.articles.some((a) => a.id === created.data.id),
    searchRes.ok ? `arts=${searchRes.data.articles.length}` : JSON.stringify(searchRes),
  );
  const searchEmpty = await invoke<{ articles: unknown[] }>(handlers, 'search:global', { query: '' });
  check('search:global con query vacía → arrays vacíos', searchEmpty.ok && Array.isArray(searchEmpty.data.articles) && searchEmpty.data.articles.length === 0, JSON.stringify(searchEmpty));

  // MercadoPago QR: getConfig antes de setup → configured:false; setup con fetch mockeado.
  const mpCfg1 = await invoke<{ configured: boolean }>(handlers, 'mpQr:getConfig');
  check('mpQr:getConfig sin setup → configured:false', mpCfg1.ok && mpCfg1.data.configured === false, JSON.stringify(mpCfg1));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/users/me')) return json({ id: '12345' });
    if (url.includes('/users/12345/stores') && method === 'POST') return json({ id: 'STORE-Z' });
    return json({}, 404);
  }) as typeof fetch;
  try {
    const mpSetup = await invoke<{ configured: true; storeId: string }>(handlers, 'mpQr:setupCompany', {
      mpUserId: '12345',
      accessToken: 'TEST',
    });
    check('mpQr:setupCompany OK', mpSetup.ok && mpSetup.data.configured === true && mpSetup.data.storeId === 'STORE-Z', JSON.stringify(mpSetup));
    const mpCfg2 = await invoke<{ configured: boolean }>(handlers, 'mpQr:getConfig');
    check('mpQr:getConfig post-setup → configured:true', mpCfg2.ok && mpCfg2.data.configured === true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // reports v2 (P-CONSULTAS): getLowStock / getInventory / getSalesByVendor
  const lowStockReport = await invoke<Array<{ articleId: string; suggestedQty: string }>>(
    handlers,
    'reports:getLowStock',
    { criteria: 'min' },
  );
  check(
    'reports:getLowStock responde array',
    lowStockReport.ok && Array.isArray(lowStockReport.data),
    lowStockReport.ok ? `len=${lowStockReport.data.length}` : JSON.stringify(lowStockReport),
  );
  const invReport = await invoke<{ groups: unknown[]; grandTotal: { articles: number } }>(
    handlers,
    'reports:getInventory',
    {},
  );
  check(
    'reports:getInventory responde con groups + grandTotal',
    invReport.ok && Array.isArray(invReport.data.groups) && typeof invReport.data.grandTotal.articles === 'number',
    invReport.ok ? `arts=${invReport.data.grandTotal.articles}` : JSON.stringify(invReport),
  );
  const byVendor = await invoke<{ rows: unknown[]; grandTotal: string; totalSales: number; vendorCount: number }>(
    handlers,
    'reports:getSalesByVendor',
    { from: 0, to: Date.now() + 86_400_000 },
  );
  check(
    'reports:getSalesByVendor responde con rows + grandTotal',
    byVendor.ok && Array.isArray(byVendor.data.rows) && typeof byVendor.data.grandTotal === 'string' && byVendor.data.totalSales >= 1,
    byVendor.ok ? `rows=${byVendor.data.rows.length} total=${byVendor.data.grandTotal}` : JSON.stringify(byVendor),
  );

  // contabilidad (P-CONTABLE)
  const acctSummary = await invoke<{
    assets: { total: string }
    sales: { count: number }
    cmv: { calculatedFromCurrent: boolean }
    grossResult: string
    vatPosition: string
  }>(handlers, 'accounting:getSummary', { from: 0, to: Date.now() + 86_400_000 });
  check(
    'accounting:getSummary devuelve resumen completo',
    acctSummary.ok && typeof acctSummary.data.assets.total === 'string' && acctSummary.data.cmv.calculatedFromCurrent === true,
    acctSummary.ok ? `sales=${acctSummary.data.sales.count} gross=${acctSummary.data.grossResult}` : JSON.stringify(acctSummary),
  );
  const acctVatSales = await invoke<Array<{ saleId: string; vat21: string }>>(
    handlers,
    'accounting:getVatBookSales',
    { from: 0, to: Date.now() + 86_400_000 },
  );
  check(
    'accounting:getVatBookSales responde array',
    acctVatSales.ok && Array.isArray(acctVatSales.data),
    acctVatSales.ok ? `len=${acctVatSales.data.length}` : JSON.stringify(acctVatSales),
  );
  const acctVatPurch = await invoke<Array<{ purchaseId: string }>>(
    handlers,
    'accounting:getVatBookPurchases',
    { from: 0, to: Date.now() + 86_400_000 },
  );
  check(
    'accounting:getVatBookPurchases responde array',
    acctVatPurch.ok && Array.isArray(acctVatPurch.data),
    acctVatPurch.ok ? `len=${acctVatPurch.data.length}` : JSON.stringify(acctVatPurch),
  );

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
