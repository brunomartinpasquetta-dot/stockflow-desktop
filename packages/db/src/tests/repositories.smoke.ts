/**
 * Smoke test de la capa de repositorios (sin framework — ejecutable con `tsx`).
 *
 *   pnpm --filter @stockflow/db test:smoke:repos
 *
 * Inicializa una DB temporal, arma los repositorios con `createRepositories`,
 * ejercita los flujos principales (artículos, clientes + validación Zod, ventas
 * con líneas, caja) y limpia los archivos al terminar. Sale con código 1 si algo falla.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConstraintError,
  ValidationError,
  closeLocalDb,
  createRepositories,
  initLocalDb,
} from '../index';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}
async function expectThrows(
  label: string,
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    check(label, false, 'no lanzó ningún error');
  } catch (err) {
    check(label, predicate(err), err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-repos-smoke-'));
const dbPath = join(tmpDir, 'stockflow.db');
console.log(`\nSmoke test (repositorios) — DB temporal: ${dbPath}\n`);

async function main(): Promise<void> {
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);

  // --- contexto base (seed) -------------------------------------------
  const admin = await repos.users.findByUsername('admin');
  check('seed: usuario admin presente', !!admin, admin?.id);
  const cf = await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
  check('seed: cliente CONSUMIDOR FINAL presente', !!cf, cf?.id);
  if (!admin || !cf) throw new Error('Faltan datos del seed');

  // --- articles --------------------------------------------------------
  console.log('\n[articles]');
  const art = await repos.articles.create({
    barcode: '7790000000017',
    description: 'Gaseosa cola 2.25L',
    brand: 'ColaTest',
    listPrice1: '850.0000',
    costPrice: '600.0000',
    stock: '10.000',
    minStock: '3.000',
    vatRate: '21.00',
    unit: 'UN',
  });
  check('articles.create', !!art.id && art.barcode === '7790000000017', `stock=${art.stock}`);

  const byBarcode = await repos.articles.findByBarcode('7790000000017');
  check('articles.findByBarcode', byBarcode?.id === art.id);

  await repos.articles.incrementStock(art.id, '5.000');
  const afterInc = await repos.articles.findById(art.id);
  check('articles.incrementStock', afterInc?.stock === '15.000', `stock=${afterInc?.stock}`);

  await repos.articles.decrementStock(art.id, '4.000');
  const afterDec = await repos.articles.findById(art.id);
  check('articles.decrementStock', afterDec?.stock === '11.000', `stock=${afterDec?.stock}`);

  await expectThrows(
    'articles.decrementStock con stock insuficiente lanza ConstraintError',
    () => repos.articles.decrementStock(art.id, '999.000'),
    (e) => e instanceof ConstraintError,
  );

  // artículo de baja rotación para low stock
  const lowArt = await repos.articles.create({
    barcode: '7790000000024',
    description: 'Producto escaso',
    stock: '1.000',
    minStock: '5.000',
  });
  const low = await repos.articles.findLowStock();
  check(
    'articles.findLowStock',
    low.some((a) => a.id === lowArt.id) && !low.some((a) => a.id === art.id),
    `detectados: ${low.length}`,
  );

  const search = await repos.articles.searchByText('cola');
  check('articles.searchByText', search.some((a) => a.id === art.id));

  await expectThrows(
    'articles.create con barcode duplicado lanza ConstraintError',
    () => repos.articles.create({ barcode: '7790000000017', description: 'dup' }),
    (e) => e instanceof ConstraintError,
  );

  // --- customers + validación Zod -------------------------------------
  console.log('\n[customers]');
  const cust = await repos.customers.create({
    lastName: 'PEREZ',
    firstName: 'Juan',
    category: 'RI',
    docType: 'CUIT',
    docNumber: '20-12345678-6', // CUIT con dígito verificador válido
  });
  check('customers.create (CUIT válido)', !!cust.id, `docNumber=${cust.docNumber}`);

  const found = await repos.customers.searchByText('erez');
  check('customers.searchByText', found.some((c) => c.id === cust.id));

  const byDoc = await repos.customers.findByDocNumber('20-12345678-6');
  check('customers.findByDocNumber', byDoc?.id === cust.id);

  await expectThrows(
    'customers.create con CUIT inválido lanza ValidationError',
    () => repos.customers.create({ lastName: 'X', category: 'RI', docType: 'CUIT', docNumber: '20123456789' }),
    (e) => e instanceof ValidationError,
  );
  await expectThrows(
    'customers.create con DNI inválido lanza ValidationError',
    () => repos.customers.create({ lastName: 'Y', category: 'CF', docType: 'DNI', docNumber: 'abc' }),
    (e) => e instanceof ValidationError,
  );

  // --- cash register + sales ------------------------------------------
  console.log('\n[cashRegisters + sales]');
  const reg = await repos.cashRegisters.openRegister({ openingAmount: '1000.0000', userId: admin.id });
  check('cashRegisters.openRegister', reg.status === 'open', `number=${reg.number}`);
  const current = await repos.cashRegisters.getCurrentOpen();
  check('cashRegisters.getCurrentOpen', current?.id === reg.id);
  await expectThrows(
    'cashRegisters.openRegister con caja abierta lanza ConstraintError',
    () => repos.cashRegisters.openRegister({ openingAmount: '0.0000', userId: admin.id }),
    (e) => e instanceof ConstraintError,
  );

  const stockBefore = (await repos.articles.findById(art.id))!.stock;
  const { sale, lines } = await repos.sales.createWithLines({
    type: 'B',
    customerId: cf.id,
    sellerId: admin.id,
    cashRegisterId: reg.id,
    paymentType: 'cash',
    lines: [
      { articleId: art.id, quantity: '2.000', unitPrice: '850.0000', vatRate: '21.00' },
      { articleId: lowArt.id, quantity: '1.000', unitPrice: '100.0000', vatRate: '21.00' },
    ],
  });
  check('sales.createWithLines crea la venta', !!sale.id && sale.number === 1, `total=${sale.total}`);
  check('sales.createWithLines crea 2 líneas', lines.length === 2);
  check('sales.createWithLines total correcto', sale.total === '1800.0000', `total=${sale.total}`);

  const stockAfter = (await repos.articles.findById(art.id))!.stock;
  check(
    'sales.createWithLines descuenta stock',
    Number(stockBefore) - Number(stockAfter) === 2,
    `${stockBefore} -> ${stockAfter}`,
  );

  const movs = await repos.cashMovements.findByRegister(reg.id);
  const income = movs.find((m) => m.relatedSaleId === sale.id);
  check(
    'sales.createWithLines genera cashMovement de ingreso',
    !!income && income.type === 'income' && income.amount === '1800.0000',
    income ? `amount=${income.amount}` : '',
  );

  const nextNum = await repos.sales.getNextNumber('B');
  check('sales.getNextNumber', nextNum === 2, `next=${nextNum}`);

  // anulación
  const voided = await repos.sales.voidSale(sale.id);
  check('sales.voidSale marca voided', voided.status === 'voided');
  const stockRestored = (await repos.articles.findById(art.id))!.stock;
  check('sales.voidSale restaura stock', stockRestored === stockBefore, `stock=${stockRestored}`);

  await expectThrows(
    'sales.createWithLines con stock insuficiente revierte y lanza ConstraintError',
    () =>
      repos.sales.createWithLines({
        type: 'B',
        customerId: cf.id,
        sellerId: admin.id,
        cashRegisterId: reg.id,
        paymentType: 'cash',
        lines: [{ articleId: art.id, quantity: '99999.000', unitPrice: '1.0000' }],
      }),
    (e) => e instanceof ConstraintError,
  );
  // el artículo no debe haber cambiado tras el rollback
  const stockAfterRollback = (await repos.articles.findById(art.id))!.stock;
  check('sales.createWithLines rollback no toca stock', stockAfterRollback === stockRestored);

  // cierre de caja
  const closed = await repos.cashRegisters.closeRegister(reg.id, { closingAmount: '1000.0000' });
  check(
    'cashRegisters.closeRegister',
    closed.status === 'closed' && typeof closed.notes === 'string' && closed.notes!.includes('Diferencia'),
    closed.notes ?? '',
  );

  // --- company ---------------------------------------------------------
  console.log('\n[company]');
  const company1 = await repos.company.getOrCreate();
  const company2 = await repos.company.getOrCreate();
  check('company.getOrCreate idempotente', company1.id === company2.id, company1.name);

  closeLocalDb(db);
}

main()
  .catch((err) => {
    console.error('\n✗ Excepción durante el smoke test:', err);
    failures++;
  })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
    if (failures > 0) {
      console.error(`\nSMOKE TEST (repositorios) FALLÓ — ${failures} check(s) con error.\n`);
      process.exit(1);
    }
    console.log('\nSMOKE TEST (repositorios) OK ✅\n');
  });
