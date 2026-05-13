/**
 * Smoke test de la capa de servicios de dominio (sin framework — `tsx`).
 *   pnpm --filter @stockflow/core test:smoke
 *
 * Inicializa una DB temporal, arma repos + servicios, ejercita los flujos
 * principales (auth/permisos, ventas con N pagos, anulación, cuenta corriente con
 * cobranzas mixtas, caja con desglose por medio, reportes, inventario) y limpia
 * los archivos al terminar. Sale con código 1 si algo falla.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRepositories, initLocalDb, closeLocalDb } from '@stockflow/db';

import {
  AuthService,
  BusinessRuleError,
  PermissionDeniedError,
  ValidationError,
  createServiceContext,
  createServices,
  resolvePrice,
  calculateVAT,
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

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-core-smoke-'));
const dbPath = join(tmpDir, 'stockflow.db');
console.log(`\nSmoke test (servicios) — DB temporal: ${dbPath}\n`);

async function main(): Promise<void> {
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);

  // ---------------------------------------------------------------- auth
  console.log('[auth]');
  const authService = new AuthService(repos);
  const { user: adminUser, sessionToken } = await authService.login('admin', 'admin');
  check('login admin OK', adminUser.username === 'admin' && sessionToken.length > 0);
  const payload = authService.verifySession(sessionToken);
  check('verifySession', payload?.sub === adminUser.id && payload?.role === 'admin');
  await expectThrows(
    'login con contraseña errónea → ValidationError',
    () => authService.login('admin', 'incorrecta'),
    (e) => e instanceof ValidationError,
  );

  const sellerUser = await repos.users.create({
    username: 'vendedor',
    password: '1234',
    fullName: 'Vendedor Uno',
    role: 'seller',
  });
  check('checkPermission admin manage_users', authService.checkPermission(adminUser, 'manage_users'));
  check('checkPermission admin manage_payment_methods', authService.checkPermission(adminUser, 'manage_payment_methods'));
  check('checkPermission seller !manage_payment_methods', !authService.checkPermission(sellerUser, 'manage_payment_methods'));
  check('checkPermission seller create_sale', authService.checkPermission(sellerUser, 'create_sale'));

  // -------------------------------------------------------- medios de pago
  console.log('\n[payment methods]');
  const methods = await repos.paymentMethods.findOrdered();
  check('seed: 4 medios de pago', methods.length === 4, methods.map((m) => m.name).join(', '));
  check('Efectivo es el único de efectivo físico', methods.filter((m) => m.isPhysicalCash).length === 1 && methods.find((m) => m.id === PM_CASH)?.isPhysicalCash === true);

  // ----------------------------------------------------------- datos base
  const cf = (await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' }))!;
  const gomez = await repos.customers.create({
    lastName: 'GOMEZ',
    firstName: 'Ana',
    category: 'RI',
    docType: 'CUIT',
    docNumber: '20-12345678-6',
    creditLimit: '0.0000', // 0 = sin límite
  });
  const art = await repos.articles.create({
    barcode: '7790000000017',
    description: 'Gaseosa cola 2.25L',
    listPrice1: '850.0000',
    listPrice2: '800.0000',
    costPrice: '600.0000',
    stock: '50.000',
    minStock: '5.000',
    idealStock: '30.000',
    vatRate: '21.00',
    wholesaleMinQty: '10.000',
    wholesalePrice: '700.0000',
  });
  const scarce = await repos.articles.create({
    barcode: '7790000000024',
    description: 'Producto escaso',
    listPrice1: '50.0000',
    costPrice: '30.0000',
    stock: '1.000',
    minStock: '10.000',
    idealStock: '20.000',
  });

  // ------------------------------------------------------- ventas (seller)
  console.log('\n[sales]');
  const sellerCtx = createServiceContext(db, sellerUser);
  const seller = createServices(sellerCtx);

  const reg = await seller.cash.openCashRegister('1000.0000');
  check('seller puede abrir caja', reg.status === 'open');

  // Venta 100% efectivo → 1 sale_payment + 1 cashMovement por el total.
  const cashSale = await seller.sales.createSale({
    type: 'B',
    customerId: cf.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '1700.0000' }],
    lines: [{ articleId: art.id, quantity: '2.000' }], // unitPrice resuelto = listPrice1 (850)
  });
  check(
    'createSale (contado, 100% efectivo, precio resuelto)',
    cashSale.sale.total === '1700.0000' && cashSale.payments.length === 1 && cashSale.accountReceivable === null && !cashSale.sale.isAccountSale,
    `total=${cashSale.sale.total}`,
  );

  await expectThrows(
    'createSale sin pagos y sin cuenta corriente → BusinessRuleError',
    () => seller.sales.createSale({ type: 'B', customerId: cf.id, payments: [], lines: [{ articleId: art.id, quantity: '1.000' }] }),
    (e) => e instanceof BusinessRuleError,
  );

  await expectThrows(
    'createSale con pagos que NO cubren el total → ValidationError',
    () => seller.sales.createSale({ type: 'B', customerId: cf.id, payments: [{ paymentMethodId: PM_CASH, amount: '999.0000' }], lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }] }),
    (e) => e instanceof ValidationError,
  );
  await expectThrows(
    'createSale con pagos que EXCEDEN el total → ValidationError',
    () => seller.sales.createSale({ type: 'B', customerId: cf.id, payments: [{ paymentMethodId: PM_CASH, amount: '1001.0000' }], lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }] }),
    (e) => e instanceof ValidationError,
  );

  await expectThrows(
    'createSale a cuenta con CONSUMIDOR FINAL → BusinessRuleError',
    () => seller.sales.createSale({ type: 'B', customerId: cf.id, isAccountSale: true, lines: [{ articleId: art.id, quantity: '1.000' }] }),
    (e) => e instanceof BusinessRuleError,
  );

  // Venta a cuenta corriente → sin sale_payments, AR creada.
  const accSale1 = await seller.sales.createSale({
    type: 'B',
    customerId: gomez.id,
    isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  check(
    'createSale a cuenta corriente → AR creada, sin pagos',
    accSale1.accountReceivable != null &&
      accSale1.accountReceivable.balance === accSale1.sale.total &&
      accSale1.accountReceivable.status === 'open' &&
      accSale1.payments.length === 0 &&
      accSale1.sale.isAccountSale === true,
    `balance=${accSale1.accountReceivable?.balance}`,
  );

  const accSale2 = await seller.sales.createSale({
    type: 'B',
    customerId: gomez.id,
    isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
  });
  check('createSale a cuenta #2 → AR balance 1000', accSale2.accountReceivable?.balance === '1000.0000');

  const gomezBalance = (await seller.accountsReceivable.listCustomerBalances()).find((b) => b.customerId === gomez.id);
  check(
    'listCustomerBalances: deuda agregada del cliente (850 + 1000) y 2 comprobantes',
    gomezBalance?.totalDebt === '1850.0000' && gomezBalance?.openInvoicesCount === 2,
    JSON.stringify(gomezBalance),
  );

  // Venta 50% efectivo + 50% transferencia → cashMovement de efectivo sólo por la parte efectivo.
  const mixedSale = await seller.sales.createSale({
    type: 'B',
    customerId: cf.id,
    payments: [
      { paymentMethodId: PM_CASH, amount: '400.0000' },
      { paymentMethodId: PM_TRANSFER, amount: '600.0000' },
    ],
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
  });
  check('createSale mixta (efectivo + transferencia) → 2 sale_payments', mixedSale.payments.length === 2 && mixedSale.sale.total === '1000.0000');

  const reportAfterMixed = await seller.cash.getCashReport(reg.id);
  check(
    'caja: efectivo esperado = 1000 (apertura) + 1700 (contado) + 400 (parte efectivo de la mixta) = 3100',
    reportAfterMixed.expectedCash === '3100.0000',
    `expectedCash=${reportAfterMixed.expectedCash}`,
  );
  check(
    'caja: ingresos totales incluyen la transferencia (1700 + 1000 = 2700)',
    reportAfterMixed.incomeTotal === '2700.0000',
    `incomeTotal=${reportAfterMixed.incomeTotal}`,
  );

  await expectThrows(
    'voidSale como seller → PermissionDeniedError',
    () => seller.sales.voidSale(cashSale.sale.id),
    (e) => e instanceof PermissionDeniedError,
  );

  // ---------------------------------------------------------- void (admin)
  console.log('\n[sales: void admin]');
  const adminCtx = createServiceContext(db, adminUser);
  const admin = createServices(adminCtx);

  const stockBeforeVoid = (await repos.articles.findById(art.id))!.stock;
  const voided1 = await admin.sales.voidSale(accSale1.sale.id);
  check('voidSale (a cuenta sin pagos) → voided', voided1.status === 'voided');
  check('voidSale elimina la AR sin pagos', (await repos.accountsReceivable.findById(accSale1.accountReceivable!.id)) === null);
  const stockAfterVoid = (await repos.articles.findById(art.id))!.stock;
  check('voidSale restaura stock', Number(stockAfterVoid) - Number(stockBeforeVoid) === 1, `${stockBeforeVoid}→${stockAfterVoid}`);

  const voided2 = await admin.sales.voidSale(mixedSale.sale.id);
  check('voidSale (mixta) → voided', voided2.status === 'voided');
  check('voidSale (mixta) elimina los sale_payments', (await repos.salePayments.findBySale(mixedSale.sale.id)).length === 0);
  const movsReg = await repos.cashMovements.findByRegister(reg.id);
  const reversal = movsReg.find((m) => m.relatedSaleId === mixedSale.sale.id && m.type === 'expense');
  check('voidSale (mixta) genera un egreso de caja sólo por la parte efectivo (400)', reversal?.amount === '400.0000', `reversal=${reversal?.amount}`);

  // -------------------------------------------------------------- pricing
  console.log('\n[pricing]');
  check('resolvePrice quantity=5 < minQty → listPrice1', resolvePrice(art, gomez, '5.000') === '850.0000');
  check('resolvePrice quantity=15 >= minQty → wholesalePrice', resolvePrice(art, gomez, '15.000') === '700.0000');
  const vatGross = calculateVAT('121.0000', '21.00', 'gross');
  check('calculateVAT gross 121@21 → net 100 / vat 21', vatGross.net === '100.0000' && vatGross.vat === '21.0000');
  const vatNet = calculateVAT('100.0000', '21.00', 'net');
  check('calculateVAT net 100@21 → vat 21 / gross 121', vatNet.vat === '21.0000' && vatNet.gross === '121.0000');

  // ----------------------------------------------------- modo de precios (gross / net)
  console.log('\n[modo de precios]');
  check('company.getPriceMode default = gross', (await admin.company.getPriceMode()) === 'gross');
  const artGross = await repos.articles.create({ barcode: '7790000000031', description: 'Artículo precio con IVA', listPrice1: '121.0000', vatRate: '21.00', stock: '20.000' });
  const ventaGross = await seller.sales.createSale({
    type: 'B', customerId: cf.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '121.0000' }],
    lines: [{ articleId: artGross.id, quantity: '1.000' }],
  });
  check(
    'modo gross: venta de art a $121 IVA 21% → vatAmount 21, subtotal 121, total 121',
    ventaGross.sale.vatAmount === '21.0000' && ventaGross.sale.subtotal === '121.0000' && ventaGross.sale.total === '121.0000',
    JSON.stringify({ sub: ventaGross.sale.subtotal, vat: ventaGross.sale.vatAmount, tot: ventaGross.sale.total }),
  );

  await admin.company.setPriceMode('net');
  check('company.getPriceMode tras cambio = net', (await admin.company.getPriceMode()) === 'net');
  const artNet = await repos.articles.create({ barcode: '7790000000048', description: 'Artículo precio neto', listPrice1: '100.0000', vatRate: '21.00', stock: '20.000' });
  const ventaNet = await seller.sales.createSale({
    type: 'B', customerId: cf.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '121.0000' }],
    lines: [{ articleId: artNet.id, quantity: '1.000' }],
  });
  check(
    'modo net: venta de art a $100 neto IVA 21% → vatAmount 21, subtotal neto 100, total 121',
    ventaNet.sale.vatAmount === '21.0000' && ventaNet.sale.subtotal === '100.0000' && ventaNet.sale.total === '121.0000',
    JSON.stringify({ sub: ventaNet.sale.subtotal, vat: ventaNet.sale.vatAmount, tot: ventaNet.sale.total }),
  );
  // la venta gross anterior queda inmutable
  const ventaGrossReload = await repos.sales.findById(ventaGross.sale.id);
  check('cambio de modo no toca ventas viejas', ventaGrossReload?.subtotal === '121.0000' && ventaGrossReload?.vatAmount === '21.0000');
  await admin.company.setPriceMode('gross'); // restaurar para el resto del smoke

  // -------------------------------------------------------- cuenta corriente
  console.log('\n[accounts receivable]');
  // Cobranza mixta: 500 efectivo + 500 transferencia sobre saldo 1000.
  const pay = await seller.accountsReceivable.receivePayment({
    accountId: accSale2.accountReceivable!.id,
    payments: [
      { paymentMethodId: PM_CASH, amount: '500.0000' },
      { paymentMethodId: PM_TRANSFER, amount: '500.0000' },
    ],
  });
  check('receivePayment mixto → cuenta saldada', pay.account.status === 'paid' && pay.account.balance === '0.0000', `balance=${pay.account.balance}`);
  check('receivePayment mixto → 2 filas de pago', pay.payments.length === 2 && (await repos.payments.findByAccount(accSale2.accountReceivable!.id)).length === 2);
  await expectThrows(
    'receivePayment que supera el saldo → BusinessRuleError',
    () => seller.accountsReceivable.receivePayment({ accountId: accSale2.accountReceivable!.id, payments: [{ paymentMethodId: PM_CASH, amount: '10.0000' }] }),
    (e) => e instanceof BusinessRuleError,
  );

  const statement = await admin.accountsReceivable.getCustomerStatement(gomez.id);
  check('getCustomerStatement: 3 movimientos (1 venta a cuenta + 2 cobros)', statement.entries.length === 3, `entries=${statement.entries.length}`);
  check('getCustomerStatement: saldo final 0', statement.currentBalance === '0.0000', `saldo=${statement.currentBalance}`);
  check('getTotalReceivables = 0', (await admin.accountsReceivable.getTotalReceivables()) === '0.0000');

  // ------------------------------------------------------------------ caja
  console.log('\n[cash]');
  const mov = await admin.cash.addMovement({ type: 'income', description: 'Aporte de socio', amount: '500.0000', paymentMethodId: PM_CASH });
  check('addMovement (admin, efectivo)', mov.type === 'income' && mov.amount === '500.0000' && mov.paymentMethodId === PM_CASH);
  await expectThrows(
    'addMovement como seller → PermissionDeniedError',
    () => seller.cash.addMovement({ type: 'income', description: 'x', amount: '1.0000' }),
    (e) => e instanceof PermissionDeniedError,
  );

  // efectivo: apertura 1000 + 1700 (contado) + 400 (mixta) + 121 (gross) + 121 (net) + 500 (cobranza) + 500 (aporte) − 400 (anulación mixta) = 3942
  const { register: closedReg, report } = await admin.cash.closeCashRegister(reg.id, '3942.0000', 'cierre de prueba');
  check('closeCashRegister', closedReg.status === 'closed');
  check('reporte: efectivo esperado = 3942', report.expectedCash === '3942.0000', `expected=${report.expectedCash}`);
  check('reporte: diferencia = 0', report.difference === '0.0000', `diff=${report.difference}`);
  const efectivoBd = report.byPaymentMethod.find((b) => b.paymentMethodId === PM_CASH);
  const transferBd = report.byPaymentMethod.find((b) => b.paymentMethodId === PM_TRANSFER);
  check('reporte: desglose Efectivo neto = 2942', efectivoBd?.net === '2942.0000', `efectivo=${efectivoBd?.net}`);
  check('reporte: desglose Transferencia neto = 1100', transferBd?.net === '1100.0000', `transferencia=${transferBd?.net}`);
  check(
    'reporte: notes con observaciones del cierre + arqueo',
    typeof closedReg.notes === 'string' && closedReg.notes!.includes('cierre de prueba') && closedReg.notes!.includes('Diferencia'),
  );
  await expectThrows(
    'closeCashRegister sobre caja ya cerrada → BusinessRuleError',
    () => admin.cash.closeCashRegister(reg.id, '0.0000'),
    (e) => e instanceof BusinessRuleError,
  );

  // --------------------------------------------------------------- reportes
  console.log('\n[reports]');
  const now = Date.now();
  const salesReport = await admin.reports.salesByDateRange(0, now + 86_400_000);
  check('salesByDateRange: al menos 3 ventas registradas', salesReport.sales.length >= 3, `total=${salesReport.sales.length}`);
  const top = await admin.reports.topArticles(0, now + 86_400_000);
  check('topArticles devuelve filas', top.length >= 1 && top[0]!.articleId === art.id);
  const byFamily = await admin.reports.inventoryByFamily();
  check('inventoryByFamily devuelve filas', byFamily.length >= 1);
  const bySeller = await admin.reports.salesBySeller(0, now + 86_400_000);
  check('salesBySeller incluye al vendedor', bySeller.some((r) => r.sellerId === sellerUser.id));
  await expectThrows(
    'reports como seller → PermissionDeniedError',
    () => seller.reports.salesByDateRange(0, now),
    (e) => e instanceof PermissionDeniedError,
  );

  // ------------------------------------------------------------- inventario
  console.log('\n[inventory]');
  const chk = await admin.inventory.checkStock(art.id, '5.000');
  check('checkStock available', chk.available === true && chk.current.length > 0);
  const adj = await admin.inventory.adjustStock(art.id, '100.000', 'recuento físico');
  check('adjustStock (admin)', adj.article.stock === '100.000' && adj.delta.length > 0, `delta=${adj.delta}`);
  await expectThrows(
    'adjustStock como seller → PermissionDeniedError',
    () => seller.inventory.adjustStock(art.id, '0.000', 'no'),
    (e) => e instanceof PermissionDeniedError,
  );
  const lowStock = await admin.inventory.getLowStockReport();
  const scarceRow = lowStock.find((r) => r.article.id === scarce.id);
  check('getLowStockReport incluye el artículo escaso', scarceRow != null, `suggested=${scarceRow?.suggestedOrder}`);
  check('getLowStockReport sugiere ideal - stock', scarceRow?.suggestedOrder === '19.000', `suggested=${scarceRow?.suggestedOrder}`);

  closeLocalDb(db);
}

main()
  .catch((e) => {
    console.error('\n✗ Excepción durante el smoke test:', e);
    failures++;
  })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
    if (failures > 0) {
      console.error(`\nSMOKE TEST (servicios) FALLÓ — ${failures} check(s) con error.\n`);
      process.exit(1);
    }
    console.log('\nSMOKE TEST (servicios) OK ✅\n');
  });
