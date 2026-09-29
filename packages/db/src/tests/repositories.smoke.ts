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

  // --- utilidad desde los precios actuales -----------------------------
  // Un comercio migrado entra con precios y sin utilidad. La carga masiva
  // tiene que ser el inverso EXACTO de la fórmula de las compras
  // (precio = costo × (1 + m/100), redondeado a peso), respetar lo que el
  // comercio ya cargó a mano y saltear lo que no tiene costo.
  {
    const precioPorMargen = (costo: string, m: string): number => Math.round(Number(costo) * (1 + Number(m) / 100));
    const conMargen = await repos.articles.create({
      barcode: '7799000000011', description: 'Ya tiene utilidad cargada', costPrice: '1000.0000',
      listPrice1: '1500.0000', listPrice2: '1400.0000', margin1: '33.00', vatRate: '21.00', unit: 'UN',
    });
    const sinCosto = await repos.articles.create({
      barcode: '7799000000028', description: 'Sin costo', costPrice: '0.0000', listPrice1: '900.0000', vatRate: '21.00', unit: 'UN',
    });
    const r1 = await repos.articles.recalcularMargenesDesdePrecios({ soloVacios: true });
    const a1 = await repos.articles.findById(art.id);
    const a2 = await repos.articles.findById(conMargen.id);
    const a3 = await repos.articles.findById(sinCosto.id);
    check(
      'recalcularMargenes: 600 → 850 da 41.67% y la lista 1 se reproduce redondeada',
      a1?.margin1 === '41.67' && precioPorMargen('600.0000', a1?.margin1 ?? '0') === 850,
      `margin1=${a1?.margin1}`,
    );
    check('recalcularMargenes: las listas sin precio quedan sin utilidad', a1?.margin2 == null && a1?.margin3 == null, `m2=${a1?.margin2} m3=${a1?.margin3}`);
    check(
      'recalcularMargenes (soloVacios): respeta la utilidad cargada a mano y completa la que falta',
      a2?.margin1 === '33.00' && a2?.margin2 === '40.00',
      `m1=${a2?.margin1} m2=${a2?.margin2}`,
    );
    check('recalcularMargenes: sin costo no se toca ni se inventa', a3?.margin1 == null && r1.sinCosto >= 1, `m1=${a3?.margin1} sinCosto=${r1.sinCosto}`);
    check('recalcularMargenes: cuenta lo actualizado', r1.actualizados >= 2, JSON.stringify(r1));

    const r2 = await repos.articles.recalcularMargenesDesdePrecios({ soloVacios: false });
    const a2b = await repos.articles.findById(conMargen.id);
    check('recalcularMargenes (todos): pisa la utilidad cargada con la real (1000 → 1500 = 50%)', a2b?.margin1 === '50.00', `m1=${a2b?.margin1} ${JSON.stringify(r2)}`);
  }

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

  const PM_CASH = 'pm-efectivo';
  const PM_TRANSFER = 'pm-transferencia';
  const stockBefore = (await repos.articles.findById(art.id))!.stock;
  const { sale, lines, payments } = await repos.sales.createWithLines({
    type: 'B',
    customerId: cf.id,
    sellerId: admin.id,
    cashRegisterId: reg.id,
    isAccountSale: false,
    payments: [
      { paymentMethodId: PM_CASH, amount: '1500.0000' },
      { paymentMethodId: PM_TRANSFER, amount: '300.0000' },
    ],
    lines: [
      { articleId: art.id, quantity: '2.000', unitPrice: '850.0000', vatRate: '21.00' },
      { articleId: lowArt.id, quantity: '1.000', unitPrice: '100.0000', vatRate: '21.00' },
    ],
  });
  check('sales.createWithLines crea la venta', !!sale.id && sale.number === 1, `total=${sale.total}`);
  check('sales.createWithLines crea 2 líneas', lines.length === 2);
  check('sales.createWithLines total correcto', sale.total === '1800.0000', `total=${sale.total}`);
  check('sales.createWithLines crea 2 sale_payments', payments.length === 2);

  // --- DÍA DE CAJA (jornada) ---------------------------------------------
  // Pedido de Bruno: caja abierta el lunes, venta el martes a la 1:30 → la
  // venta es del LUNES. Pero una caja olvidada abierta días, o la "Caja
  // histórica" de una migración (abierta DESPUÉS de sus ventas), no pueden
  // arrastrar ventas a otro día: ahí manda la hora de la venta.
  {
    const raw = db.$client;
    const regOrig = raw.prepare('SELECT open_date AS o FROM cash_registers WHERE id = ?').get(reg.id) as { o: number };
    const saleOrig = raw.prepare('SELECT date AS d FROM sales WHERE id = ?').get(sale.id) as { d: number };
    const lunes20 = new Date(2026, 8, 28, 20, 0).getTime(); // lunes 28-sep 20:00
    const lunes = { from: new Date(2026, 8, 28, 0, 0).getTime(), to: new Date(2026, 8, 28, 23, 59, 59, 999).getTime() };
    const jornadaDe = () => (raw.prepare('SELECT jornada AS j FROM sales WHERE id = ?').get(sale.id) as { j: number }).j;
    raw.prepare('UPDATE cash_registers SET open_date = ? WHERE id = ?').run(lunes20, reg.id);

    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(new Date(2026, 8, 29, 1, 30).getTime(), sale.id); // martes 1:30
    check('jornada: venta del martes 1:30 con la caja del lunes abierta → es del lunes', jornadaDe() === lunes20, String(jornadaDe()));
    const porCaja = await repos.sales.findByJornadaRange(lunes.from, lunes.to);
    const porHora = await repos.sales.findByDateRange(lunes.from, lunes.to);
    check('jornada: el filtro "lunes" la trae; por hora real no', porCaja.some((s) => s.id === sale.id) && !porHora.some((s) => s.id === sale.id));
    const pagosLunes = await repos.salePayments.findBySaleDateRange(lunes.from, lunes.to);
    check('jornada: sus pagos también caen el lunes (casan con la venta)', pagosLunes.filter((p) => p.saleId === sale.id).length === 2);

    const miercoles = new Date(2026, 8, 30, 10, 0).getTime(); // caja olvidada abierta: +38 h
    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(miercoles, sale.id);
    check('jornada: caja olvidada abierta días → cuenta por la hora de la venta', jornadaDe() === miercoles, String(jornadaDe()));

    const antes = new Date(2025, 0, 10, 12, 0).getTime(); // "Caja histórica": venta ANTERIOR a la apertura
    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(antes, sale.id);
    check('jornada: venta anterior a la apertura (migración) → no se mueve', jornadaDe() === antes, String(jornadaDe()));

    raw.prepare('UPDATE cash_registers SET open_date = ? WHERE id = ?').run(regOrig.o, reg.id);
    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(saleOrig.d, sale.id);
    check('jornada: una venta normal (dentro de su caja) queda en su propio día de caja', jornadaDe() === regOrig.o || jornadaDe() === saleOrig.d);
  }

  const stockAfter = (await repos.articles.findById(art.id))!.stock;
  check(
    'sales.createWithLines descuenta stock',
    Number(stockBefore) - Number(stockAfter) === 2,
    `${stockBefore} -> ${stockAfter}`,
  );

  const movs = await repos.cashMovements.findByRegister(reg.id);
  const cashIncome = movs.find((m) => m.relatedSaleId === sale.id && m.paymentMethodId === PM_CASH);
  const transferIncome = movs.find((m) => m.relatedSaleId === sale.id && m.paymentMethodId === PM_TRANSFER);
  check(
    'sales.createWithLines genera 1 cashMovement por pago, sólo efectivo afecta el cajón',
    cashIncome?.amount === '1500.0000' && transferIncome?.amount === '300.0000',
    `efectivo=${cashIncome?.amount} transferencia=${transferIncome?.amount}`,
  );

  // Venta a cuenta corriente: sin sale_payments.
  const cust2 = await repos.customers.create({
    lastName: 'LOPEZ', firstName: 'Eva', category: 'CF', docType: 'DNI', docNumber: '30111118',
  });
  const accSale = await repos.sales.createWithLines({
    type: 'B', customerId: cust2.id, sellerId: admin.id, cashRegisterId: reg.id, isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '500.0000' }],
  });
  check('sales.createWithLines a cuenta → isAccountSale, sin pagos', accSale.sale.isAccountSale === true && accSale.payments.length === 0);

  await expectThrows(
    'sales.createWithLines con pagos que no suman el total → ConstraintError',
    () => repos.sales.createWithLines({
      type: 'B', customerId: cf.id, sellerId: admin.id, cashRegisterId: reg.id, isAccountSale: false,
      payments: [{ paymentMethodId: PM_CASH, amount: '999.0000' }],
      lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
    }),
    (e) => e instanceof ConstraintError,
  );

  const nextNum = await repos.sales.getNextNumber('B');
  check('sales.getNextNumber', nextNum === 3, `next=${nextNum}`);

  // anulación de la venta mixta → reverso de caja sólo por la parte efectivo, sale_payments eliminados
  const stockBeforeVoid = (await repos.articles.findById(art.id))!.stock;
  const voided = await repos.sales.voidSale(sale.id);
  check('sales.voidSale marca voided', voided.status === 'voided');
  const stockRestored = (await repos.articles.findById(art.id))!.stock;
  check('sales.voidSale restaura stock', Number(stockRestored) - Number(stockBeforeVoid) === 2, `${stockBeforeVoid}→${stockRestored}`);
  check('sales.voidSale elimina los sale_payments', (await repos.salePayments.findBySale(sale.id)).length === 0);
  const reversal = (await repos.cashMovements.findByRegister(reg.id)).find((m) => m.relatedSaleId === sale.id && m.type === 'expense');
  check('sales.voidSale reverso de caja sólo por efectivo (1500)', reversal?.amount === '1500.0000', `reversal=${reversal?.amount}`);

  // La empresa nace con "vender sin stock" ACTIVADO (default de producción):
  // para probar el bloqueo hay que apagarlo explícitamente.
  await repos.company.upsert({ allowNegativeStock: false } as never);
  await expectThrows(
    'sales.createWithLines con stock insuficiente revierte y lanza ConstraintError',
    () =>
      repos.sales.createWithLines({
        type: 'B',
        customerId: cf.id,
        sellerId: admin.id,
        cashRegisterId: reg.id,
        isAccountSale: false,
        payments: [{ paymentMethodId: PM_CASH, amount: '99999.0000' }],
        lines: [{ articleId: art.id, quantity: '99999.000', unitPrice: '1.0000' }],
      }),
    (e) => e instanceof ConstraintError,
  );
  // el artículo no debe haber cambiado tras el rollback
  const stockAfterRollback = (await repos.articles.findById(art.id))!.stock;
  check('sales.createWithLines rollback no toca stock', stockAfterRollback === stockRestored);
  await repos.company.upsert({ allowNegativeStock: true } as never);

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
    console.error('\n✗ Excepción durante el smoke test:', err instanceof Error ? (err.stack ?? err.message) : String(err));
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
