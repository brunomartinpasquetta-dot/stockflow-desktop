/**
 * PUNTO DE VENTA Y CAJA (auditoría sep-2026, tanda 5).
 *   pnpm --filter @stockflow/desktop test:pdv-caja
 *
 * Escenarios reales que antes fallaban:
 *   1. Venta cobrada por transferencia y anulada: seguía sumando en el
 *      desglose por medio, en el neto electrónico del cierre y en lo que se
 *      podía ingresar a Caja General (A1).
 *   2. El reverso de una venta electrónica de una caja ya cerrada entra a la
 *      caja abierta actual; sin caja abierta, se rechaza.
 *   3. Venta o cobranza contra una caja que se cerró en el medio (A4).
 *   4. El motivo de la anulación queda en la venta (A7).
 *   5. Depósito parcial de un cierre: lo ya ingresado se desglosa de verdad
 *      en efectivo y electrónico (A8).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { createServiceContext, createServices } from '@stockflow/core';

let fallas = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) fallas++;
  console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'pdv-caja-'));
const { db } = initLocalDb(join(dir, 'x.db'));
const repos = createRepositories(db);

const PM_CASH = 'pm-efectivo';
const PM_TRANSF = 'pm-transferencia';

const main = async () => {
  const admin = await repos.users.findByUsername('admin');
  const { passwordHash: _p, ...safe } = admin!;
  const ctx = createServiceContext(db, safe);
  const svc = createServices(ctx);
  const cf = await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
  await repos.company.upsert({ name: 'Prueba', priceMode: 'gross', allowNegativeStock: true } as never);
  const art = await repos.articles.create({ barcode: 'A-1', description: 'Art A', listPrice1: '1000.0000', stock: '100.000' });

  const falla = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const netoDe = async (regId: string, pmId: string) =>
    (await svc.cash.getCashReport(regId)).byPaymentMethod.find((b) => b.paymentMethodId === pmId)?.net ?? '0';
  const resumenDe = async (regId: string) =>
    (await svc.cash.listHistoricalCashRegisters({ from: 0, to: Date.now() + 60_000 })).find((r) => r.id === regId)!;

  /* ------------------------------------------------------------------ */
  console.log('\n[1] Venta por transferencia anulada no sigue sumando');
  const reg1 = await svc.cash.openCashRegister('500.0000');
  const vt = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_TRANSF, amount: '1000.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  check('cobrada: Transferencia neto 1000', Number(await netoDe(reg1.id, PM_TRANSF)) === 1000, await netoDe(reg1.id, PM_TRANSF));
  await svc.sales.voidSale(vt.sale.id, 'cliente se arrepintió');
  check('anulada: Transferencia neto 0', Number(await netoDe(reg1.id, PM_TRANSF)) === 0, await netoDe(reg1.id, PM_TRANSF));
  const movsVt = (await repos.cashMovements.findByRegister(reg1.id)).filter((m) => m.relatedSaleId === vt.sale.id);
  check('hay un reverso expense con el medio Transferencia',
    movsVt.some((m) => m.type === 'expense' && m.paymentMethodId === PM_TRANSF && m.amount === '1000.0000'),
    JSON.stringify(movsVt.map((m) => [m.type, m.paymentMethodId, m.amount])));
  const rep1 = await svc.cash.getCashReport(reg1.id);
  check('el efectivo esperado no se tocó (500)', Number(rep1.expectedCash) === 500, rep1.expectedCash);
  const res1 = await resumenDe(reg1.id);
  const transfHist = res1.incomeByPaymentMethod.find((x) => x.paymentMethodId === PM_TRANSF);
  check('historial: ingresos por Transferencia = 0', Number(transfHist?.income ?? 0) === 0, transfHist?.income);
  const cierre1 = await svc.cash.closeCashRegister(reg1.id, '500.0000');
  const res1c = await resumenDe(reg1.id);
  check('al cerrar, lo depositable es sólo el efectivo contado (500)', Number(res1c.depositableAmount) === 500, res1c.depositableAmount);
  check('la venta quedó voided', (await repos.sales.findById(vt.sale.id))!.status === 'voided');
  void cierre1;

  /* ------------------------------------------------------------------ */
  console.log('\n[4] El motivo de la anulación queda en la venta');
  const anulada = (await repos.sales.findById(vt.sale.id))!;
  check('notes contiene el motivo', (anulada.notes ?? '').includes('cliente se arrepintió'), anulada.notes ?? '(sin notas)');
  check('notes contiene quién la anuló', (anulada.notes ?? '').includes(safe.fullName), anulada.notes ?? '');

  /* ------------------------------------------------------------------ */
  console.log('\n[2] Reverso de una caja ya cerrada: lo electrónico a la original, el efectivo a la abierta');
  const reg2 = await svc.cash.openCashRegister('0.0000');
  const vt2 = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_TRANSF, amount: '1000.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  const vef = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  await svc.cash.closeCashRegister(reg2.id, '1000.0000');
  const errSinCaja = await falla(() => svc.sales.voidSale(vef.sale.id));
  check('efectivo sin caja abierta: la anulación se rechaza', errSinCaja != null && /caja/i.test(errSinCaja), errSinCaja ?? 'anuló igual');
  check('la venta en efectivo sigue completed', (await repos.sales.findById(vef.sale.id))!.status === 'completed');
  const okElec = await falla(() => svc.sales.voidSale(vt2.sale.id));
  check('electrónica sin caja abierta: se anula igual (el reverso va a la caja original)', okElec == null, okElec ?? '');
  const movsVt2orig = (await repos.cashMovements.findByRegister(reg2.id)).filter((m) => m.relatedSaleId === vt2.sale.id && m.type === 'expense');
  check('el reverso electrónico quedó en la caja original, con su medio', movsVt2orig.length === 1 && movsVt2orig[0]!.paymentMethodId === PM_TRANSF && /caja cerrada/.test(movsVt2orig[0]!.description), JSON.stringify(movsVt2orig.map((m) => m.description)));
  const rep2 = await svc.cash.getCashReport(reg2.id);
  check('el arqueo de efectivo de esa caja no cambió (1000)', Number(rep2.expectedCash) === 1000, rep2.expectedCash);
  const reg3 = await svc.cash.openCashRegister('0.0000');
  await svc.sales.voidSale(vef.sale.id);
  const movsVef = (await repos.cashMovements.findByRegister(reg3.id)).filter((m) => m.relatedSaleId === vef.sale.id);
  check('el reverso en EFECTIVO entró a la caja abierta actual, aclarando que la original estaba cerrada',
    movsVef.length === 1 && movsVef[0]!.paymentMethodId === PM_CASH && /caja original cerrada/.test(movsVef[0]!.description),
    JSON.stringify(movsVef.map((m) => m.description)));
  check('la caja cerrada no recibió el reverso en efectivo',
    !(await repos.cashMovements.findByRegister(reg2.id)).some((m) => m.type === 'expense' && m.relatedSaleId === vef.sale.id));
  check('en la caja actual, Transferencia queda en 0 (nada negativo)', Number(await netoDe(reg3.id, PM_TRANSF)) === 0, await netoDe(reg3.id, PM_TRANSF));

  /* ------------------------------------------------------------------ */
  console.log('\n[3] Venta y cobranza contra una caja que se cerró en el medio');
  const errVentaCerrada = await falla(() =>
    repos.sales.createWithLines({
      type: 'X', customerId: cf!.id, sellerId: safe.id, cashRegisterId: reg2.id, isAccountSale: false,
      payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
      lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
    }),
  );
  check('venta contra caja cerrada: CASH_CLOSED', errVentaCerrada != null && /cerró|cerrada/i.test(errVentaCerrada), errVentaCerrada ?? 'entró igual');
  check('no quedó movimiento nuevo en la caja cerrada',
    (await repos.cashMovements.findByRegister(reg2.id)).filter((m) => m.type === 'income').length === 2);

  const cliCta = await repos.customers.create({ lastName: 'CLIENTE CUENTA', category: 'CF', docType: 'DNI', docNumber: '30111222' });
  const vcc = await svc.sales.createSale({
    type: 'X', customerId: cliCta.id, isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  const cuenta = (await repos.accountsReceivable.findOne({ saleId: vcc.sale.id }))!;
  const errCobranzaCerrada = await falla(() =>
    repos.payments.createPayment({
      accountId: cuenta.id, cashRegisterId: reg2.id, userId: safe.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
    }),
  );
  check('cobranza contra caja cerrada: CASH_CLOSED', errCobranzaCerrada != null && /cerró|cerrada/i.test(errCobranzaCerrada), errCobranzaCerrada ?? 'entró igual');
  check('el saldo de la cuenta no cambió', (await repos.accountsReceivable.findById(cuenta.id))!.balance === cuenta.balance);
  const okCobranza = await falla(() =>
    repos.payments.createPayment({
      accountId: cuenta.id, cashRegisterId: reg3.id, userId: safe.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
    }),
  );
  check('la misma cobranza contra la caja abierta entra', okCobranza == null, okCobranza ?? '');

  /* ------------------------------------------------------------------ */
  console.log('\n[5] Depósito parcial de un cierre con desglose real');
  // reg3: apertura 0, +1000 efectivo (cobranza), +1500 transferencia.
  await svc.cash.addMovement({ type: 'income', description: 'Venta transf', amount: '1500.0000', paymentMethodId: PM_TRANSF, cashRegisterId: reg3.id });
  await svc.cash.closeCashRegister(reg3.id, '1000.0000');
  const res3 = await resumenDe(reg3.id);
  check('depositable = 1000 efectivo + 1500 electrónico neto', Number(res3.depositableAmount) === 2500, res3.depositableAmount);
  // Primero SÓLO la parte electrónica (el caso que antes se calculaba mal).
  await svc.cashGeneral.transferFromClosed({ cashRegisterId: reg3.id, amount: '1500.00', cashAmount: '0.00', electronicAmount: '1500.00' });
  const res3b = await resumenDe(reg3.id);
  check('ya ingresado: 1500 en total', Number(res3b.depositedAmount) === 1500, res3b.depositedAmount);
  check('desglose: 0 efectivo / 1500 electrónico',
    Number(res3b.depositedCashAmount) === 0 && Number(res3b.depositedElectronicAmount) === 1500,
    `${res3b.depositedCashAmount} / ${res3b.depositedElectronicAmount}`);
  check('todavía no figura como ingresado completo', res3b.depositedToGeneral === false);
  // Completar con el efectivo.
  await svc.cashGeneral.transferFromClosed({ cashRegisterId: reg3.id, amount: '1000.00', cashAmount: '1000.00', electronicAmount: '0.00' });
  const res3c = await resumenDe(reg3.id);
  check('completo: 1000 efectivo / 1500 electrónico',
    Number(res3c.depositedCashAmount) === 1000 && Number(res3c.depositedElectronicAmount) === 1500 && res3c.depositedToGeneral,
    `${res3c.depositedCashAmount} / ${res3c.depositedElectronicAmount}`);
  const errDeMas = await falla(() =>
    svc.cashGeneral.transferFromClosed({ cashRegisterId: reg3.id, amount: '1.00', cashAmount: '1.00', electronicAmount: '0.00' }),
  );
  check('no se puede ingresar más de lo que recaudó', errDeMas != null, errDeMas ?? 'dejó');
  const saldo = await svc.cashGeneral.getBalanceBreakdown();
  check('Caja General: efectivo 1000 / electrónico 1500',
    Number(saldo.cash) === 1000 && Number(saldo.electronic) === 1500,
    `${saldo.cash} / ${saldo.electronic}`);

  /* ------------------------------------------------------------------ */
  console.log('\n[6] Tanda 7: IVA de compras con descuento, transferencias validadas');
  const reg4 = await svc.cash.openCashRegister('0.0000');
  await svc.cash.addMovement({ type: 'income', description: 'Fondeo', amount: '5000.0000', paymentMethodId: PM_CASH, cashRegisterId: reg4.id });
  const prov = await repos.suppliers.create({ code: 'P-1', name: 'Proveedor Prueba' });
  // gross: 2 × 1000 = 2000, descuento global 200 → total 1800; IVA 21% incluido
  // sobre la base CON descuento: 1800 × 21/121 = 312.3967 (antes: 347.1074).
  const cp = await svc.purchases.createPurchase({
    type: 'X', supplierId: prov.id, isAccountPurchase: false, fundingSource: 'daily', updatePrices: false,
    discount: '200.0000',
    payments: [{ paymentMethodId: PM_CASH, amount: '1800.0000' }],
    lines: [{ articleId: art.id, quantity: '2.000', costPrice: '1000.0000' }],
  } as never);
  check('compra con descuento global: total 1800', cp.purchase.total === '1800.0000', cp.purchase.total);
  check('el IVA se calcula sobre la base descontada (312.3967, no 347.1074)', cp.purchase.vatAmount === '312.3967', cp.purchase.vatAmount);
  const libro = await svc.accounting.getVatBookPurchases({ from: 0, to: Date.now() + 60_000 });
  const filaCp = libro.find((r) => r.purchaseId === cp.purchase.id);
  check('Libro IVA Compras: IVA 21% prorrateado por el descuento (312.3967)', filaCp?.vat21 === '312.3967', filaCp?.vat21);
  check('Libro IVA Compras: neto + IVA = total (1800)', filaCp != null && Math.abs(Number(filaCp.netAmount) + Number(filaCp.vat21) - 1800) < 0.001, `${filaCp?.netAmount} + ${filaCp?.vat21}`);

  const errTransfDeMas = await falla(() =>
    svc.cashGeneral.transferFromDaily({ cashRegisterId: reg4.id, amount: '99999.00' }),
  );
  check('transferir más efectivo del que hay en la caja se rechaza', errTransfDeMas != null && /efectivo/i.test(errTransfDeMas), errTransfDeMas ?? 'dejó');
  const errTransfNeg = await falla(() =>
    svc.cashGeneral.transferFromDaily({ cashRegisterId: reg4.id, amount: '-10.00' }),
  );
  check('un importe negativo se rechaza', errTransfNeg != null, errTransfNeg ?? 'dejó');
  const okTransf = await falla(() => svc.cashGeneral.transferFromDaily({ cashRegisterId: reg4.id, amount: '1000.00' }));
  check('una transferencia dentro del disponible entra', okTransf == null, okTransf ?? '');

  await svc.cash.closeCashRegister(reg4.id, '2200.0000');
  const errDesglose = await falla(() =>
    svc.cashGeneral.transferFromClosed({ cashRegisterId: reg4.id, amount: '2200.00', cashAmount: '2000.00', electronicAmount: '100.00' }),
  );
  check('un desglose que no suma el total se rechaza', errDesglose != null && /desglose/i.test(errDesglose), errDesglose ?? 'dejó');
  const errMasEfectivo = await falla(() =>
    svc.cashGeneral.transferFromClosed({ cashRegisterId: reg4.id, amount: '2500.00', cashAmount: '2500.00', electronicAmount: '0.00' }),
  );
  check('ingresar más efectivo del contado se rechaza', errMasEfectivo != null, errMasEfectivo ?? 'dejó');
  const errElecInventado = await falla(() =>
    svc.cashGeneral.transferFromClosed({ cashRegisterId: reg4.id, amount: '2300.00', cashAmount: '2200.00', electronicAmount: '100.00' }),
  );
  check('ingresar electrónico que el cierre no tuvo se rechaza', errElecInventado != null, errElecInventado ?? 'dejó');
  const okCierre = await falla(() =>
    svc.cashGeneral.transferFromClosed({ cashRegisterId: reg4.id, amount: '2200.00', cashAmount: '2200.00', electronicAmount: '0.00' }),
  );
  check('el depósito correcto del cierre entra', okCierre == null, okCierre ?? '');

  /* ------------------------------------------------------------------ */
  console.log('\n[7] Venta con débito, devuelta en efectivo y anulada: no se reintegra dos veces');
  const { ReturnsService } = await import('@stockflow/core');
  const returns = new ReturnsService(ctx);
  const reg5 = await svc.cash.openCashRegister('0.0000');
  await svc.cash.addMovement({ type: 'income', description: 'Fondeo', amount: '5000.0000', paymentMethodId: PM_CASH, cashRegisterId: reg5.id });
  const vd = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: 'pm-tarjeta-debito', amount: '2000.0000' }],
    lines: [{ articleId: art.id, quantity: '2.000' }],
  });
  await returns.createSaleReturn({ saleId: vd.sale.id, refundMethod: 'cash', lines: [{ saleLineId: vd.lines[0]!.id, quantity: '1.000' }] });
  await svc.sales.voidSale(vd.sale.id);
  const movsVd = (await repos.cashMovements.findByRegister(reg5.id)).filter((m) => m.relatedSaleId === vd.sale.id && m.type === 'expense');
  const egresosVd = movsVd.reduce((a, m) => a + Number(m.amount), 0);
  const revDebito = movsVd.find((m) => m.paymentMethodId === 'pm-tarjeta-debito');
  check('egresos totales = 2000 (1000 DEV efectivo + 1000 reverso débito), no 3000', egresosVd === 2000, `egresos=${egresosVd}`);
  check('el reverso del débito es por lo que faltaba (1000)', revDebito?.amount === '1000.0000', revDebito?.amount);
  await svc.cash.closeCashRegister(reg5.id, '0.0000');

  /* ------------------------------------------------------------------ */
  console.log('\n[8] Reverso electrónico de una caja cerrada YA ingresada a Caja General');
  const reg6 = await svc.cash.openCashRegister('0.0000');
  const vt6 = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_TRANSF, amount: '1000.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  await svc.cash.closeCashRegister(reg6.id, '0.0000');
  // Se ingresa el cierre completo (electrónico 1000) a Caja General.
  await svc.cashGeneral.transferFromClosed({ cashRegisterId: reg6.id, amount: '1000.00', cashAmount: '0.00', electronicAmount: '1000.00' });
  const cgAntes = await svc.cashGeneral.getBalanceBreakdown();
  const reg7 = await svc.cash.openCashRegister('0.0000');
  await svc.sales.voidSale(vt6.sale.id, 'prueba reverso electrónico');
  const movsReg6 = (await repos.cashMovements.findByRegister(reg6.id)).filter((m) => m.relatedSaleId === vt6.sale.id && m.type === 'expense');
  const movsReg7 = (await repos.cashMovements.findByRegister(reg7.id)).filter((m) => m.relatedSaleId === vt6.sale.id);
  check('el reverso electrónico entra a la caja ORIGINAL (cerrada), no a la de hoy', movsReg6.length === 1 && movsReg6[0]!.paymentMethodId === PM_TRANSF && movsReg7.length === 0, `orig=${movsReg6.length} hoy=${movsReg7.length}`);
  const cgDespues = await svc.cashGeneral.getBalanceBreakdown();
  check('Caja General electrónico bajó 1000 (el reintegro salió de la cuenta)', Number(cgAntes.electronic) - Number(cgDespues.electronic) === 1000, `${cgAntes.electronic} → ${cgDespues.electronic}`);
  const res6 = await resumenDe(reg6.id);
  check('el cierre original ya no tiene neto electrónico depositable', Number(res6.depositableAmount) === 0, res6.depositableAmount);
  check('en la caja de hoy Transferencia no quedó en negativo', Number(await netoDe(reg7.id, PM_TRANSF)) === 0, await netoDe(reg7.id, PM_TRANSF));
  // Caso sin depósito previo: no toca Caja General.
  const vt7 = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_TRANSF, amount: '500.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '500.0000' }],
  });
  await svc.cash.closeCashRegister(reg7.id, '0.0000');
  const reg8 = await svc.cash.openCashRegister('0.0000');
  const cg2 = await svc.cashGeneral.getBalanceBreakdown();
  await svc.sales.voidSale(vt7.sale.id);
  const cg3 = await svc.cashGeneral.getBalanceBreakdown();
  check('cierre NO ingresado: el reverso no toca Caja General', cg2.electronic === cg3.electronic, `${cg2.electronic} / ${cg3.electronic}`);
  const res7 = await resumenDe(reg7.id);
  check('…y ese cierre queda sin nada electrónico por ingresar', Number(res7.depositableAmount) === 0, res7.depositableAmount);

  /* ------------------------------------------------------------------ */
  console.log('\n[9] Caja cerrada: ingreso manual, compra contado y pago a proveedor');
  await svc.cash.closeCashRegister(reg8.id, '0.0000');
  const errManual = await falla(() =>
    repos.cashMovements.createInOpenRegister({ cashRegisterId: reg8.id, type: 'income', description: 'x', amount: '10.0000', date: Date.now(), userId: safe.id, paymentMethodId: PM_CASH }),
  );
  check('movimiento manual contra caja cerrada: CASH_CLOSED', errManual != null && /cerró/i.test(errManual), errManual ?? 'entró');
  const errCompra = await falla(() =>
    repos.purchases.createWithLines({
      type: 'X', supplierId: prov.id, paymentType: 'cash', cashRegisterId: reg8.id, userId: safe.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
      lines: [{ articleId: art.id, quantity: '1.000', costPrice: '1000.0000', salePrice: '1500.0000' }],
    } as never),
  );
  check('compra contado contra caja cerrada: CASH_CLOSED', errCompra != null && /cerró/i.test(errCompra), errCompra ?? 'entró');
  const reg9 = await svc.cash.openCashRegister('0.0000');
  await svc.cash.addMovement({ type: 'income', description: 'Fondeo', amount: '5000.0000', paymentMethodId: PM_CASH, cashRegisterId: reg9.id });
  const compraCta = await svc.purchases.createPurchase({
    type: 'X', supplierId: prov.id, isAccountPurchase: true, updatePrices: false,
    lines: [{ articleId: art.id, quantity: '1.000', costPrice: '1000.0000' }],
  } as never);
  await svc.cash.closeCashRegister(reg9.id, '5000.0000');
  const errPagoProv = await falla(() =>
    repos.supplierPayments.createPayment({
      accountId: compraCta.accountPayable!.id, cashRegisterId: reg9.id, userId: safe.id, fundingSource: 'daily',
      payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
    } as never),
  );
  check('pago a proveedor contra caja cerrada: CASH_CLOSED', errPagoProv != null && /cerró/i.test(errPagoProv), errPagoProv ?? 'entró');

  /* ------------------------------------------------------------------ */
  console.log('\n[10] Anular venta a cuenta corriente cierra la cuenta en la misma transacción');
  const reg10 = await svc.cash.openCashRegister('0.0000');
  const vcc2 = await svc.sales.createSale({
    type: 'X', customerId: cliCta.id, isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  const cta2 = (await repos.accountsReceivable.findOne({ saleId: vcc2.sale.id }))!;
  await repos.payments.createPayment({ accountId: cta2.id, cashRegisterId: reg10.id, userId: safe.id, payments: [{ paymentMethodId: PM_CASH, amount: '100.0000' }] });
  const errCcPagada = await falla(() => repos.sales.voidSale(vcc2.sale.id));
  check('con cobranzas, el repositorio rechaza la anulación', errCcPagada != null && /cobr|pago/i.test(errCcPagada), errCcPagada ?? 'anuló');
  check('la venta y la cuenta siguen', (await repos.sales.findById(vcc2.sale.id))!.status === 'completed' && (await repos.accountsReceivable.findById(cta2.id)) != null);
  const vcc3 = await svc.sales.createSale({ type: 'X', customerId: cliCta.id, isAccountSale: true, lines: [{ articleId: art.id, quantity: '1.000' }] });
  const cta3 = (await repos.accountsReceivable.findOne({ saleId: vcc3.sale.id }))!;
  await repos.sales.voidSale(vcc3.sale.id);
  check('sin cobranzas, la cuenta se borra junto con la anulación', (await repos.accountsReceivable.findById(cta3.id)) == null);

  /* ------------------------------------------------------------------ */
  console.log('\n[11] Cuenta corriente: la plata que no se cobró no se devuelve en efectivo');
  const abierta11 = await repos.cashRegisters.getCurrentOpen();
  if (abierta11) await svc.cash.closeCashRegister(abierta11.id, '0.0000');
  const reg11 = await svc.cash.openCashRegister('0.0000');
  await svc.cash.addMovement({ type: 'income', description: 'Fondeo', amount: '5000.0000', paymentMethodId: PM_CASH, cashRegisterId: reg11.id });
  const vcta = await svc.sales.createSale({
    type: 'X', customerId: cliCta.id, isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '2.000' }],
  });
  const errDevEfectivo = await falla(() =>
    returns.createSaleReturn({ saleId: vcta.sale.id, refundMethod: 'cash', lines: [{ saleLineId: vcta.lines[0]!.id, quantity: '1.000' }] }),
  );
  check('venta a cuenta impaga: la devolución en efectivo se rechaza y explica por qué',
    errDevEfectivo != null && /cuenta corriente/i.test(errDevEfectivo), errDevEfectivo ?? 'dejó devolver');
  const okDevCuenta = await falla(() =>
    returns.createSaleReturn({ saleId: vcta.sale.id, refundMethod: 'account', lines: [{ saleLineId: vcta.lines[0]!.id, quantity: '1.000' }] }),
  );
  check('la misma devolución acreditada en la cuenta sí entra', okDevCuenta == null, okDevCuenta ?? '');
  const ctaVcta = (await repos.accountsReceivable.findOne({ saleId: vcta.sale.id }))!;
  check('y le baja la deuda al cliente', Number(ctaVcta.balance) < Number(ctaVcta.total), `${ctaVcta.balance} de ${ctaVcta.total}`);

  console.log('\n[12] Cobranza por cuenta (no por comprobante) contra caja cerrada');
  const vcta2 = await svc.sales.createSale({ type: 'X', customerId: cliCta.id, isAccountSale: true, lines: [{ articleId: art.id, quantity: '1.000' }] });
  void vcta2;
  await svc.cash.closeCashRegister(reg11.id, '5000.0000');
  const errCobranzaCuenta = await falla(() =>
    repos.payments.createAccountPayment({
      customerId: cliCta.id, cashRegisterId: reg11.id, userId: safe.id,
      payments: [{ paymentMethodId: PM_CASH, amount: '100.0000' }],
    } as never),
  );
  check('cobranza a nivel cuenta con la caja cerrada: CASH_CLOSED', errCobranzaCuenta != null && /cerró|cerrada/i.test(errCobranzaCuenta), errCobranzaCuenta ?? 'entró igual');

  console.log('\n[13] Compra por transferencia anulada: también se revierte');
  const abierta13 = await repos.cashRegisters.getCurrentOpen();
  if (abierta13) await svc.cash.closeCashRegister(abierta13.id, '0.0000');
  const reg13 = await svc.cash.openCashRegister('0.0000');
  const cTransf = await svc.purchases.createPurchase({
    type: 'X', supplierId: prov.id, isAccountPurchase: false, fundingSource: 'daily', updatePrices: false,
    payments: [{ paymentMethodId: PM_TRANSF, amount: '1000.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000', costPrice: '1000.0000', salePrice: '1500.0000' }],
  } as never);
  const netoAntes13 = await netoDe(reg13.id, PM_TRANSF);
  await svc.purchases.voidPurchase(cTransf.purchase.id);
  const netoDespues13 = await netoDe(reg13.id, PM_TRANSF);
  check('la compra por transferencia deja el medio en -1000', Number(netoAntes13) === -1000, netoAntes13);
  check('al anularla, ese medio vuelve a 0', Number(netoDespues13) === 0, netoDespues13);
  const repCierre = await svc.cash.getCashReport(reg13.id);
  check('y el efectivo esperado no se movió', Number(repCierre.expectedCash) === 0, repCierre.expectedCash);

  closeLocalDb(db);
  rmSync(dir, { recursive: true, force: true });
  console.log(fallas === 0 ? '\n✅ TODO OK\n' : `\n❌ ${fallas} FALLAS\n`);
  process.exit(fallas === 0 ? 0 : 1);
};
void main();
