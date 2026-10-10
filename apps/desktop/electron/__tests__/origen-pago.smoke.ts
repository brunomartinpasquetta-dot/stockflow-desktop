/**
 * Corregir de dónde salió la plata de un pago a proveedor.
 *
 * El caso real (cliente, 8-oct-2026): pagaron eligiendo «caja diaria» cuando
 * el dinero salió de Caja General. Se verifica el ESTADO que queda —saldos de
 * las dos cajas y saldo del proveedor—, no lo que la función dice que hizo.
 *   pnpm --filter @stockflow/desktop test:origen-pago
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import {
  CashGeneralService,
  CashService,
  PurchasesService,
  SupplierAccountsService,
  type ServiceContext,
} from '@stockflow/core';

const dir = mkdtempSync(join(tmpdir(), 'stockflow-origen-pago-'));
let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

async function main(): Promise<void> {
  const { db } = initLocalDb(join(dir, 'stockflow.db'));
  const repos = createRepositories(db);
  const admin = await repos.users.findByUsername('admin');
  if (!admin) throw new Error('falta el usuario admin del seed');
  const ctx = { db, repos, currentUser: admin } as unknown as ServiceContext;
  const cash = new CashService(ctx);
  const cashGeneral = new CashGeneralService(ctx);
  const compras = new PurchasesService(ctx);
  const cuentas = new SupplierAccountsService(ctx);

  const metodos = await repos.paymentMethods.findAll();
  const efectivo = metodos.find((m) => m.isPhysicalCash)!;
  const prov = await repos.suppliers.create({ code: 'P-ORIG', name: 'Proveedor Origen' } as never);
  const art = await repos.articles.create({
    barcode: 'ORIG-1',
    description: 'Artículo de prueba',
    listPrice1: '100.0000',
    stock: '0.000',
  } as never);

  // Caja diaria abierta con fondos, y Caja General con fondos.
  const reg = await cash.openCashRegister('0.0000');
  await cash.addMovement({
    type: 'income',
    description: 'Fondeo',
    amount: '50000.0000',
    paymentMethodId: efectivo.id,
    cashRegisterId: reg.id,
  });
  await cashGeneral.addIncome({ amount: '80000', description: 'Fondeo Caja General' });

  // Compra A CUENTA → queda la deuda.
  const compra = await compras.createPurchase({
    type: 'X',
    supplierId: prov.id,
    isAccountPurchase: true,
    updatePrices: false,
    discount: '0.0000',
    payments: [],
    lines: [{ articleId: art.id, quantity: '1.000', costPrice: '10000.0000' }],
  } as never);
  const cuentaId = compra.accountPayable!.id;

  // ── El error: se paga eligiendo CAJA DIARIA, pero la plata era de Caja General
  const cajaAntes = Number((await cash.getCashReport(reg.id)).expectedCash);
  const cgAntes = Number(await cashGeneral.getBalance());
  const pago = await cuentas.payInvoice({
    accountId: cuentaId,
    payments: [{ paymentMethodId: efectivo.id, amount: '10000.0000' }],
    expectedAmount: '10000.0000',
    fundingSource: 'daily',
  });
  const cajaPago = Number((await cash.getCashReport(reg.id)).expectedCash);
  check(cajaPago === cajaAntes - 10000, 'el pago descontó de la caja diaria', `${cajaAntes} → ${cajaPago}`);
  check(Number(await cashGeneral.getBalance()) === cgAntes, 'Caja General no se tocó todavía');
  check(pago.account.balance === '0.0000', 'la factura quedó pagada', pago.account.balance);

  // ── La corrección
  const pagoId = pago.payments[0]!.id;
  const r = await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoId, nuevoOrigen: 'general' });
  check(r.destino === 'general', 'la corrección informa el destino');

  const cajaDespues = Number((await cash.getCashReport(reg.id)).expectedCash);
  const cgDespues = Number(await cashGeneral.getBalance());
  check(
    cajaDespues === cajaAntes,
    'LA CAJA DIARIA VOLVIÓ A SU SALDO (se le devolvió el dinero)',
    `esperado ${cajaAntes}, quedó ${cajaDespues}`,
  );
  check(
    cgDespues === cgAntes - 10000,
    'CAJA GENERAL PAGÓ los 10000',
    `esperado ${cgAntes - 10000}, quedó ${cgDespues}`,
  );
  const cuentaTrasCorregir = await repos.supplierAccountsPayable.findById(cuentaId);
  check(
    cuentaTrasCorregir?.balance === '0.0000' && cuentaTrasCorregir.status === 'paid',
    'la deuda con el proveedor NO cambió: la factura sigue pagada',
    `${cuentaTrasCorregir?.balance} / ${cuentaTrasCorregir?.status}`,
  );

  // ── Corregir dos veces no duplica nada
  let err: string | null = null;
  try {
    await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoId, nuevoOrigen: 'general' });
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check(err != null, 'corregir al mismo origen se rechaza', err ?? 'dejó');
  check(
    Number(await cashGeneral.getBalance()) === cgDespues,
    'y los saldos no se movieron por el intento repetido',
  );

  // ── La vuelta: de Caja General a la caja diaria
  const r2 = await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoId, nuevoOrigen: 'daily' });
  check(r2.destino === 'daily', 'se puede corregir en el otro sentido');
  check(
    Number(await cashGeneral.getBalance()) === cgAntes,
    'Caja General recuperó su saldo',
    String(await cashGeneral.getBalance()),
  );
  check(
    Number((await cash.getCashReport(reg.id)).expectedCash) === cajaAntes - 10000,
    'y la caja diaria volvió a pagar',
  );

  // ── UN PAGO VIEJO: el que se hizo ANTES de esta versión, sin el enlace ni el
  // origen guardado. Es el caso real del cliente, y es el que tiene que andar.
  const compra2 = await compras.createPurchase({
    type: 'X',
    supplierId: prov.id,
    isAccountPurchase: true,
    updatePrices: false,
    discount: '0.0000',
    payments: [],
    lines: [{ articleId: art.id, quantity: '1.000', costPrice: '5000.0000' }],
  } as never);
  const pagoViejo = await cuentas.payInvoice({
    accountId: compra2.accountPayable!.id,
    payments: [{ paymentMethodId: efectivo.id, amount: '5000.0000' }],
    expectedAmount: '5000.0000',
    fundingSource: 'daily',
  });
  // Se simula un pago de la versión anterior: sin origen guardado y sin enlace.
  db.$client.prepare('UPDATE supplier_payments SET funding_source = NULL WHERE id = ?').run(
    pagoViejo.payments[0]!.id,
  );
  db.$client.prepare('UPDATE cash_movements SET supplier_payment_id = NULL WHERE supplier_payment_id = ?').run(
    pagoViejo.payments[0]!.id,
  );

  const cajaAntesViejo = Number((await cash.getCashReport(reg.id)).expectedCash);
  const cgAntesViejo = Number(await cashGeneral.getBalance());
  await cuentas.corregirOrigenDePago({
    supplierPaymentId: pagoViejo.payments[0]!.id,
    nuevoOrigen: 'general',
  });
  check(
    Number((await cash.getCashReport(reg.id)).expectedCash) === cajaAntesViejo + 5000,
    'UN PAGO VIEJO (sin el dato guardado) también se corrige: la caja diaria recupera su plata',
    `${cajaAntesViejo} → ${(await cash.getCashReport(reg.id)).expectedCash}`,
  );
  check(
    Number(await cashGeneral.getBalance()) === cgAntesViejo - 5000,
    'y Caja General se hace cargo del pago viejo',
    String(await cashGeneral.getBalance()),
  );

  closeLocalDb(db);
}

main()
  .catch((err) => {
    console.error('\n✗ Excepción:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    fallas++;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
    process.exit(fallas ? 1 : 0);
  });
