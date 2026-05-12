/**
 * Smoke test de la capa de servicios de dominio (sin framework — `tsx`).
 *   pnpm --filter @stockflow/core test:smoke
 *
 * Inicializa una DB temporal, arma repos + servicios, ejercita los flujos
 * principales (auth/permisos, ventas, anulación, cuenta corriente, caja, reportes,
 * inventario) y limpia los archivos al terminar. Sale con código 1 si algo falla.
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
  check('checkPermission seller !manage_users', !authService.checkPermission(sellerUser, 'manage_users'));
  check('checkPermission seller create_sale', authService.checkPermission(sellerUser, 'create_sale'));
  check('checkPermission seller !void_sale', !authService.checkPermission(sellerUser, 'void_sale'));

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

  const cashSale = await seller.sales.createSale({
    type: 'B',
    customerId: cf.id,
    paymentType: 'cash',
    lines: [{ articleId: art.id, quantity: '2.000' }], // unitPrice resuelto = listPrice1
  });
  check(
    'createSale (seller, contado, precio resuelto)',
    cashSale.sale.total === '1700.0000' && cashSale.lines.length === 1 && cashSale.accountReceivable === null,
    `total=${cashSale.sale.total}`,
  );

  await expectThrows(
    'createSale a cuenta con CONSUMIDOR FINAL → BusinessRuleError',
    () =>
      seller.sales.createSale({
        type: 'B',
        customerId: cf.id,
        paymentType: 'account',
        lines: [{ articleId: art.id, quantity: '1.000' }],
      }),
    (e) => e instanceof BusinessRuleError,
  );

  const accSale1 = await seller.sales.createSale({
    type: 'B',
    customerId: gomez.id,
    paymentType: 'account',
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  check(
    'createSale a cuenta con cliente real → crea AR',
    accSale1.accountReceivable != null &&
      accSale1.accountReceivable.balance === accSale1.sale.total &&
      accSale1.accountReceivable.status === 'open',
    `balance=${accSale1.accountReceivable?.balance}`,
  );

  const accSale2 = await seller.sales.createSale({
    type: 'B',
    customerId: gomez.id,
    paymentType: 'account',
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
  });
  check('createSale a cuenta #2 → AR', accSale2.accountReceivable?.balance === '1000.0000');

  const balancesBeforeVoid = await seller.accountsReceivable.listCustomerBalances();
  const gomezBalance = balancesBeforeVoid.find((b) => b.customerId === gomez.id);
  check(
    'listCustomerBalances: deuda agregada del cliente (850 + 1000) y 2 comprobantes',
    gomezBalance?.totalDebt === '1850.0000' && gomezBalance?.openInvoicesCount === 2,
    JSON.stringify(gomezBalance),
  );

  // --- pagos con tarjeta / mixto ---
  console.log('\n[tarjetas / pago mixto]');
  const visa = await repos.cards.create({ name: 'Visa', commissionPct: '3.00' });
  check('cards.create', !!visa.id && visa.name === 'Visa' && visa.active === true);
  const cardSale = await seller.sales.createSale({
    type: 'B',
    customerId: cf.id,
    paymentType: 'card',
    cardId: visa.id,
    cardAmount: '1000.0000',
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
  });
  check(
    'venta con tarjeta se registra (cardId + cardAmount)',
    cardSale.sale.paymentType === 'card' && cardSale.sale.cardId === visa.id && cardSale.sale.cardAmount === '1000.0000',
    JSON.stringify({ pt: cardSale.sale.paymentType, cardId: cardSale.sale.cardId, ca: cardSale.sale.cardAmount }),
  );
  const mixedSale = await seller.sales.createSale({
    type: 'B',
    customerId: cf.id,
    paymentType: 'mixed',
    cardId: visa.id,
    cardAmount: '600.0000',
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
  });
  check('venta mixta se registra', mixedSale.sale.paymentType === 'mixed' && mixedSale.sale.cardAmount === '600.0000');
  const reportAfterCardSales = await seller.cash.getCashReport(reg.id);
  check(
    'caja: la venta con tarjeta no aporta efectivo; la mixta sólo la parte en efectivo (1700 + 0 + 400 = 2100)',
    reportAfterCardSales.incomeTotal === '2100.0000',
    `incomeTotal=${reportAfterCardSales.incomeTotal}`,
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
  const voided = await admin.sales.voidSale(accSale1.sale.id);
  check('voidSale admin OK', voided.status === 'voided');
  check('voidSale elimina la AR sin pagos', (await repos.accountsReceivable.findById(accSale1.accountReceivable!.id)) === null);
  const stockAfterVoid = (await repos.articles.findById(art.id))!.stock;
  check('voidSale restaura stock', Number(stockAfterVoid) - Number(stockBeforeVoid) === 1, `${stockBeforeVoid}→${stockAfterVoid}`);

  // -------------------------------------------------------------- pricing
  console.log('\n[pricing]');
  check('resolvePrice quantity=5 < minQty → listPrice1', resolvePrice(art, gomez, '5.000') === '850.0000');
  check('resolvePrice quantity=15 >= minQty → wholesalePrice', resolvePrice(art, gomez, '15.000') === '700.0000');
  const vat = calculateVAT('121.0000', '21.00', true);
  check('IVA contenido 121@21 → 100/21', vat.net === '100.0000' && vat.vat === '21.0000');

  // -------------------------------------------------------- cuenta corriente
  console.log('\n[accounts receivable]');
  const pay1 = await seller.accountsReceivable.receivePayment({
    accountId: accSale2.accountReceivable!.id,
    amount: '400.0000',
    method: 'cash',
  });
  check('receivePayment parcial → status partial', pay1.account.status === 'partial' && pay1.account.balance === '600.0000', `balance=${pay1.account.balance}`);
  const pay2 = await seller.accountsReceivable.receivePayment({
    accountId: accSale2.accountReceivable!.id,
    amount: '600.0000',
    method: 'transfer',
  });
  check('receivePayment total → status paid', pay2.account.status === 'paid' && pay2.account.balance === '0.0000', `balance=${pay2.account.balance}`);
  await expectThrows(
    'receivePayment que supera el saldo → BusinessRuleError',
    () => seller.accountsReceivable.receivePayment({ accountId: accSale2.accountReceivable!.id, amount: '10.0000', method: 'cash' }),
    (e) => e instanceof BusinessRuleError,
  );

  const statement = await admin.accountsReceivable.getCustomerStatement(gomez.id);
  check('getCustomerStatement: 3 movimientos (1 venta + 2 pagos)', statement.entries.length === 3, `entries=${statement.entries.length}`);
  check('getCustomerStatement: saldo final 0', statement.currentBalance === '0.0000', `saldo=${statement.currentBalance}`);
  check('getTotalReceivables = 0', (await admin.accountsReceivable.getTotalReceivables()) === '0.0000');

  // ------------------------------------------------------------------ caja
  console.log('\n[cash]');
  const mov = await admin.cash.addMovement({ type: 'income', description: 'Aporte de socio', amount: '500.0000' });
  check('addMovement (admin)', mov.type === 'income' && mov.amount === '500.0000');
  await expectThrows(
    'addMovement como seller → PermissionDeniedError',
    () => seller.cash.addMovement({ type: 'income', description: 'x', amount: '1.0000' }),
    (e) => e instanceof PermissionDeniedError,
  );

  // ingresos en efectivo: venta contado 1700 + venta tarjeta 0 + venta mixta 400 + cobranzas 400 + 600 + aporte 500 = 3600
  const { register: closedReg, report } = await admin.cash.closeCashRegister(reg.id, '4600.0000', 'cierre de prueba');
  check('closeCashRegister', closedReg.status === 'closed');
  check('reporte: ingresos en efectivo = 3600', report.incomeTotal === '3600.0000', `incomeTotal=${report.incomeTotal}`);
  check('reporte: efectivo esperado = 4600', report.expectedCash === '4600.0000', `expected=${report.expectedCash}`);
  check('reporte: diferencia = 0', report.difference === '0.0000', `diff=${report.difference}`);
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
  check('salesByDateRange: completadas >= 2', salesReport.count >= 2, `count=${salesReport.count}`);
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
