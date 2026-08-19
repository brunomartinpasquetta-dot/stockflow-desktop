/**
 * Carga la base LOCAL con movimientos de todo tipo, para probar a mano.
 *
 *   cd apps/desktop
 *   ELECTRON_RUN_AS_NODE=1 npx electron <tsx/dist/cli.mjs> scripts/seed-local.ts
 *
 * (better-sqlite3 está compilado para Electron; con el node del sistema falla.)
 *
 * Va por los HANDLERS IPC, no por SQL: así stock, caja, cuentas corrientes y
 * saldos los calculan las mismas reglas que usa la app. Sembrar por SQL directo
 * deja números que no cierran y hace perder la tarde buscando un bug que no
 * existe.
 *
 * Las FECHAS se corren después por SQL, porque los servicios sellan
 * `Date.now()` y para mirar "cuánto entró por transferencia" hacen falta varios
 * días distintos.
 *
 * Todo lo que crea se llama PRUEBA / SEED, para poder distinguirlo.
 */
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { BackupService } from '../electron/backup/BackupService';
import { HardwareManager } from '../electron/hardware/HardwareManager';
import { ExcelImportService } from '../electron/import/ExcelImportService';
import { LicenseManager } from '../electron/license/LicenseManager';
import { buildAllHandlers } from '../electron/ipc/index';
import { SessionStore } from '../electron/ipc/session-store';
import type { HandlerMap } from '../electron/ipc/handler-context';
import type { IpcResponse } from '../electron/ipc/types';

const USER_DATA = join(process.env.HOME ?? '', 'Library/Application Support/@stockflow/desktop');
const DB_PATH = join(USER_DATA, 'stockflow.db');
const DIA = 86_400_000;

const PM = {
  efectivo: 'pm-efectivo',
  transferencia: 'pm-transferencia',
  credito: 'pm-tarjeta-credito',
  debito: 'pm-tarjeta-debito',
} as const;

async function call<T = any>(h: HandlerMap, ch: string, p?: unknown): Promise<T> {
  const fn = h[ch];
  if (!fn) throw new Error(`canal inexistente: ${ch}`);
  const r = (await fn(p)) as IpcResponse<T>;
  if (!r.ok) throw new Error(`${ch} → ${(r as any).code}: ${(r as any).message}`);
  return (r as any).data as T;
}

/** Total de una venta con precios CON IVA incluido (priceMode 'gross'). */
const total = (lineas: { quantity: string; unitPrice: string }[]): string =>
  lineas.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0).toFixed(4);

process.env.STOCKFLOW_SESSION_SECRET = 'seed-local';

async function main(): Promise<void> {
  const { db } = initLocalDb(DB_PATH);
  const repos = createRepositories(db);
  const handlers = buildAllHandlers({
    db,
    repos,
    sessionStore: new SessionStore(),
    machineId: 'seed',
    appVersion: '0.0.0-seed',
    dbPath: DB_PATH,
    userDataDir: USER_DATA,
    licenseManager: new LicenseManager({
      userDataDir: USER_DATA, machineId: 'seed', apiUrl: 'http://localhost:1', publicKeyPem: '',
    }),
    hardware: new HardwareManager({ userDataDir: USER_DATA }),
    backup: new BackupService({ dbPath: DB_PATH, backupDir: USER_DATA, appVersion: '0.0.0-seed' }),
    importService: new ExcelImportService(),
    emit: () => { /* noop */ },
  });
  const h = handlers;

  await call(h, 'auth:login', { username: 'admin', password: 'admin' });

  // ── Artículos con las TRES listas cargadas (para probar el cambio de lista).
  const catalogo = [
    { barcode: 'SEED-001', description: 'RESMA A4 75g', l1: '8500', l2: '9200', l3: '10500' },
    { barcode: 'SEED-002', description: 'BIROME AZUL', l1: '450', l2: '520', l3: '600' },
    { barcode: 'SEED-003', description: 'CUADERNO 48 HOJAS', l1: '2300', l2: '2600', l3: '3000' },
    { barcode: 'SEED-004', description: 'CARTUCHO NEGRO', l1: '18500', l2: '19900', l3: '22000' },
    { barcode: 'SEED-005', description: 'CINTA ADHESIVA', l1: '890', l2: '990', l3: '1150' },
  ];
  const existentes = await call<any[]>(h, 'articles:list');
  const arts: { id: string; l1: string; l2: string; l3: string; description: string }[] = [];
  for (const c of catalogo) {
    const ya = existentes.find((a) => a.barcode === c.barcode);
    if (ya) { arts.push({ id: ya.id, l1: c.l1, l2: c.l2, l3: c.l3, description: c.description }); continue; }
    const a = await call<{ id: string }>(h, 'articles:create', {
      barcode: c.barcode, description: c.description, brand: 'PRUEBA',
      costPrice: '0.0000', listPrice1: c.l1, listPrice2: c.l2, listPrice3: c.l3,
      wholesalePrice: '0.0000', wholesaleMinQty: '0.000', vatRate: '21.00',
      stock: '500.000', minStock: '5.000', idealStock: '0.000',
      soldByWeight: false, unit: 'UN', active: true,
    });
    arts.push({ id: a.id, l1: c.l1, l2: c.l2, l3: c.l3, description: c.description });
  }

  // ── Clientes.
  const clientes = await call<any[]>(h, 'customers:list');
  const cf = clientes.find((c) => c.lastName === 'CONSUMIDOR FINAL');
  if (!cf) throw new Error('falta el cliente CONSUMIDOR FINAL');
  async function cliente(lastName: string, category: string, docType: string, docNumber: string) {
    const ya = clientes.find((c: any) => c.lastName === lastName);
    if (ya) return ya;
    return call<any>(h, 'customers:create', {
      lastName, firstName: null, category, docType, docNumber,
      priceList: 1, creditLimit: '0.0000',
      address: 'Belgrano 450', city: 'Coronda', phone: '3424111111', mobile: '3424111111',
      email: null, facebook: null,
    });
  }
  const ctaA = await cliente('PRUEBA CUENTA UNO', 'CF', 'DNI', '25123456');
  const ctaB = await cliente('PRUEBA CUENTA DOS', 'RI', 'CUIT', '30712345671');

  const cajas: string[] = [];
  let ventas = 0;

  // ── Tres jornadas.
  for (let dia = 2; dia >= 0; dia--) {
    const abierta = await call<any>(h, 'cash:getCurrent');
    if (abierta) {
      const rep = await call<any>(h, 'cash:getReport', { registerId: abierta.id });
      await call(h, 'cash:close', { registerId: abierta.id, closingAmount: rep.expectedCash, notes: 'cierre previo (seed)' });
    }
    const caja = await call<any>(h, 'cash:open', { openingAmount: '20000.0000' });
    cajas.push(caja.id);

    // Ventas de contado, una por forma de pago y por lista de precios.
    const combos = [
      { medio: PM.efectivo, lista: 'l1' as const, qty: '2.000', art: 0 },
      { medio: PM.transferencia, lista: 'l1' as const, qty: '1.000', art: 3 },
      { medio: PM.transferencia, lista: 'l2' as const, qty: '3.000', art: 1 },
      { medio: PM.credito, lista: 'l3' as const, qty: '1.000', art: 2 },
      { medio: PM.debito, lista: 'l1' as const, qty: '4.000', art: 4 },
    ];
    for (const c of combos) {
      const a = arts[c.art]!;
      const lineas = [{ articleId: a.id, quantity: c.qty, unitPrice: a[c.lista] }];
      await call(h, 'sales:create', {
        type: 'X', customerId: cf.id,
        payments: [{ paymentMethodId: c.medio, amount: total(lineas) }],
        lines: lineas,
      });
      ventas++;
    }

    // Venta con pago MIXTO (efectivo + transferencia).
    const mix = [{ articleId: arts[0]!.id, quantity: '5.000', unitPrice: arts[0]!.l1 }];
    const mixTotal = Number(total(mix));
    await call(h, 'sales:create', {
      type: 'X', customerId: cf.id,
      payments: [
        { paymentMethodId: PM.efectivo, amount: (mixTotal / 2).toFixed(4) },
        { paymentMethodId: PM.transferencia, amount: (mixTotal - mixTotal / 2).toFixed(4) },
      ],
      lines: mix,
    });
    ventas++;

    // Venta con ARTÍCULO RÁPIDO (línea sin artículo del catálogo).
    await call(h, 'sales:create', {
      type: 'X', customerId: cf.id,
      payments: [{ paymentMethodId: PM.efectivo, amount: '7500.0000' }],
      lines: [{ description: 'FLETE A DOMICILIO', quantity: '1.000', unitPrice: '7500.0000', vatRate: '21.00' }],
    });
    ventas++;

    // Dos ventas A CUENTA CORRIENTE, con varios artículos (para el resumen).
    for (const cli of [ctaA, ctaB]) {
      const lineas = [
        { articleId: arts[0]!.id, quantity: '3.000', unitPrice: arts[0]!.l1 },
        { articleId: arts[2]!.id, quantity: '2.000', unitPrice: arts[2]!.l1 },
        { articleId: arts[4]!.id, quantity: '6.000', unitPrice: arts[4]!.l1 },
      ];
      await call(h, 'sales:create', {
        type: 'X', customerId: cli.id, isAccountSale: true, lines: lineas,
      });
      ventas++;
    }

    // Movimientos sueltos de caja.
    await call(h, 'cash:addMovement', {
      cashRegisterId: caja.id, type: 'income', amount: '5000.0000',
      description: 'Aporte de socio (prueba)', paymentMethodId: PM.efectivo,
    });
    await call(h, 'cash:addMovement', {
      cashRegisterId: caja.id, type: 'expense', amount: '3200.0000',
      description: 'Flete proveedor (prueba)', paymentMethodId: PM.efectivo,
    });

    // La caja de hoy queda ABIERTA; las anteriores cerradas.
    if (dia > 0) {
      const rep = await call<any>(h, 'cash:getReport', { registerId: caja.id });
      await call(h, 'cash:close', { registerId: caja.id, closingAmount: rep.expectedCash, notes: 'cierre de prueba' });
    }
  }

  // ── Cobranzas parciales, para que el resumen tenga Debe y Haber.
  for (const cli of [ctaA, ctaB]) {
    const cuentas = await call<any[]>(h, 'accounts:listOpenByCustomer', { customerId: cli.id });
    const abierta = cuentas.find((c) => Number(c.balance) > 0);
    if (!abierta) continue;
    // Cobranza PARCIAL: deja saldo pendiente, que es lo que se quiere mirar.
    const parcial = (Number(abierta.balance) / 3).toFixed(4);
    await call(h, 'accounts:receivePayment', {
      accountId: abierta.id,
      payments: [{ paymentMethodId: PM.transferencia, amount: parcial }],
    });
  }

  closeLocalDb(db);

  // ── Correr las fechas hacia atrás: una jornada por día.
  const raw = new Database(DB_PATH);
  cajas.forEach((id, idx) => {
    const desfase = (cajas.length - 1 - idx) * DIA;
    if (desfase === 0) return;
    raw.prepare('UPDATE cash_registers SET open_date = open_date - ?, close_date = CASE WHEN close_date IS NULL THEN NULL ELSE close_date - ? END WHERE id = ?').run(desfase, desfase, id);
    raw.prepare('UPDATE cash_movements SET date = date - ? WHERE cash_register_id = ?').run(desfase, id);
    raw.prepare('UPDATE sales SET date = date - ? WHERE cash_register_id = ?').run(desfase, id);
  });
  const r = raw.prepare(`
    SELECT (SELECT COUNT(*) FROM sales) ventas,
           (SELECT COUNT(*) FROM cash_registers) cajas,
           (SELECT COUNT(*) FROM cash_movements) movimientos,
           (SELECT COUNT(*) FROM accounts_receivable) cuentas,
           (SELECT COUNT(*) FROM sale_lines WHERE article_id IS NULL) rapidos`).get();
  raw.close();

  console.log(`\nCargado: ${ventas} ventas nuevas en ${cajas.length} jornadas.`);
  console.log('Total en la base:', r);
}

main().catch((e) => { console.error('SEED FALLÓ:', e); process.exit(1); });
