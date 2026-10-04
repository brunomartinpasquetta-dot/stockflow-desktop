/**
 * Test de integración del bridge IPC, sin levantar Electron (corre con `tsx`).
 *
 *   pnpm --filter @stockflow/desktop test:ipc
 *
 * Arma los handlers con `buildAllHandlers` sobre una DB temporal y los invoca
 * manualmente con payloads de prueba, verificando el contrato `{ ok, ... }`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

import { closeLocalDb, createRepositories, initLocalDb, SUCURSAL_CENTRAL_ID } from '@stockflow/db';

import { BackupService } from '../backup/BackupService';
import { HardwareManager } from '../hardware/HardwareManager';
import { ExcelImportService } from '../import/ExcelImportService';
import { LicenseManager } from '../license/LicenseManager';
import { ARCHIVO_EDICION_PRUEBA, tieneMultisucursal } from '../license/funciones';
import { buildAllHandlers } from '../ipc/index';
import { lanServerAccepts, remotoAccepts, shouldRouteLan } from '../preload-bridge';
import { SessionStore } from '../ipc/session-store';
import { correrComoTerminal } from '../ipc/terminal-actual';
import type { HandlerMap } from '../ipc/handler-context';
import type { EdicionPruebaDTO, IpcResponse } from '../ipc/types';

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
    { username: 'admin', password: 'admin36724776' },
  );
  check(
    'auth:login admin/admin',
    login.ok && login.data.user.username === 'admin' && login.data.user.role === 'admin' && typeof login.data.sessionToken === 'string' && login.data.sessionToken.length > 0,
    login.ok ? '' : JSON.stringify(login),
  );

  const badLogin = await invoke(handlers, 'auth:login', { username: 'admin', password: 'mala' });
  check('auth:login contraseña errónea → VALIDATION', !badLogin.ok && badLogin.code === 'VALIDATION', JSON.stringify(badLogin));
  // re-login para asegurar sesión activa
  await invoke(handlers, 'auth:login', { username: 'admin', password: 'admin36724776' });

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

  // --- MULTISUCURSAL: edición de la licencia + sucursales ---------------------
  {
    const fun = await invoke<{ edicion: string; multisucursal: boolean }>(handlers, 'funciones:estado');
    check('funciones:estado sin licencia multisucursal → común', fun.ok && fun.data.edicion === 'comun' && fun.data.multisucursal === false, JSON.stringify(fun));
    const lista = await invoke<Array<{ id: string; name: string; isMain: boolean; code: string }>>(handlers, 'branches:listar');
    check(
      'branches:listar → sólo "Casa central" (id fijo, principal)',
      lista.ok && lista.data.length === 1 && lista.data[0]?.id === SUCURSAL_CENTRAL_ID && lista.data[0]?.name === 'Casa central' && lista.data[0]?.isMain === true,
      JSON.stringify(lista),
    );
    const renComun = await invoke(handlers, 'branches:renombrar', { id: SUCURSAL_CENTRAL_ID, name: 'Coronda' });
    check('branches:renombrar con licencia común → BUSINESS_RULE', !renComun.ok && renComun.code === 'BUSINESS_RULE', JSON.stringify(renComun));

    // Licencia con edición multisucursal (se simula el estado: la lectura del token la cubre license.smoke).
    const getStateReal = licenseManager.getState.bind(licenseManager);
    licenseManager.getState = () => ({ ...getStateReal(), edicion: 'multisucursal' as const });
    try {
      const fun2 = await invoke<{ edicion: string; multisucursal: boolean }>(handlers, 'funciones:estado');
      check('funciones:estado con licencia multisucursal → multisucursal', fun2.ok && fun2.data.multisucursal === true && fun2.data.edicion === 'multisucursal', JSON.stringify(fun2));
      const ren = await invoke<{ name: string; code: string }>(handlers, 'branches:renombrar', { id: SUCURSAL_CENTRAL_ID, name: 'Casa central Coronda' });
      check('branches:renombrar con multisucursal + admin → ok', ren.ok && ren.data.name === 'Casa central Coronda' && ren.data.code === 'CENTRAL', JSON.stringify(ren));
      const audit = db.$client
        .prepare("SELECT description, area FROM audit_log WHERE channel = 'branches:renombrar' ORDER BY created_at DESC LIMIT 1")
        .get() as { description: string; area: string } | undefined;
      check('renombrar queda en la auditoría', !!audit && audit.description.includes('Casa central Coronda') && audit.area === 'Sucursales', JSON.stringify(audit));
      const vacio = await invoke(handlers, 'branches:renombrar', { id: SUCURSAL_CENTRAL_ID, name: '  ' });
      check('branches:renombrar con nombre vacío → VALIDATION', !vacio.ok && vacio.code === 'VALIDATION', JSON.stringify(vacio));

      // Un vendedor (sin permiso de configurar la empresa) no puede renombrar.
      const vend = await invoke<{ id: string }>(handlers, 'users:create', { username: 'vendsuc', password: 'vend1234', fullName: 'Vendedor Sucursal', role: 'seller' });
      check('users:create vendedor para probar permisos', vend.ok, JSON.stringify(vend));
      await invoke(handlers, 'auth:login', { username: 'vendsuc', password: 'vend1234' });
      const listaVend = await invoke<unknown[]>(handlers, 'branches:listar');
      check('branches:listar como vendedor → ok (lectura)', listaVend.ok && listaVend.data.length === 1, JSON.stringify(listaVend));
      const renVend = await invoke(handlers, 'branches:renombrar', { id: SUCURSAL_CENTRAL_ID, name: 'Otra' });
      check('branches:renombrar como vendedor → PERMISSION_DENIED', !renVend.ok && renVend.code === 'PERMISSION_DENIED', JSON.stringify(renVend));
    } finally {
      licenseManager.getState = getStateReal;
      await invoke(handlers, 'auth:login', { username: 'admin', password: 'admin36724776' });
    }

    // Ruteo: los datos de sucursales y la edición van al SERVIDOR; renombrar no se hace desde internet.
    check('funciones:estado viaja al servidor desde una terminal', shouldRouteLan('funciones:estado', 'client'));
    check('branches:listar viaja al servidor desde una terminal', shouldRouteLan('branches:listar', 'client'));
    check('branches:renombrar se acepta por la red local', lanServerAccepts('branches:renombrar'));
    check('branches:renombrar se RECHAZA por internet', !remotoAccepts('branches:renombrar'));
    check('branches:listar y funciones:estado sí por internet (lectura)', remotoAccepts('branches:listar') && remotoAccepts('funciones:estado'));
    check('license:* sigue siendo local de cada PC', !shouldRouteLan('license:getState', 'client'));
  }

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

  // articles:delete de un artículo CON ventas: no se borra, queda dado de baja.
  // Antes fallaba con "FOREIGN KEY constraint failed" (reportado por Bruno, 1-oct-2026).
  const delConVentas = await invoke<{ deleted: boolean; dadoDeBaja: boolean }>(handlers, 'articles:delete', { id: created.data.id });
  const trasBaja = await invoke<{ active: boolean } | null>(handlers, 'articles:get', { id: created.data.id });
  check(
    'articles:delete con ventas → queda dado de baja, sin error de FOREIGN KEY',
    delConVentas.ok && delConVentas.data.dadoDeBaja === true && delConVentas.data.deleted === false && trasBaja.ok && trasBaja.data?.active === false,
    JSON.stringify(delConVentas),
  );
  const reactivado = await invoke<{ active: boolean }>(handlers, 'articles:update', { id: created.data.id, data: { active: true } });
  check('articles:update reactiva el artículo dado de baja', reactivado.ok && reactivado.data.active === true, JSON.stringify(reactivado));
  // Sin historial: se borra de verdad.
  const sinHistorial = await invoke<{ id: string }>(handlers, 'articles:create', {
    barcode: '7790000099982',
    description: 'Artículo sin movimientos',
    listPrice1: '100.0000',
    stock: '1.000',
  });
  const delSinHistorial = sinHistorial.ok
    ? await invoke<{ deleted: boolean; dadoDeBaja: boolean }>(handlers, 'articles:delete', { id: sinHistorial.data.id })
    : sinHistorial;
  const yaNoEsta = sinHistorial.ok ? await invoke<unknown>(handlers, 'articles:get', { id: sinHistorial.data.id }) : null;
  check(
    'articles:delete sin movimientos → se borra de verdad',
    delSinHistorial.ok && (delSinHistorial.data as { deleted: boolean }).deleted === true && !!yaNoEsta && yaNoEsta.ok && yaNoEsta.data === null,
    JSON.stringify(delSinHistorial),
  );

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

  // ARTÍCULO RÁPIDO: línea sin artículo. Lo que hay que verificar es que se
  // cobre bien y que NO toque el inventario — si moviera stock habría que
  // inventar un artículo por venta, que es lo que dejó el catálogo de StockFácil
  // con 10.323 artículos fantasma.
  const stockAntesRapido = await invoke<{ stock: string } | null>(handlers, 'articles:get', { id: created.data.id });
  const ventaRapida = await invoke<{ sale: { total: string }; lines: Array<{ articleId: string | null; description: string | null }> }>(
    handlers,
    'sales:create',
    {
      type: 'B',
      customerId: cf.id,
      payments: [{ paymentMethodId: 'pm-efectivo', amount: '1500.0000' }],
      lines: [{ description: 'FLETE', quantity: '1.000', unitPrice: '1500.0000', vatRate: '21.00' }],
    },
  );
  check(
    'sales:create con ARTÍCULO RÁPIDO (sin articleId)',
    ventaRapida.ok &&
      ventaRapida.data.sale.total === '1500.0000' &&
      ventaRapida.data.lines[0]?.articleId === null &&
      ventaRapida.data.lines[0]?.description === 'FLETE',
    JSON.stringify(ventaRapida).slice(0, 220),
  );
  const stockDespuesRapido = await invoke<{ stock: string } | null>(handlers, 'articles:get', { id: created.data.id });
  check(
    'el artículo rápido NO tocó el stock',
    stockAntesRapido.ok && stockDespuesRapido.ok &&
      stockAntesRapido.data?.stock === stockDespuesRapido.data?.stock,
    `antes=${stockAntesRapido.ok ? stockAntesRapido.data?.stock : '?'} después=${stockDespuesRapido.ok ? stockDespuesRapido.data?.stock : '?'}`,
  );
  const rapidoSinDesc = await invoke(handlers, 'sales:create', {
    type: 'B',
    customerId: cf.id,
    payments: [{ paymentMethodId: 'pm-efectivo', amount: '100.0000' }],
    lines: [{ quantity: '1.000', unitPrice: '100.0000' }],
  });
  check(
    'artículo rápido SIN descripción es rechazado',
    !rapidoSinDesc.ok,
    JSON.stringify(rapidoSinDesc).slice(0, 160),
  );

  // COMPRAS Y PRECIOS — tres garantías:
  // 1) SIN actualizar precios, una compra con costo distinto NO toca nada
  //    (reporte de Peverelli 27-ago-2026: no se reprodujo, y esto lo garantiza).
  // 2) Modo 'margin' recalcula TODAS las listas con margen, redondeado a peso.
  // 3) Una lista sin margen no se toca.
  const artC = await invoke<{ id: string }>(handlers, 'articles:create', {
    barcode: 'COMPRA-1', description: 'ARTICULO COMPRA', costPrice: '1000.0000',
    listPrice1: '2000.0000', listPrice2: '2500.0000', listPrice3: '0.0000',
    wholesalePrice: '0.0000', wholesaleMinQty: '0.000', vatRate: '21.00',
    stock: '10.000', minStock: '0.000', idealStock: '0.000',
    soldByWeight: false, unit: 'UN', active: true,
    margin1: '35.00', margin2: '80.00', margin3: null,
  });
  const provC = await invoke<{ id: string }>(handlers, 'suppliers:create', { name: 'PROV COMPRA', code: 'PC1' });
  check('setup compra ok', artC.ok && provC.ok, '');

  if (artC.ok && provC.ok) {
    // (1) sin actualizar precios
  // Fondeo del cajón: la validación de fondos (insufficient_cash_daily) exige
  // efectivo real para los egresos en efectivo de las compras que siguen.
  await invoke(handlers, 'cash:addMovement', { type: 'income', description: 'Fondeo para compras del guión', amount: '9000.0000', paymentMethodId: 'pm-efectivo' });

    const c1 = await invoke(handlers, 'purchases:create', {
      type: 'X', supplierId: provC.data.id, isAccountPurchase: false, fundingSource: 'daily',
      updatePrices: false, payments: [{ paymentMethodId: 'pm-efectivo', amount: '1500.0000' }],
      lines: [{ articleId: artC.data.id, quantity: '1.000', costPrice: '1500.0000' }],
    });
    const a1 = await invoke<{ costPrice: string; listPrice1: string; listPrice2: string }>(handlers, 'articles:get', { id: artC.data.id });
    check(
      'compra SIN actualizar precios no toca costo ni listas',
      c1.ok && a1.ok && a1.data.costPrice === '1000.0000' && a1.data.listPrice1 === '2000.0000' && a1.data.listPrice2 === '2500.0000',
      a1.ok ? `costo=${a1.data.costPrice} l1=${a1.data.listPrice1} l2=${a1.data.listPrice2}` : JSON.stringify(a1),
    );

    // (2)+(3) modo margin: costo 1234 → l1 = 1234×1.35 = 1665.9 → 1666;
    // l2 = 1234×1.80 = 2221.2 → 2221; l3 sin margen → intacta en 0.
    const c2 = await invoke(handlers, 'purchases:create', {
      type: 'X', supplierId: provC.data.id, isAccountPurchase: false, fundingSource: 'daily',
      updatePrices: true, priceUpdateMode: 'margin',
      payments: [{ paymentMethodId: 'pm-efectivo', amount: '1234.0000' }],
      lines: [{ articleId: artC.data.id, quantity: '1.000', costPrice: '1234.0000' }],
    });
    const a2 = await invoke<{ costPrice: string; listPrice1: string; listPrice2: string; listPrice3: string }>(handlers, 'articles:get', { id: artC.data.id });
    check(
      'modo utilidad: recalcula listas con margen, redondeo a peso, y no toca la lista sin margen',
      c2.ok && a2.ok && a2.data.costPrice === '1234.0000' && a2.data.listPrice1 === '1666.0000' && a2.data.listPrice2 === '2221.0000' && a2.data.listPrice3 === '0.0000',
      a2.ok ? `costo=${a2.data.costPrice} l1=${a2.data.listPrice1} l2=${a2.data.listPrice2} l3=${a2.data.listPrice3}` : JSON.stringify(c2),
    );
  }

  // (4) En modo margin, un precio EDITADO EN PANTALLA le gana al cálculo:
  // el usuario puede pisar el redondeo y eso es lo que se guarda.
  if (artC.ok && provC.ok) {
    const c3 = await invoke(handlers, 'purchases:create', {
      type: 'X', supplierId: provC.data.id, isAccountPurchase: false, fundingSource: 'daily',
      updatePrices: true, priceUpdateMode: 'margin',
      payments: [{ paymentMethodId: 'pm-efectivo', amount: '1234.0000' }],
      lines: [{
        articleId: artC.data.id, quantity: '1.000', costPrice: '1234.0000',
        newListPrice1: '1700.0000',
      }],
    });
    const a3 = await invoke<{ listPrice1: string; listPrice2: string }>(handlers, 'articles:get', { id: artC.data.id });
    check(
      'modo utilidad: el precio pisado a mano le gana al cálculo (1700, no 1666)',
      c3.ok && a3.ok && a3.data.listPrice1 === '1700.0000' && a3.data.listPrice2 === '2221.0000',
      a3.ok ? `l1=${a3.data.listPrice1} l2=${a3.data.listPrice2}` : JSON.stringify(c3),
    );
  }

  // (5) '$0' NUNCA pisa un precio: un campo vaciado en un cliente viejo llega
  // como '0' y el servidor lo descarta (hallazgo de la revisión multi-agente:
  // sin este guard, la góndola quedaba en $0).
  if (artC.ok && provC.ok) {
    const c4 = await invoke(handlers, 'purchases:create', {
      type: 'X', supplierId: provC.data.id, isAccountPurchase: false, fundingSource: 'daily',
      updatePrices: true, priceUpdateMode: 'manual',
      payments: [{ paymentMethodId: 'pm-efectivo', amount: '500.0000' }],
      lines: [{
        articleId: artC.data.id, quantity: '1.000', costPrice: '500.0000',
        newListPrice1: '0', newListPrice2: '0.0000',
      }],
    });
    const a4 = await invoke<{ listPrice1: string; listPrice2: string }>(handlers, 'articles:get', { id: artC.data.id });
    check(
      "un precio '0' se descarta: la góndola no queda en cero",
      c4.ok && a4.ok && Number(a4.data.listPrice1) > 0 && Number(a4.data.listPrice2) > 0,
      a4.ok ? `l1=${a4.data.listPrice1} l2=${a4.data.listPrice2}` : JSON.stringify(c4),
    );
  }

  // (6) COMPRAS POR PROVEEDOR (Contabilidad): el listado por rango trae TODAS
  // las compras cargadas — B y C incluidas, no sólo las que van al Libro IVA —
  // de más de un proveedor, cada una con tipo, número del proveedor, estado e
  // importes. La pantalla agrupa y suma en el cliente sobre este contrato.
  if (artC.ok && provC.ok) {
    const provD = await invoke<{ id: string }>(handlers, 'suppliers:create', {
      name: 'PROV DOS', code: 'PC2', cuit: '30-71234567-1',
    });
    check('setup segundo proveedor ok', provD.ok, provD.ok ? '' : JSON.stringify(provD));
    const segundoProv = provD.ok ? provD.data.id : provC.data.id;
    // A cuenta del proveedor: no toca la caja, así el guión no depende del fondeo.
    const cB = await invoke<{ purchase: { id: string } }>(handlers, 'purchases:create', {
      type: 'B', supplierId: segundoProv, supplierInvoiceNumber: '0001-00000123',
      isAccountPurchase: true, updatePrices: false,
      lines: [{ articleId: artC.data.id, quantity: '1.000', costPrice: '300.0000' }],
    });
    const cC = await invoke<{ purchase: { id: string } }>(handlers, 'purchases:create', {
      type: 'C', supplierId: provC.data.id, supplierInvoiceNumber: '0002-00000777',
      isAccountPurchase: true, updatePrices: false,
      lines: [{ articleId: artC.data.id, quantity: '2.000', costPrice: '100.0000' }],
    });
    check('setup compras B y C ok', cB.ok && cC.ok, `${cB.ok ? '' : JSON.stringify(cB)} ${cC.ok ? '' : JSON.stringify(cC)}`.trim());

    const listado = await invoke<Array<{
      id: string; type: string; number: number; supplierId: string;
      supplierInvoiceNumber: string | null; status: string; total: string; vatAmount: string;
    }>>(handlers, 'purchases:listByDateRange', { from: Date.now() - 86_400_000, to: Date.now() + 86_400_000 });
    const tipos = new Set(listado.ok ? listado.data.map((p) => p.type) : []);
    const proveedores = new Set(listado.ok ? listado.data.map((p) => p.supplierId) : []);
    check(
      'purchases:listByDateRange trae todas las compras del rango (X, B y C) de más de un proveedor',
      listado.ok && tipos.has('X') && tipos.has('B') && tipos.has('C') && proveedores.size >= 2,
      listado.ok ? `tipos=${[...tipos].sort().join(',')} proveedores=${proveedores.size} compras=${listado.data.length}` : JSON.stringify(listado),
    );
    const fB = listado.ok && cB.ok ? listado.data.find((p) => p.id === cB.data.purchase.id) : undefined;
    const fC = listado.ok && cC.ok ? listado.data.find((p) => p.id === cC.data.purchase.id) : undefined;
    check(
      'cada compra viene con tipo, número del proveedor, estado e importes (neto = total − IVA ≥ 0)',
      !!fB && fB.type === 'B' && fB.supplierInvoiceNumber === '0001-00000123' && fB.status === 'completed' && fB.supplierId === segundoProv
        && Number(fB.total) > 0 && Number(fB.total) - Number(fB.vatAmount) >= 0
        && !!fC && fC.type === 'C' && fC.supplierInvoiceNumber === '0002-00000777' && fC.status === 'completed' && Number(fC.total) > 0,
      fB && fC ? `B n°${fB.number} ${fB.supplierInvoiceNumber} total=${fB.total} iva=${fB.vatAmount}; C n°${fC.number} ${fC.supplierInvoiceNumber} total=${fC.total}` : `fB=${JSON.stringify(fB)} fC=${JSON.stringify(fC)}`,
    );
  }

  // (7) FACTURAS EMITIDAS (Contabilidad): el listado de ventas por rango trae
  // TODOS los comprobantes de venta — A, B y X, de más de un cliente —, cada
  // uno con tipo, número interno, cliente, estado e importes; y la consulta de
  // comprobantes fiscales del rango responde (vacía: acá no hay ARCA). La
  // pantalla une ambas fuentes por venta y agrupa por cliente sobre este contrato.
  {
    const cliRI = await invoke<{ id: string }>(handlers, 'customers:create', {
      lastName: 'EMPRESA UNO SA', docType: 'CUIT', docNumber: '30712345671', category: 'RI',
    });
    check('setup cliente responsable inscripto ok', cliRI.ok, cliRI.ok ? '' : JSON.stringify(cliRI));
    const clienteRI = cliRI.ok ? cliRI.data.id : cf.id;
    const vA = await invoke<{ sale: { id: string; number: number } }>(handlers, 'sales:create', {
      type: 'A', customerId: clienteRI,
      payments: [{ paymentMethodId: 'pm-efectivo', amount: '1000.0000' }],
      lines: [{ description: 'SERVICIO TECNICO', quantity: '1.000', unitPrice: '1000.0000', vatRate: '21.00' }],
    });
    const vX = await invoke<{ sale: { id: string; number: number } }>(handlers, 'sales:create', {
      type: 'X', customerId: cf.id,
      payments: [{ paymentMethodId: 'pm-efectivo', amount: '250.0000' }],
      lines: [{ description: 'VARIOS', quantity: '1.000', unitPrice: '250.0000', vatRate: '21.00' }],
    });
    check('setup ventas A (cliente RI) y X (consumidor final) ok', vA.ok && vX.ok, `${vA.ok ? '' : JSON.stringify(vA)} ${vX.ok ? '' : JSON.stringify(vX)}`.trim());

    type VentaListada = {
      id: string; type: string; number: number; customerId: string;
      status: string; total: string; vatAmount: string; afipCAE: string | null;
    };
    const rango = { from: Date.now() - 86_400_000, to: Date.now() + 86_400_000 };
    const emitidas = await invoke<VentaListada[]>(handlers, 'sales:listByDateRange', rango);
    const tiposVenta = new Set(emitidas.ok ? emitidas.data.map((s) => s.type) : []);
    const clientesVenta = new Set(emitidas.ok ? emitidas.data.map((s) => s.customerId) : []);
    check(
      'sales:listByDateRange trae todos los comprobantes del rango (A, B y X) de más de un cliente',
      emitidas.ok && tiposVenta.has('A') && tiposVenta.has('B') && tiposVenta.has('X') && clientesVenta.size >= 2,
      emitidas.ok ? `tipos=${[...tiposVenta].sort().join(',')} clientes=${clientesVenta.size} ventas=${emitidas.data.length}` : JSON.stringify(emitidas),
    );
    const fA = emitidas.ok && vA.ok ? emitidas.data.find((s) => s.id === vA.data.sale.id) : undefined;
    const fX = emitidas.ok && vX.ok ? emitidas.data.find((s) => s.id === vX.data.sale.id) : undefined;
    check(
      'cada venta viene con tipo, número, cliente, estado e importes (neto = total − IVA ≥ 0)',
      !!fA && fA.type === 'A' && fA.number > 0 && fA.customerId === clienteRI && fA.status === 'completed'
        && fA.total === '1000.0000' && Number(fA.total) - Number(fA.vatAmount) >= 0
        && !!fX && fX.type === 'X' && fX.number > 0 && fX.customerId === cf.id && fX.status === 'completed' && fX.total === '250.0000',
      fA && fX ? `A n°${fA.number} total=${fA.total} iva=${fA.vatAmount}; X n°${fX.number} total=${fX.total}` : `fA=${JSON.stringify(fA)} fX=${JSON.stringify(fX)}`,
    );
    const vouchers = await invoke<unknown[]>(handlers, 'fiscal:listVouchers', rango);
    check(
      'fiscal:listVouchers del rango responde array (sin ARCA no hay comprobantes con CAE)',
      vouchers.ok && Array.isArray(vouchers.data) && vouchers.data.length === 0,
      vouchers.ok ? `len=${vouchers.data.length}` : JSON.stringify(vouchers),
    );
    // Una venta anulada sigue en el listado, marcada 'voided': la pantalla la
    // oculta salvo con "Incluir anuladas" y nunca la suma. Se anulan las dos
    // acá mismo para no alterar el conteo de sales:voidRange de abajo.
    const anulX = vX.ok ? await invoke(handlers, 'sales:void', { id: vX.data.sale.id, reason: 'Prueba de Facturas emitidas' }) : vX;
    const anulA = vA.ok ? await invoke(handlers, 'sales:void', { id: vA.data.sale.id, reason: 'Prueba de Facturas emitidas' }) : vA;
    const trasAnular = await invoke<VentaListada[]>(handlers, 'sales:listByDateRange', rango);
    const fXAnulada = trasAnular.ok && vX.ok ? trasAnular.data.find((s) => s.id === vX.data.sale.id) : undefined;
    check(
      'la venta anulada sigue en el listado con estado voided (la pantalla la tacha y no la suma)',
      anulX.ok && anulA.ok && !!fXAnulada && fXAnulada.status === 'voided' && fXAnulada.type === 'X',
      fXAnulada ? `status=${fXAnulada.status}` : JSON.stringify({ anulX, anulA }).slice(0, 200),
    );
  }

  // sales:voidRange — anulación en lote del día. Va AL FINAL a propósito: anula
  // la venta que usaron todos los checks anteriores, así que mover esto para
  // arriba los rompe. Lo que importa verificar es que no sea un borrado suelto:
  // tiene que devolver el stock igual que anulando a mano.
  const voidRange = await invoke<{ anuladas: number; conCAE: number; omitidas: unknown[] }>(
    handlers,
    'sales:voidRange',
    { from: Date.now() - 86_400_000, to: Date.now() + 86_400_000 },
  );
  check(
    'sales:voidRange anula las ventas del rango',
    voidRange.ok && voidRange.data.anuladas === 2 && voidRange.data.conCAE === 0 && voidRange.data.omitidas.length === 0,
    JSON.stringify(voidRange),
  );
  const stockTrasAnular = await invoke<{ stock: string } | null>(handlers, 'articles:get', { id: created.data.id });
  check(
    'sales:voidRange devolvió el stock (18 → 20)',
    stockTrasAnular.ok && stockTrasAnular.data?.stock === '20.000',
    stockTrasAnular.ok ? `stock=${stockTrasAnular.data?.stock}` : JSON.stringify(stockTrasAnular),
  );
  const voidRangeVacio = await invoke<{ anuladas: number }>(handlers, 'sales:voidRange', {
    from: Date.now() - 86_400_000,
    to: Date.now() + 86_400_000,
  });
  check(
    'sales:voidRange sobre ventas ya anuladas no las vuelve a tocar',
    voidRangeVacio.ok && voidRangeVacio.data.anuladas === 0,
    JSON.stringify(voidRangeVacio),
  );

  // --- EDICIÓN MULTISUCURSAL (VERSIÓN DE PRUEBA): interruptor local de la PC con la base ---
  // Sólo existe con una versión -alpha/-beta/-rc; en una final la casilla no
  // está y el archivo no cuenta. Va al final porque usa la caja abierta de arriba.
  {
    console.log('\n[edición de prueba]');
    const archivo = join(tmpDir, ARCHIVO_EDICION_PRUEBA);
    const cajaServidorId = cashOpen.ok ? cashOpen.data.id : '';
    const depsBase = { db, repos, sessionStore, machineId: 'test-machine', dbPath, userDataDir: tmpDir, hardware, backup, importService };
    const abiertas = (): Array<{ id: string; terminal_id: string | null }> =>
      db.$client.prepare("SELECT id, terminal_id FROM cash_registers WHERE status = 'open'").all() as Array<{ id: string; terminal_id: string | null }>;

    // Versión FINAL (1.13.0): el canal contesta "no disponible" aunque el archivo exista.
    writeFileSync(archivo, JSON.stringify({ edicion: 'multisucursal', activadaEl: Date.now() }));
    const lmFinal = new LicenseManager({ userDataDir: tmpDir, machineId: 'test-machine', apiUrl: 'http://localhost:1', publicKeyPem: '', version: '1.13.0' });
    const hFinal = buildAllHandlers({ ...depsBase, licenseManager: lmFinal, appVersion: '1.13.0', emit: () => {} });
    const epFinal = await invoke<EdicionPruebaDTO>(hFinal, 'funciones:edicionPrueba');
    check('versión final: funciones:edicionPrueba → disponible false aunque exista el archivo', epFinal.ok && epFinal.data.disponible === false && epFinal.data.activa === false, JSON.stringify(epFinal));
    const estFinal = await invoke<{ edicion: string }>(hFinal, 'funciones:estado');
    check('versión final: el archivo no cambia la edición (común)', estFinal.ok && estFinal.data.edicion === 'comun', JSON.stringify(estFinal));
    const setFinal = await invoke(hFinal, 'funciones:setEdicionPrueba', { activa: true });
    check('versión final: funciones:setEdicionPrueba → BUSINESS_RULE (la edición la define la licencia)', !setFinal.ok && setFinal.code === 'BUSINESS_RULE' && /licencia/.test(setFinal.message), JSON.stringify(setFinal));
    rmSync(archivo);

    // Versión DE PRUEBA (1.13.0-beta.1): misma base y misma sesión, otro LicenseManager.
    const emitidos: string[] = [];
    const lmBeta = new LicenseManager({ userDataDir: tmpDir, machineId: 'test-machine', apiUrl: 'http://localhost:1', publicKeyPem: '', version: '1.13.0-beta.1' });
    const hBeta = buildAllHandlers({ ...depsBase, licenseManager: lmBeta, appVersion: '1.13.0-beta.1', emit: (ch) => { emitidos.push(ch); } });
    const ep0 = await invoke<EdicionPruebaDTO>(hBeta, 'funciones:edicionPrueba');
    check('versión de prueba: disponible, apagado, edicionReal común y la versión', ep0.ok && ep0.data.disponible && !ep0.data.activa && ep0.data.edicionReal === 'comun' && ep0.data.version === '1.13.0-beta.1', JSON.stringify(ep0));
    const codAntes = await invoke(hBeta, 'lan:emparejarGenerarCodigo');
    check('apagado: no se generan códigos de emparejamiento', !codAntes.ok && /Multisucursal/.test(codAntes.ok ? '' : codAntes.message), JSON.stringify(codAntes));
    const antes = abiertas();
    check('la caja abierta del servidor tiene su id (caja por PC apagada)', antes.length === 1 && antes[0]?.terminal_id === 'test-machine', JSON.stringify(antes));

    const on = await invoke<EdicionPruebaDTO>(hBeta, 'funciones:setEdicionPrueba', { activa: true });
    check('admin activa la casilla → activa, con activadaEl', on.ok && on.data.activa && typeof on.data.activadaEl === 'number', JSON.stringify(on));
    const guardado = existsSync(archivo) ? (JSON.parse(readFileSync(archivo, 'utf8')) as { edicion?: string; activadaEl?: number }) : null;
    check('queda userData/edicion-prueba.json {edicion: multisucursal, activadaEl}', guardado?.edicion === 'multisucursal' && typeof guardado.activadaEl === 'number', JSON.stringify(guardado));
    check('se emite license:changed (la interfaz refresca sin reiniciar)', emitidos.includes('license:changed'), emitidos.join(','));
    const est1 = await invoke<{ edicion: string; multisucursal: boolean; cajaPorPc?: boolean }>(hBeta, 'funciones:estado');
    check('funciones:estado → multisucursal y caja por PC forzada', est1.ok && est1.data.multisucursal && est1.data.edicion === 'multisucursal' && est1.data.cajaPorPc === true, JSON.stringify(est1));
    check('tieneMultisucursal(deps) lo refleja', tieneMultisucursal({ licenseManager: lmBeta }));
    const cod = await invoke<{ codigo: string }>(hBeta, 'lan:emparejarGenerarCodigo');
    check('encendido: se generan códigos de emparejamiento con los MISMOS handlers (sin reiniciar)', cod.ok && /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(cod.data.codigo), JSON.stringify(cod));
    const despues = abiertas();
    check('la caja abierta del servidor pasó a compartida (terminal_id NULL), como al prender la caja por PC', despues.length === 1 && despues[0]?.terminal_id === null, JSON.stringify(despues));
    const cur = await invoke<{ id: string } | null>(hBeta, 'cash:getCurrent');
    check('cash:getCurrent sigue encontrando esa caja', cur.ok && cur.data?.id === cajaServidorId, JSON.stringify(cur));
    const aud = db.$client
      .prepare("SELECT description, area FROM audit_log WHERE channel = 'funciones:setEdicionPrueba' ORDER BY created_at DESC LIMIT 1")
      .get() as { description: string; area: string } | undefined;
    check('queda en la auditoría (área Licencia)', !!aud && /activada/.test(aud.description) && aud.area === 'Licencia', JSON.stringify(aud));
    const onDeNuevo = await invoke<EdicionPruebaDTO>(hBeta, 'funciones:setEdicionPrueba', { activa: true });
    check('activar dos veces no cambia nada', onDeNuevo.ok && onDeNuevo.data.activa, JSON.stringify(onDeNuevo));

    // Otra PC abre su caja → la casilla no se puede apagar hasta que la cierre.
    const cierreServidor = await invoke(hBeta, 'cash:close', { registerId: cajaServidorId, closingAmount: '1000.0000' });
    check('el servidor cierra la caja compartida', cierreServidor.ok, JSON.stringify(cierreServidor).slice(0, 160));
    const otraPc = { id: 'otra-pc-0000000000000000', nombre: 'Otra PC', origen: 'lan' as const, dispositivoId: null, identificada: true };
    const abreOtra = await correrComoTerminal(otraPc, () => invoke<{ id: string }>(hBeta, 'cash:open', { openingAmount: '0.0000' }));
    check('otra PC abre su propia caja con la casilla encendida', abreOtra.ok, JSON.stringify(abreOtra).slice(0, 160));
    const offMal = await invoke(hBeta, 'funciones:setEdicionPrueba', { activa: false });
    check('con cajas abiertas de otras PC no se apaga (VALIDATION, manda al Historial de cajas)', !offMal.ok && offMal.code === 'VALIDATION' && /Historial de cajas/.test(offMal.message), JSON.stringify(offMal));
    // Un vendedor no la toca (sí la ve).
    await invoke(hBeta, 'auth:login', { username: 'vendsuc', password: 'vend1234' });
    const offVend = await invoke(hBeta, 'funciones:setEdicionPrueba', { activa: false });
    check('vendedor: funciones:setEdicionPrueba → PERMISSION_DENIED', !offVend.ok && offVend.code === 'PERMISSION_DENIED', JSON.stringify(offVend));
    const epVend = await invoke<EdicionPruebaDTO>(hBeta, 'funciones:edicionPrueba');
    check('vendedor: funciones:edicionPrueba → lectura ok', epVend.ok && epVend.data.activa === true, JSON.stringify(epVend));
    await invoke(hBeta, 'auth:login', { username: 'admin', password: 'admin36724776' });
    if (abreOtra.ok) {
      const cierraOtra = await correrComoTerminal(otraPc, () => invoke(hBeta, 'cash:close', { registerId: abreOtra.data.id, closingAmount: '0.0000' }));
      check('la otra PC cierra su caja', cierraOtra.ok, JSON.stringify(cierraOtra).slice(0, 160));
    }
    const off = await invoke<EdicionPruebaDTO>(hBeta, 'funciones:setEdicionPrueba', { activa: false });
    check('admin apaga la casilla → común y el archivo se borra', off.ok && !off.data.activa && !existsSync(archivo), JSON.stringify(off));
    const est2 = await invoke<{ edicion: string; cajaPorPc?: boolean }>(hBeta, 'funciones:estado');
    check('funciones:estado vuelve a común (y la caja por PC a la opción del comercio: apagada)', est2.ok && est2.data.edicion === 'comun' && est2.data.cajaPorPc === false, JSON.stringify(est2));
    const codDespues = await invoke(hBeta, 'lan:emparejarGenerarCodigo');
    check('apagado de nuevo: no se generan códigos', !codDespues.ok, JSON.stringify(codDespues).slice(0, 120));

    // Ruteo: es de la PC que tiene la base; ni la red local ni internet.
    check('funciones:setEdicionPrueba se RECHAZA por la red local y por internet', !lanServerAccepts('funciones:setEdicionPrueba') && !remotoAccepts('funciones:setEdicionPrueba'));
    check('funciones:edicionPrueba también (una terminal no lo necesita)', !lanServerAccepts('funciones:edicionPrueba') && !remotoAccepts('funciones:edicionPrueba'));
    check('funciones:estado sigue cruzando la red (la terminal pregunta la edición al servidor)', lanServerAccepts('funciones:estado') && remotoAccepts('funciones:estado'));
  }

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
