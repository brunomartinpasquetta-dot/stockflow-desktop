/**
 * Test de regresión de integridad contable — AUDIT_SALDOS_2026_05_17.
 *   pnpm --filter @stockflow/core test:saldos
 *
 * Cubre los 7 bugs de saldos (BUG-S01..S07) con:
 *  1. Un escenario integral (apertura, ventas mono/split/cuenta, compra a cuenta,
 *     anulación, transferencia a Caja General, cierre) y sus asserts finales.
 *  2. Un test puntual por cada bug que reproduce el bug y verifica el fix.
 *
 * Sale con código 1 si algún check falla.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRepositories, initLocalDb, closeLocalDb } from '@stockflow/db';

import {
  AuthService,
  BusinessRuleError,
  createServiceContext,
  createServices,
} from '../index';

const PM_CASH = 'pm-efectivo';
const PM_TRANSFER = 'pm-transferencia';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}
async function expectThrows(
  label: string,
  fn: () => Promise<unknown>,
  predicate: (e: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    check(label, false, 'no lanzó error');
  } catch (e) {
    check(label, predicate(e), e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-saldos-smoke-'));
const dbPath = join(tmpDir, 'stockflow.db');
console.log(`\nTest de regresión SALDOS — DB temporal: ${dbPath}\n`);

async function main(): Promise<void> {
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);

  const auth = new AuthService(repos);
  const { user: adminUser } = await auth.login('admin', 'admin');
  const adminCtx = createServiceContext(db, adminUser);
  const admin = createServices(adminCtx);

  // ---------------------------------------------------------- datos base
  // Medios de pago (vienen del seed): Efectivo (isPhysicalCash), Transferencia,
  // Tarjeta de Crédito. Verificamos el invariante de efectivo físico.
  const pms = await repos.paymentMethods.findOrdered();
  const physical = pms.filter((p) => p.isPhysicalCash);
  check(
    '[setup] sólo Efectivo es efectivo físico (isPhysicalCash)',
    physical.length === 1 && physical[0]?.id === PM_CASH,
    physical.map((p) => p.name).join(','),
  );

  const cliente = await repos.customers.create({
    lastName: 'CLIENTE CTA CTE',
    firstName: 'Test',
    category: 'RI',
    docType: 'CUIT',
    docNumber: '20-12345678-6',
    creditLimit: '0.0000',
  });
  const prov = await repos.suppliers.create({ code: 'PR-SALDOS', name: 'Proveedor Cta Cte' });

  const arts: Array<{ id: string }> = [];
  for (let i = 0; i < 5; i++) {
    arts.push(
      await repos.articles.create({
        barcode: `SALDOS-${i.toString().padStart(4, '0')}`,
        description: `Artículo saldos ${i}`,
        listPrice1: '100.0000',
        costPrice: '60.0000',
        stock: '100.000',
        vatRate: '21.00',
      }),
    );
  }
  const art = arts[0]!;

  // =================================================================
  // ESCENARIO INTEGRAL
  // =================================================================
  console.log('\n[escenario integral]');

  // Abrir caja $1000 efectivo.
  const reg = await admin.cash.openCashRegister('1000.0000');
  check('abrir caja $1000 efectivo', reg.status === 'open' && reg.openingAmount === '1000.0000');

  // Venta A: $500 efectivo (mono).
  const ventaA = await admin.sales.createSale({
    type: 'B',
    customerId: cliente.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '500.0000' }],
    lines: [{ articleId: art.id, quantity: '5.000', unitPrice: '100.0000' }],
  });
  check('Venta A: $500 efectivo (mono)', ventaA.sale.total === '500.0000' && ventaA.payments.length === 1);

  // Venta B: $300 efectivo + $200 transferencia (split).
  const ventaB = await admin.sales.createSale({
    type: 'B',
    customerId: cliente.id,
    payments: [
      { paymentMethodId: PM_CASH, amount: '300.0000' },
      { paymentMethodId: PM_TRANSFER, amount: '200.0000' },
    ],
    lines: [{ articleId: art.id, quantity: '5.000', unitPrice: '100.0000' }],
  });
  check('Venta B: $300 efectivo + $200 transferencia (split)', ventaB.sale.total === '500.0000' && ventaB.payments.length === 2);

  // Venta C: $400 a cuenta del cliente.
  const ventaC = await admin.sales.createSale({
    type: 'B',
    customerId: cliente.id,
    isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '4.000', unitPrice: '100.0000' }],
  });
  check(
    'Venta C: $400 a cuenta → AR creada balance 400',
    ventaC.accountReceivable != null && ventaC.accountReceivable.balance === '400.0000',
    `balance=${ventaC.accountReceivable?.balance}`,
  );

  // Compra a proveedor: $600 a cuenta.
  const compra = await admin.purchases.createPurchase({
    type: 'A',
    supplierId: prov.id,
    isAccountPurchase: true,
    lines: [{ articleId: art.id, quantity: '10.000', costPrice: '60.0000', vatRate: '21.00' }],
  });
  check(
    'Compra $600 a cuenta → AP creada balance 600',
    compra.accountPayable != null && compra.accountPayable.balance === '600.0000',
    `balance=${compra.accountPayable?.balance}`,
  );

  // Anular venta B. El reverso de caja sólo afecta el efectivo físico: se emite
  // un cash_movements expense de $300 con paymentMethodId efectivo. La parte en
  // transferencia ($200) no toca el cajón, por lo que no genera reverso de caja
  // (el sale_payment se elimina igual). El reverso lleva el PM original.
  await admin.sales.voidSale(ventaB.sale.id);
  const movsB = (await repos.cashMovements.findByRegister(reg.id)).filter(
    (m) => m.relatedSaleId === ventaB.sale.id && m.type === 'expense',
  );
  const reversoEfectivoB = movsB.find((m) => m.paymentMethodId === PM_CASH);
  check(
    'anular Venta B: reverso de caja sólo por la parte efectivo (300), con su PM',
    movsB.length === 1 && reversoEfectivoB?.amount === '300.0000',
    `movs=${movsB.length} efectivo=${reversoEfectivoB?.amount}`,
  );
  check(
    'anular Venta B: la parte en transferencia NO genera reverso de caja',
    movsB.find((m) => m.paymentMethodId === PM_TRANSFER) === undefined,
  );
  check(
    'anular Venta B: sale_payments eliminados',
    (await repos.salePayments.findBySale(ventaB.sale.id)).length === 0,
  );

  // Transferir $500 a Caja General (ANTES de cerrar — la caja debe estar abierta).
  const transfer = await admin.cashGeneral.transferFromDaily({
    cashRegisterId: reg.id,
    amount: '500.0000',
  });
  check('transferir $500 a Caja General', Number(transfer.amount) === 500 && transfer.type === 'transfer_from_daily');

  // Cerrar caja. Efectivo físico esperado:
  //   $1000 apertura + $500 (A) + $300 (B efectivo) − $300 (reverso B efectivo)
  //   − $500 (transferencia a Caja General) = $1000.
  // (La transferencia $200 de B y su reverso no son efectivo físico → no cuentan.)
  const expectedFisico = '1000.0000';
  const { register: closedReg, report } = await admin.cash.closeCashRegister(reg.id, expectedFisico);
  check('cerrar caja: status closed', closedReg.status === 'closed');
  check(
    `cierre: expectedCash = ${expectedFisico} (apertura+A+Bef−reversoBef−transfer)`,
    report.expectedCash === expectedFisico,
    `expectedCash=${report.expectedCash}`,
  );
  check('cierre: diferencia 0', report.difference === '0.0000', `diff=${report.difference}`);

  // ----------------------------------------------------- asserts finales
  console.log('\n[asserts finales del escenario]');

  const cgBalance = await admin.cashGeneral.getBalance();
  check('cash_general.balance === 500.00', cgBalance === '500.00', `balance=${cgBalance}`);

  const arBalance = await repos.accountsReceivable.getTotalBalance(cliente.id);
  check('accounts_receivable[cliente] === 400.0000', arBalance === '400.0000', `balance=${arBalance}`);

  const apBalance = await repos.supplierAccountsPayable.getTotalBalance(prov.id);
  check('supplier_accounts_payable[proveedor] === 600.0000', apBalance === '600.0000', `balance=${apBalance}`);

  // getFinancialSummary().assets.cashValue debe incluir los $500 de Caja General.
  // La caja diaria ya está cerrada → cashRegistersValue = 0; cashValue = 0 + 500.
  const summary = await admin.accounting.getFinancialSummary({ from: 0, to: Date.now() + 86_400_000 });
  check(
    'getFinancialSummary: cashGeneralValue = 500',
    summary.assets.cashGeneralValue === '500.0000',
    `cashGeneralValue=${summary.assets.cashGeneralValue}`,
  );
  check(
    'getFinancialSummary: cashValue incluye los $500 de Caja General',
    summary.assets.cashValue === summary.assets.cashRegistersValue
      ? false
      : Number(summary.assets.cashValue) === Number(summary.assets.cashRegistersValue) + 500,
    `cashValue=${summary.assets.cashValue} registros=${summary.assets.cashRegistersValue}`,
  );

  // =================================================================
  // TESTS PUNTUALES POR BUG
  // =================================================================

  // ---- BUG-S01: transferFromDaily descuenta de la caja diaria origen ----
  console.log('\n[BUG-S01] transferFromDaily descuenta la caja diaria origen');
  {
    const reg1 = await admin.cash.openCashRegister('2000.0000');
    const fisicoAntes = (await admin.cash.getCashReport(reg1.id)).expectedCash;
    const cgAntes = await admin.cashGeneral.getBalance();
    await admin.cashGeneral.transferFromDaily({ cashRegisterId: reg1.id, amount: '700.0000' });
    const fisicoDespues = (await admin.cash.getCashReport(reg1.id)).expectedCash;
    const cgDespues = await admin.cashGeneral.getBalance();
    check(
      'S01: Caja General sube +700',
      Number(cgDespues) - Number(cgAntes) === 700,
      `${cgAntes}→${cgDespues}`,
    );
    check(
      'S01: efectivo físico de la caja diaria baja −700 (contrapartida registrada)',
      Number(fisicoAntes) - Number(fisicoDespues) === 700,
      `${fisicoAntes}→${fisicoDespues}`,
    );
    const expenseMov = (await repos.cashMovements.findByRegister(reg1.id)).find(
      (m) => m.type === 'expense' && m.description.includes('Caja General'),
    );
    check(
      'S01: existe el cash_movements expense "Transferencia a Caja General" con paymentMethodId efectivo',
      expenseMov != null && expenseMov.amount === '700.0000' && expenseMov.paymentMethodId === PM_CASH,
      `mov=${expenseMov?.amount} pm=${expenseMov?.paymentMethodId}`,
    );
    // BUG-S10: transferir desde una caja inexistente o cerrada falla.
    await expectThrows(
      'S01/S10: transferir desde caja inexistente → error',
      () => admin.cashGeneral.transferFromDaily({ cashRegisterId: 'no-existe', amount: '1.0000' }),
      (e) => e instanceof Error,
    );
    await admin.cash.closeCashRegister(reg1.id, '1300.0000');
    await expectThrows(
      'S01/S10: transferir desde caja YA CERRADA → error',
      () => admin.cashGeneral.transferFromDaily({ cashRegisterId: reg1.id, amount: '1.0000' }),
      (e) => e instanceof Error,
    );
  }

  // ---- BUG-S02: getFinancialSummary.cashValue incluye Caja General ----
  console.log('\n[BUG-S02] getFinancialSummary.cashValue incluye Caja General');
  {
    const before = await admin.accounting.getFinancialSummary({ from: 0, to: Date.now() + 86_400_000 });
    await admin.cashGeneral.addIncome({ amount: '1234.0000', description: 'Aporte test S02' });
    const after = await admin.accounting.getFinancialSummary({ from: 0, to: Date.now() + 86_400_000 });
    check(
      'S02: subir Caja General +1234 sube cashValue +1234',
      Number(after.assets.cashValue) - Number(before.assets.cashValue) === 1234,
      `${before.assets.cashValue}→${after.assets.cashValue}`,
    );
    check(
      'S02: cashValue = cashRegistersValue + cashGeneralValue',
      Number(after.assets.cashValue).toFixed(4) ===
        (Number(after.assets.cashRegistersValue) + Number(after.assets.cashGeneralValue)).toFixed(4),
      JSON.stringify(after.assets),
    );
  }

  // ---- BUG-S03: AR/AP dentro de la transacción del INSERT ----
  console.log('\n[BUG-S03] venta/compra a cuenta abren AR/AP atómicamente');
  {
    const regS3 = await admin.cash.openCashRegister('0.0000');
    const vs3 = await admin.sales.createSale({
      type: 'B',
      customerId: cliente.id,
      isAccountSale: true,
      lines: [{ articleId: arts[1]!.id, quantity: '3.000', unitPrice: '100.0000' }],
    });
    const arRow = await repos.accountsReceivable.findOne({ saleId: vs3.sale.id });
    check(
      'S03: venta a cuenta → AR existe en DB (misma transacción que la venta)',
      arRow != null && arRow.saleId === vs3.sale.id && arRow.balance === vs3.sale.total,
      `ar=${arRow?.id}`,
    );
    // Invariante: NINGUNA venta isAccountSale=true sin AR.
    const allSales = await repos.sales.findByDateRange(0, Date.now() + 86_400_000);
    let huerfanas = 0;
    for (const s of allSales) {
      if (!s.isAccountSale) continue;
      if (s.status === 'voided') continue;
      const ar = await repos.accountsReceivable.findOne({ saleId: s.id });
      if (!ar) huerfanas++;
    }
    check('S03: invariante — 0 ventas a cuenta sin AR', huerfanas === 0, `huérfanas=${huerfanas}`);

    const ps3 = await admin.purchases.createPurchase({
      type: 'A',
      supplierId: prov.id,
      isAccountPurchase: true,
      lines: [{ articleId: arts[1]!.id, quantity: '2.000', costPrice: '60.0000', vatRate: '21.00' }],
    });
    const apRow = await repos.supplierAccountsPayable.findOne({ purchaseId: ps3.purchase.id });
    check(
      'S03: compra a cuenta → AP existe en DB (misma transacción que la compra)',
      apRow != null && apRow.purchaseId === ps3.purchase.id && apRow.balance === ps3.purchase.total,
      `ap=${apRow?.id}`,
    );
    await admin.cash.closeCashRegister(regS3.id, '0.0000');
  }

  // ---- BUG-S04: voidSale revierte cada pago físico con su paymentMethodId ----
  console.log('\n[BUG-S04] voidSale: un reverso por cada pago físico');
  {
    // El bug original lumpeaba TODOS los pagos físicos en un único reverso con
    // el primer paymentMethodId. Para reproducirlo necesitamos 2 medios físicos
    // distintos en la misma venta (ej: efectivo del cajón + efectivo caja chica).
    const efectivoChica = await repos.paymentMethods.create({
      name: 'Efectivo Caja Chica S04',
      type: 'cash',
      isPhysicalCash: true,
      sortOrder: 70,
    });
    const regS4 = await admin.cash.openCashRegister('0.0000');
    const vs4 = await admin.sales.createSale({
      type: 'B',
      customerId: cliente.id,
      payments: [
        { paymentMethodId: PM_CASH, amount: '150.0000' },
        { paymentMethodId: efectivoChica.id, amount: '250.0000' },
        { paymentMethodId: PM_TRANSFER, amount: '100.0000' }, // NO físico → no se revierte en caja
      ],
      lines: [{ articleId: arts[2]!.id, quantity: '5.000', unitPrice: '100.0000' }],
    });
    await admin.sales.voidSale(vs4.sale.id);
    const rev = (await repos.cashMovements.findByRegister(regS4.id)).filter(
      (m) => m.relatedSaleId === vs4.sale.id && m.type === 'expense',
    );
    check(
      'S04: 2 reversos (uno por pago en efectivo físico), cada uno con su paymentMethodId',
      rev.length === 2 &&
        rev.find((m) => m.paymentMethodId === PM_CASH)?.amount === '150.0000' &&
        rev.find((m) => m.paymentMethodId === efectivoChica.id)?.amount === '250.0000',
      `reversos=${rev.length}`,
    );
    check(
      'S04: la transferencia (no físico) NO genera reverso de caja',
      rev.find((m) => m.paymentMethodId === PM_TRANSFER) === undefined,
    );
    await admin.cash.closeCashRegister(regS4.id, '0.0000');
  }

  // ---- BUG-S05: voidPurchase revierte cada egreso físico con su PM ----
  console.log('\n[BUG-S05] voidPurchase: un reverso por cada egreso físico');
  {
    // Compra contado con 2 medios físicos distintos → el reverso debe emitir
    // un ingreso por cada egreso físico, con su PM (antes lumpeaba en uno).
    const efectivoChica5 = await repos.paymentMethods.create({
      name: 'Efectivo Caja Chica S05',
      type: 'cash',
      isPhysicalCash: true,
      sortOrder: 71,
    });
    const regS5 = await admin.cash.openCashRegister('2000.0000');
    const ps5 = await admin.purchases.createPurchase({
      type: 'A',
      supplierId: prov.id,
      cashRegisterId: regS5.id,
      payments: [
        { paymentMethodId: PM_CASH, amount: '500.0000' },
        { paymentMethodId: efectivoChica5.id, amount: '200.0000' },
        { paymentMethodId: PM_TRANSFER, amount: '300.0000' }, // NO físico
      ],
      lines: [{ articleId: arts[3]!.id, quantity: '10.000', costPrice: '100.0000', vatRate: '21.00' }],
    });
    await admin.purchases.voidPurchase(ps5.purchase.id);
    const revP = (await repos.cashMovements.findByRegister(regS5.id)).filter(
      (m) => m.relatedPurchaseId === ps5.purchase.id && m.type === 'income',
    );
    check(
      'S05: reverso de compra emite un ingreso por cada egreso físico, con su PM',
      revP.length === 2 &&
        revP.find((m) => m.paymentMethodId === PM_CASH)?.amount === '500.0000' &&
        revP.find((m) => m.paymentMethodId === efectivoChica5.id)?.amount === '200.0000',
      `reversos=${revP.length}`,
    );
    check(
      'S05: la transferencia (no físico) NO genera reverso de caja',
      revP.find((m) => m.paymentMethodId === PM_TRANSFER) === undefined,
    );
    await admin.cash.closeCashRegister(regS5.id, '2000.0000');
  }

  // ---- BUG-S06: voidSale tolera movimientos legacy con paymentMethodId NULL ----
  console.log('\n[BUG-S06] voidSale tolera medios de pago legacy / borrados');
  {
    const regS6 = await admin.cash.openCashRegister('0.0000');
    // Creamos un medio de pago custom, físico, y luego lo "borramos" del
    // catálogo dejando el sale_payment apuntando a un PM inexistente — simula
    // un medio editado/eliminado. El LEFT JOIN deja isCash en null.
    const customPm = await repos.paymentMethods.create({
      name: 'Efectivo Caja Chica',
      type: 'cash',
      isPhysicalCash: true,
      sortOrder: 50,
    });
    const vs6 = await admin.sales.createSale({
      type: 'B',
      customerId: cliente.id,
      payments: [{ paymentMethodId: customPm.id, amount: '400.0000' }],
      lines: [{ articleId: arts[4]!.id, quantity: '4.000', unitPrice: '100.0000' }],
    });
    // Forzar el caso legacy: borrar la fila del medio de pago dejando el
    // sale_payment colgando (FK off momentáneamente). El LEFT JOIN de voidSale
    // devolverá isCash = null para ese pago.
    db.$client.pragma('foreign_keys = OFF');
    db.$client.prepare('DELETE FROM payment_methods WHERE id = ?').run(customPm.id);
    db.$client.pragma('foreign_keys = ON');
    // voidSale no debe romperse y debe emitir el reverso (como efectivo físico).
    const voided = await admin.sales.voidSale(vs6.sale.id);
    check('S06: voidSale con medio de pago borrado no rompe', voided.status === 'voided');
    const rev6 = (await repos.cashMovements.findByRegister(regS6.id)).filter(
      (m) => m.relatedSaleId === vs6.sale.id && m.type === 'expense',
    );
    check(
      'S06: se emite el reverso del pago aunque el medio ya no exista',
      rev6.length === 1 && rev6[0]?.amount === '400.0000',
      `reversos=${rev6.length}`,
    );
    await admin.cash.closeCashRegister(regS6.id, '0.0000');
  }

  // ---- BUG-S07: efectivo físico filtrado por isPhysicalCash, no type ----
  console.log('\n[BUG-S07] efectivo físico por isPhysicalCash (no type==="cash")');
  {
    // Medio custom isPhysicalCash=true pero con type != 'cash'. Se crea como
    // 'cash' (lo exige el schema de creación) y se edita a 'other' vía update
    // (sin esa restricción) — simula el escenario del audit: el usuario edita
    // el medio desde Configuración y rompe la coincidencia type<->isPhysicalCash.
    // Debe seguir contando como efectivo físico por el criterio canónico.
    const efectivoCustom = await repos.paymentMethods.create({
      name: 'Efectivo USD convertido',
      type: 'cash',
      isPhysicalCash: true,
      sortOrder: 60,
    });
    await repos.paymentMethods.update(efectivoCustom.id, { type: 'other' });
    const regS7 = await admin.cash.openCashRegister('0.0000');
    await admin.sales.createSale({
      type: 'B',
      customerId: cliente.id,
      payments: [{ paymentMethodId: efectivoCustom.id, amount: '350.0000' }],
      lines: [{ articleId: art.id, quantity: '5.000', unitPrice: '70.0000' }],
    });
    const repS7 = await admin.cash.getCashReport(regS7.id);
    check(
      'S07: cierre cuenta un medio type="other" isPhysicalCash=true como efectivo físico',
      repS7.expectedCash === '350.0000',
      `expectedCash=${repS7.expectedCash}`,
    );
    const sumBefore = await admin.accounting.getFinancialSummary({ from: 0, to: Date.now() + 86_400_000 });
    check(
      'S07: getFinancialSummary cuenta ese efectivo físico custom en cashRegistersValue',
      Number(sumBefore.assets.cashRegistersValue) >= 350,
      `cashRegistersValue=${sumBefore.assets.cashRegistersValue}`,
    );
    await admin.cash.closeCashRegister(regS7.id, '350.0000');
  }

  closeLocalDb(db);
}

main()
  .catch((e) => {
    failures++;
    const msg = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e);
    console.error('\n✗ Excepción durante el test de saldos:', msg);
  })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
    if (failures > 0) {
      console.error(`\nTEST DE REGRESIÓN SALDOS FALLÓ — ${failures} check(s) con error.\n`);
      process.exit(1);
    }
    console.log('\nTEST DE REGRESIÓN SALDOS OK ✅\n');
  });
