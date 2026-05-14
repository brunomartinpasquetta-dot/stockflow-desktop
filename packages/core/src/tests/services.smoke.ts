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
  applyRounding,
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

  // ---------------------------------------------- compras + cuentas proveedores
  console.log('\n[compras / cuentas proveedores]');
  const reg2 = await admin.cash.openCashRegister('1000.0000');
  check('reabrir caja para compras', reg2.status === 'open');
  const prov = await repos.suppliers.create({ code: 'P001', name: 'Distribuidora Test' });

  // Compra contado mixta (600 efectivo + 400 transferencia = 1000).
  const compraContado = await admin.purchases.createPurchase({
    type: 'A',
    supplierId: prov.id,
    payments: [
      { paymentMethodId: PM_CASH, amount: '600.0000' },
      { paymentMethodId: PM_TRANSFER, amount: '400.0000' },
    ],
    lines: [{ articleId: art.id, quantity: '2.000', costPrice: '500.0000', vatRate: '21.00' }],
  });
  check('createPurchase contado → total 1000, sin cuenta', compraContado.purchase.total === '1000.0000' && compraContado.accountPayable === null && compraContado.purchase.paymentType === 'cash', `total=${compraContado.purchase.total}`);
  const compraMovs = await repos.cashMovements.findByRegister(reg2.id);
  const compraEfectivo = compraMovs.find((m) => m.relatedPurchaseId === compraContado.purchase.id && m.type === 'expense' && m.paymentMethodId === PM_CASH);
  const compraTransfer = compraMovs.find((m) => m.relatedPurchaseId === compraContado.purchase.id && m.type === 'expense' && m.paymentMethodId === PM_TRANSFER);
  check('compra contado: 1 egreso de caja por pago, sólo efectivo afecta el cajón (600/400)', compraEfectivo?.amount === '600.0000' && compraTransfer?.amount === '400.0000', `efectivo=${compraEfectivo?.amount} transferencia=${compraTransfer?.amount}`);
  await expectThrows(
    'createPurchase con pagos que no cubren el total → ValidationError',
    () => admin.purchases.createPurchase({ type: 'A', supplierId: prov.id, payments: [{ paymentMethodId: PM_CASH, amount: '900.0000' }], lines: [{ articleId: art.id, quantity: '1.000', costPrice: '1000.0000', vatRate: '21.00' }] }),
    (e) => e instanceof ValidationError,
  );

  // Compra con updatePrices → actualiza costPrice y listPrice1 del artículo.
  await admin.purchases.createPurchase({
    type: 'A',
    supplierId: prov.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '650.0000' }],
    updatePrices: true,
    lines: [{ articleId: art.id, quantity: '1.000', costPrice: '650.0000', salePrice: '900.0000', vatRate: '21.00' }],
  });
  const artAfterPurchase = await repos.articles.findById(art.id);
  check('compra con updatePrices → costPrice y listPrice1 actualizados (650 / 900)', artAfterPurchase?.costPrice === '650.0000' && artAfterPurchase?.listPrice1 === '900.0000', `cost=${artAfterPurchase?.costPrice} list=${artAfterPurchase?.listPrice1}`);

  // Compra a cuenta del proveedor → crea cuenta por pagar.
  const compraAcuenta = await admin.purchases.createPurchase({
    type: 'A',
    supplierId: prov.id,
    isAccountPurchase: true,
    lines: [{ articleId: art.id, quantity: '1.000', costPrice: '700.0000', vatRate: '21.00' }],
  });
  check('createPurchase a cuenta → AR de proveedor creada (balance 700, status open)', compraAcuenta.accountPayable?.balance === '700.0000' && compraAcuenta.accountPayable?.status === 'open' && compraAcuenta.purchase.paymentType === 'credit');
  const provBalances = await admin.supplierAccounts.listSupplierBalances();
  check('supplierAccounts.listBalances incluye al proveedor con deuda 700', provBalances.find((b) => b.supplierId === prov.id)?.totalDebt === '700.0000');

  // Pago parcial mixto a la cuenta del proveedor (200 efectivo + 100 transferencia = 300 de 700).
  const provPay = await admin.supplierAccounts.payInvoice({
    accountId: compraAcuenta.accountPayable!.id,
    payments: [
      { paymentMethodId: PM_CASH, amount: '200.0000' },
      { paymentMethodId: PM_TRANSFER, amount: '100.0000' },
    ],
    expectedAmount: '300.0000',
  });
  check('payInvoice parcial mixto → status partial, balance 400, 2 filas de pago', provPay.account.status === 'partial' && provPay.account.balance === '400.0000' && provPay.payments.length === 2, `balance=${provPay.account.balance}`);
  await expectThrows(
    'payInvoice que supera el saldo → BusinessRuleError',
    () => admin.supplierAccounts.payInvoice({ accountId: compraAcuenta.accountPayable!.id, payments: [{ paymentMethodId: PM_CASH, amount: '999.0000' }] }),
    (e) => e instanceof BusinessRuleError,
  );

  // Anular una compra contado → vuelve voided + reverso de caja por la parte efectivo.
  const voidedPurchase = await admin.purchases.voidPurchase(compraContado.purchase.id);
  check('voidPurchase contado → voided', voidedPurchase.status === 'voided');
  const reversalP = (await repos.cashMovements.findByRegister(reg2.id)).find((m) => m.relatedPurchaseId === compraContado.purchase.id && m.type === 'income');
  check('voidPurchase genera ingreso de caja por la parte efectivo (600)', reversalP?.amount === '600.0000', `reversal=${reversalP?.amount}`);
  await expectThrows(
    'voidPurchase a cuenta con pagos → BusinessRuleError',
    () => admin.purchases.voidPurchase(compraAcuenta.purchase.id),
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

  // ----------------------------------------------------- histórico de cajas
  console.log('\n[cash history]');
  // En este punto hay 2 cajas: `reg` (cerrada por admin sobre arqueo 3942)
  // y `reg2` (abierta por admin para compras). Backdateamos `reg` 5 días.
  const fiveDaysAgo = Date.now() - 5 * 86_400_000;
  await repos.cashRegisters.update(reg.id, { openDate: fiveDaysAgo, closeDate: fiveDaysAgo + 3_600_000 });

  const fullHistory = await admin.cash.listHistoricalCashRegisters({ from: 0, to: Date.now() + 86_400_000 });
  check('listHistoricalCashRegisters: incluye las 2 cajas', fullHistory.length >= 2, `cajas=${fullHistory.length}`);
  const summReg = fullHistory.find((r) => r.id === reg.id);
  check(
    'historical reg cerrada: difference 0 / status closed / userName',
    summReg != null && summReg.status === 'closed' && summReg.difference === '0.0000' && summReg.userName.length > 0,
    JSON.stringify({ status: summReg?.status, diff: summReg?.difference, user: summReg?.userName }),
  );
  const summReg2 = fullHistory.find((r) => r.id === reg2.id);
  check('historical reg2 abierta: status open + difference null', summReg2?.status === 'open' && summReg2?.difference === null);

  // Filtro por rango excluyendo la caja antigua: sólo debería aparecer reg2.
  const recentOnly = await admin.cash.listHistoricalCashRegisters({ from: Date.now() - 3_600_000, to: Date.now() + 86_400_000 });
  check('listHistoricalCashRegisters: filtro por rango excluye la caja antigua', recentOnly.every((r) => r.id !== reg.id) && recentOnly.some((r) => r.id === reg2.id), `len=${recentOnly.length}`);

  // Filtro por cajero.
  const byAdmin = await admin.cash.listHistoricalCashRegisters({ from: 0, to: Date.now() + 86_400_000, userId: adminUser.id });
  check('listHistoricalCashRegisters: filtro por userId', byAdmin.every((r) => r.userId === adminUser.id));

  // getHistoricalCashReport sobre reg incluye movimientos enriquecidos.
  const histReport = await admin.cash.getHistoricalCashReport(reg.id);
  check('getHistoricalCashReport: register correcto', histReport.register.id === reg.id);
  check('getHistoricalCashReport: trae movementsDetail con paymentMethodName', histReport.movementsDetail.length > 0 && histReport.movementsDetail.some((m) => m.paymentMethodName != null));

  await expectThrows(
    'listHistoricalCashRegisters como seller → PermissionDeniedError',
    () => seller.cash.listHistoricalCashRegisters({ from: 0, to: Date.now() }),
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

  // ------------------------------------------------------- price updates
  console.log('\n[price update]');
  // Familia + 10 artículos.
  const famF1 = await repos.families.create({ name: 'F1' });
  const supS1 = await repos.suppliers.create({ code: 'S1', name: 'Proveedor S1' });
  const puArts: Array<{ id: string }> = [];
  for (let i = 0; i < 10; i++) {
    puArts.push(
      await repos.articles.create({
        barcode: `PU-${i.toString().padStart(4, '0')}`,
        description: `PU artículo ${i}`,
        familyId: famF1.id,
        supplierId: supS1.id,
        costPrice: '100.0000',
        listPrice1: '150.0000',
        stock: '10.000',
      }),
    );
  }

  const previewPct = await admin.priceUpdates.previewUpdate({
    filter: { scope: 'family', familyId: famF1.id, onlyActive: true },
    rule: { type: 'percentage', value: '15', direction: 'increase', fields: ['listPrice1'] },
  });
  check(
    'preview +15% listPrice1 (familia F1): 10 entries',
    previewPct.articlesAffected === 10 && previewPct.entries.length === 10,
    `aff=${previewPct.articlesAffected} entries=${previewPct.entries.length}`,
  );
  const firstNew = previewPct.entries[0]!.newValue;
  check('preview +15%: 150 → 172.5', firstNew === '172.5000', `nv=${firstNew}`);

  const applied = await admin.priceUpdates.applyUpdate({
    filter: { scope: 'family', familyId: famF1.id, onlyActive: true },
    rule: { type: 'percentage', value: '15', direction: 'increase', fields: ['listPrice1'] },
    description: 'Aumento de prueba +15%',
  });
  check('applyUpdate: 10 artículos actualizados', applied.articlesAffected === 10 && applied.entries === 10);
  const a0After = await repos.articles.findById(puArts[0]!.id);
  check('applyUpdate: precio en DB actualizado', a0After?.listPrice1 === '172.5000', `lp1=${a0After?.listPrice1}`);

  const batches = await admin.priceUpdates.listBatches({});
  check('listBatches: incluye el batch recién creado', batches.some((b) => b.id === applied.batchId));

  const rollback = await admin.priceUpdates.rollbackBatch(applied.batchId);
  check('rollbackBatch: revierte 10 entries', rollback.entriesReverted === 10);
  const a0Restored = await repos.articles.findById(puArts[0]!.id);
  check('rollback: precio restaurado a 150', a0Restored?.listPrice1 === '150.0000', `lp1=${a0Restored?.listPrice1}`);
  await expectThrows(
    'rollback de un batch ya revertido → BusinessRuleError',
    () => admin.priceUpdates.rollbackBatch(applied.batchId),
    (e) => e instanceof BusinessRuleError,
  );

  // recalculate_from_cost + keepUtility: sube costo +10%, listPrice1 sube proporcionalmente.
  // Cost 100 → 110; utility original = (150-100)/100 = 0.5 → newList = 110 * 1.5 = 165.
  const previewKeep = await admin.priceUpdates.previewUpdate({
    filter: { scope: 'family', familyId: famF1.id, onlyActive: true },
    rule: {
      type: 'percentage',
      value: '10',
      direction: 'increase',
      fields: ['costPrice', 'listPrice1'],
      keepUtility: true,
    },
  });
  const previewKeepArt0 = previewKeep.entries.filter((e) => e.articleId === puArts[0]!.id);
  const newCost = previewKeepArt0.find((e) => e.field === 'costPrice')?.newValue;
  const newList = previewKeepArt0.find((e) => e.field === 'listPrice1')?.newValue;
  check(
    'preview keepUtility: cost 100→110, list 150→165',
    newCost === '110.0000' && newList === '165.0000',
    `cost=${newCost} list=${newList}`,
  );

  // Helper de redondeo (puro).
  check('applyRounding nearest_99(123.45) = 199', applyRounding(123.45, 'nearest_99') === 199);
  check('applyRounding nearest_99(50) = 99', applyRounding(50, 'nearest_99') === 99);
  check('applyRounding nearest_99(250) = 299', applyRounding(250, 'nearest_99') === 299);
  check('applyRounding up_to_10(123.45) = 130', applyRounding(123.45, 'up_to_10') === 130);
  check('applyRounding up_to_50(123.45) = 150', applyRounding(123.45, 'up_to_50') === 150);
  check('applyRounding up_to_100(123.45) = 200', applyRounding(123.45, 'up_to_100') === 200);

  // ----------------------------------------------------- búsqueda global (P-BUSQUEDA)
  console.log('\n[search]');
  await repos.articles.create({ barcode: '7790000001000', description: 'Coca Cola 500ml', listPrice1: '300.0000', stock: '10.000' });
  await repos.articles.create({ barcode: '7790000001001', description: 'Pepsi 500ml', listPrice1: '290.0000', stock: '10.000' });
  await repos.articles.create({ barcode: '7790000001002', description: 'Sprite 500ml', listPrice1: '290.0000', stock: '10.000' });
  await repos.customers.create({ lastName: 'PEREZ', firstName: 'Coca', category: 'CF' });

  const sCoca = await admin.search.globalSearch({ query: 'coca' });
  check(
    'search: query "coca" devuelve 1 artículo y 1 cliente',
    sCoca.articles.length === 1 && (sCoca.articles[0]?.description.includes('Coca') ?? false) && sCoca.customers.length === 1,
    `arts=${sCoca.articles.length} cust=${sCoca.customers.length}`,
  );

  const sLimit = await admin.search.globalSearch({ query: '500', limitPerCategory: 2 });
  check('search: limitPerCategory=2 respeta el límite', sLimit.articles.length <= 2, `arts=${sLimit.articles.length}`);

  const sEmpty = await admin.search.globalSearch({ query: '' });
  check('search: query vacía devuelve listas vacías', sEmpty.articles.length === 0 && sEmpty.customers.length === 0 && sEmpty.suppliers.length === 0 && sEmpty.sales.length === 0 && sEmpty.purchases.length === 0);

  const sCats = await admin.search.globalSearch({ query: 'coca', categories: ['articles'] });
  check('search: filtro por category sólo devuelve artículos', sCats.articles.length === 1 && sCats.customers.length === 0);

  // ----------------------------------------------------- MercadoPago QR
  console.log('\n[mp qr]');
  // Mock global fetch para que el cliente MP responda determinísticamente.
  const originalFetch = globalThis.fetch;
  type MockState = { paymentStatus: string };
  const mock: MockState = { paymentStatus: 'pending' };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/users/me')) return json({ id: '12345', nickname: 'TEST' });
    if (url.includes('/users/12345/stores') && method === 'POST') return json({ id: 'STORE-X' });
    if (url.endsWith('/pos') && method === 'POST') return json({ id: 'POS-1', external_id: 'CAJA-XYZ' });
    if (url.includes('/instore/qr/seller/collectors/') && method === 'GET') {
      return json({ qr_template_url: 'data:image/png;base64,AAAA' });
    }
    if (url.includes('/instore/orders/qr/') && method === 'PUT') return json({});
    if (url.includes('/instore/orders/qr/') && method === 'DELETE') return json({});
    if (url.includes('/v1/payments/search')) {
      if (mock.paymentStatus === 'pending') return json({ results: [] });
      return json({ results: [{ id: 9999, status: mock.paymentStatus, external_reference: extractExternalRef(url) }] });
    }
    if (url.includes('/v1/payments/9999')) {
      return json({ id: 9999, status: mock.paymentStatus, external_reference: lastExternalRef });
    }
    return json({}, 404);
  }) as typeof fetch;

  let lastExternalRef = '';
  function extractExternalRef(url: string): string {
    const m = /external_reference=([^&]+)/.exec(url);
    return m ? decodeURIComponent(m[1] ?? '') : lastExternalRef;
  }

  try {
    // Setup
    const setupRes = await admin.mpQr.setupCompany({ mpUserId: '12345', accessToken: 'TEST-TOKEN' });
    check('mpQr.setupCompany devuelve storeId', setupRes.configured && setupRes.storeId === 'STORE-X');
    const cfg = await admin.mpQr.getConfig();
    check('mpQr.getConfig configurado', cfg.configured === true && cfg.mpUserId === '12345');

    // Crear POS device para reg2 (caja abierta)
    const dev = await admin.mpQr.createPosDevice({ cashRegisterId: reg2.id });
    check('mpQr.createPosDevice crea device', dev.cashRegisterId === reg2.id && dev.mpPosId === 'POS-1');

    // Crear orden
    const order = await admin.mpQr.createOrder({
      cashRegisterId: reg2.id,
      amount: '500.00',
      description: 'Venta test MP',
    });
    lastExternalRef = order.externalReference;
    check('mpQr.createOrder pending con expiresAt > now', order.status === 'pending' && order.expiresAt > Date.now());

    // verifyPayment con pago aún pending → no cambia.
    const v1 = await admin.mpQr.verifyPayment(order.id);
    check('mpQr.verifyPayment sigue pending si MP no aprobó', v1.status === 'pending');

    // verifyPayment con pago aprobado.
    mock.paymentStatus = 'approved';
    const v2 = await admin.mpQr.verifyPayment(order.id);
    check('mpQr.verifyPayment marca approved', v2.status === 'approved' && v2.mpPaymentId === '9999');

    // handleWebhook idempotente: la segunda vez no procesa.
    const wh1 = await admin.mpQr.handleWebhook({ type: 'payment', data: { id: '9999' } });
    check('mpQr.handleWebhook segundo evento sobre orden ya approved → processed:false', wh1.processed === false);

    // expireStaleOrders: crear una orden, forzar expiración, expirar.
    mock.paymentStatus = 'pending';
    const order2 = await admin.mpQr.createOrder({
      cashRegisterId: reg2.id,
      amount: '100.00',
      description: 'A expirar',
    });
    // Hack: actualizar expiresAt en DB directamente.
    db.$client.prepare('UPDATE mp_orders SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, order2.id);
    const exp = await admin.mpQr.expireStaleOrders();
    check('mpQr.expireStaleOrders expira al menos 1', exp.expired >= 1);
    const order2Fresh = await admin.mpQr.getOrder(order2.id);
    check('orden expirada queda en status=expired', order2Fresh?.status === 'expired');

    // linkOrderToSale
    await admin.mpQr.linkOrderToSale(order.id, accSale1.sale.id);
    const linked = await admin.mpQr.getOrder(order.id);
    check('mpQr.linkOrderToSale persiste saleId', linked?.saleId === accSale1.sale.id);
  } finally {
    globalThis.fetch = originalFetch;
  }

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
