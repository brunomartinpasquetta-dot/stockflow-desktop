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
  console.log('\n[2] Reverso electrónico de una caja ya cerrada');
  const reg2 = await svc.cash.openCashRegister('0.0000');
  const vt2 = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_TRANSF, amount: '1000.0000' }],
    lines: [{ articleId: art.id, quantity: '1.000' }],
  });
  await svc.cash.closeCashRegister(reg2.id, '0.0000');
  const errSinCaja = await falla(() => svc.sales.voidSale(vt2.sale.id));
  check('sin caja abierta: la anulación se rechaza', errSinCaja != null && /caja/i.test(errSinCaja), errSinCaja ?? 'anuló igual');
  check('la venta sigue completed', (await repos.sales.findById(vt2.sale.id))!.status === 'completed');
  const reg3 = await svc.cash.openCashRegister('0.0000');
  await svc.sales.voidSale(vt2.sale.id);
  const movsVt2 = (await repos.cashMovements.findByRegister(reg3.id)).filter((m) => m.relatedSaleId === vt2.sale.id);
  check('el reverso entró a la caja abierta actual, aclarando que la original estaba cerrada',
    movsVt2.length === 1 && movsVt2[0]!.paymentMethodId === PM_TRANSF && /caja original cerrada/.test(movsVt2[0]!.description),
    JSON.stringify(movsVt2.map((m) => m.description)));
  check('la caja cerrada no recibió el reverso',
    !(await repos.cashMovements.findByRegister(reg2.id)).some((m) => m.type === 'expense' && m.relatedSaleId === vt2.sale.id));
  check('en la caja actual, Transferencia queda en −1000 (neto)', Number(await netoDe(reg3.id, PM_TRANSF)) === -1000, await netoDe(reg3.id, PM_TRANSF));

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
    (await repos.cashMovements.findByRegister(reg2.id)).filter((m) => m.type === 'income').length === 1);

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
  // reg3: apertura 0, +1000 efectivo (cobranza), −1000 transferencia (reverso).
  await svc.cash.addMovement({ type: 'income', description: 'Venta transf', amount: '1500.0000', paymentMethodId: PM_TRANSF, cashRegisterId: reg3.id });
  await svc.cash.closeCashRegister(reg3.id, '1000.0000');
  const res3 = await resumenDe(reg3.id);
  check('depositable = 1000 efectivo + 500 electrónico neto', Number(res3.depositableAmount) === 1500, res3.depositableAmount);
  // Primero SÓLO la parte electrónica (el caso que antes se calculaba mal).
  await svc.cashGeneral.transferFromClosed({ cashRegisterId: reg3.id, amount: '500.00', cashAmount: '0.00', electronicAmount: '500.00' });
  const res3b = await resumenDe(reg3.id);
  check('ya ingresado: 500 en total', Number(res3b.depositedAmount) === 500, res3b.depositedAmount);
  check('desglose: 0 efectivo / 500 electrónico',
    Number(res3b.depositedCashAmount) === 0 && Number(res3b.depositedElectronicAmount) === 500,
    `${res3b.depositedCashAmount} / ${res3b.depositedElectronicAmount}`);
  check('todavía no figura como ingresado completo', res3b.depositedToGeneral === false);
  // Completar con el efectivo.
  await svc.cashGeneral.transferFromClosed({ cashRegisterId: reg3.id, amount: '1000.00', cashAmount: '1000.00', electronicAmount: '0.00' });
  const res3c = await resumenDe(reg3.id);
  check('completo: 1000 efectivo / 500 electrónico',
    Number(res3c.depositedCashAmount) === 1000 && Number(res3c.depositedElectronicAmount) === 500 && res3c.depositedToGeneral,
    `${res3c.depositedCashAmount} / ${res3c.depositedElectronicAmount}`);
  const errDeMas = await falla(() =>
    svc.cashGeneral.transferFromClosed({ cashRegisterId: reg3.id, amount: '1.00', cashAmount: '1.00', electronicAmount: '0.00' }),
  );
  check('no se puede ingresar más de lo que recaudó', errDeMas != null, errDeMas ?? 'dejó');
  const saldo = await svc.cashGeneral.getBalanceBreakdown();
  check('Caja General: efectivo 1000 / electrónico 500',
    Number(saldo.cash) === 1000 && Number(saldo.electronic) === 500,
    `${saldo.cash} / ${saldo.electronic}`);

  closeLocalDb(db);
  rmSync(dir, { recursive: true, force: true });
  console.log(fallas === 0 ? '\n✅ TODO OK\n' : `\n❌ ${fallas} FALLAS\n`);
  process.exit(fallas === 0 ? 0 : 1);
};
void main();
