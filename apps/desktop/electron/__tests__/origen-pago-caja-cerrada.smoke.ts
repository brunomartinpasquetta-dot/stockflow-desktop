/**
 * Corregir el origen de un pago a proveedor cuando la caja diaria del pago YA
 * ESTÁ CERRADA (el caso real: el error se descubre al día siguiente).
 *
 * Reglas que se verifican mirando los saldos que quedan:
 *  - la caja cerrada NO se toca (su arqueo ya está hecho);
 *  - el dinero se mueve entre Caja General y la caja diaria ABIERTA de hoy,
 *    en los dos sentidos, para efectivo y para transferencia;
 *  - la deuda con el proveedor no cambia;
 *  - sin ninguna caja abierta, se avisa claro y no se mueve nada.
 *   pnpm --filter @stockflow/desktop test:origen-pago-caja-cerrada
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

const dir = mkdtempSync(join(tmpdir(), 'stockflow-origen-cerrada-'));
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
  const transferencia = metodos.find((m) => m.isPhysicalCash === false && m.active)!;
  const prov = await repos.suppliers.create({ code: 'P-CERR', name: 'Proveedor Caja Cerrada' } as never);
  const art = await repos.articles.create({ barcode: 'CERR-1', description: 'Artículo', listPrice1: '100.0000', stock: '0.000' } as never);
  const facturaACuenta = async (costo: string) =>
    compras.createPurchase({
      type: 'X', supplierId: prov.id, isAccountPurchase: true, updatePrices: false, discount: '0.0000', payments: [],
      lines: [{ articleId: art.id, quantity: '1.000', costPrice: costo }],
    } as never);
  const saldoCG = async () => Number(await cashGeneral.getBalance());
  const efectivoDe = async (id: string) => Number((await cash.getCashReport(id)).expectedCash);

  await cashGeneral.addIncome({ amount: '100000', description: 'Fondeo Caja General' });

  // ── Día 1: caja A abierta; dos pagos desde la caja diaria (efectivo y transferencia)
  // y uno desde Caja General. Después se cierra la caja A.
  const cajaA = await cash.openCashRegister('50000.0000');
  const f1 = await facturaACuenta('10000.0000');
  const pagoEfectivo = await cuentas.payInvoice({ accountId: f1.accountPayable!.id, payments: [{ paymentMethodId: efectivo.id, amount: '10000.0000' }], expectedAmount: '10000.0000', fundingSource: 'daily' });
  const f2 = await facturaACuenta('7000.0000');
  const pagoTransf = await cuentas.payInvoice({ accountId: f2.accountPayable!.id, payments: [{ paymentMethodId: transferencia.id, amount: '7000.0000' }], expectedAmount: '7000.0000', fundingSource: 'daily' });
  const f3 = await facturaACuenta('4000.0000');
  const pagoDesdeCG = await cuentas.payInvoice({ accountId: f3.accountPayable!.id, payments: [{ paymentMethodId: efectivo.id, amount: '4000.0000' }], expectedAmount: '4000.0000', fundingSource: 'general' });

  const efectivoAAlCerrar = await efectivoDe(cajaA.id);
  check(efectivoAAlCerrar === 40000, 'día 1: la caja A quedó con 50000 − 10000 de efectivo', String(efectivoAAlCerrar));
  const cierre = await cash.closeCashRegister(cajaA.id, String(efectivoAAlCerrar) + '.0000', undefined, '0.0000');
  check(cierre.register.status === 'closed', 'día 1: la caja A se cerró');
  const cgTrasCierre = await saldoCG();
  const movsCerradaAntes = db.$client.prepare('SELECT count(*) AS n FROM cash_movements WHERE cash_register_id = ?').get(cajaA.id) as { n: number };

  // ── Sin ninguna caja abierta: se avisa y no se mueve nada
  let err: string | null = null;
  try { await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoEfectivo.payments[0]!.id, nuevoOrigen: 'general' }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check(err != null && /abra la caja|caja abierta/i.test(err), 'sin caja abierta: aviso claro (hay que abrir la caja de hoy)', err ?? 'no avisó');
  check((await saldoCG()) === cgTrasCierre, 'sin caja abierta: Caja General no se movió');

  // ── Día 2: caja B abierta. Se corrigen los pagos de la caja A (cerrada).
  const cajaB = await cash.openCashRegister('20000.0000');
  const cgAntes = await saldoCG();

  // 1) efectivo, de caja diaria (cerrada) → Caja General
  const r1 = await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoEfectivo.payments[0]!.id, nuevoOrigen: 'general' });
  check(r1.destino === 'general', 'efectivo: la corrección informa destino Caja General');
  check((await efectivoDe(cajaB.id)) === 30000, 'efectivo: la caja ABIERTA de hoy recibe los 10000 devueltos', String(await efectivoDe(cajaB.id)));
  check((await saldoCG()) === cgAntes - 10000, 'efectivo: Caja General se hace cargo de los 10000', String(await saldoCG()));
  check((await repos.supplierAccountsPayable.findById(f1.accountPayable!.id))?.status === 'paid', 'efectivo: la factura sigue pagada');

  // 2) transferencia, de caja diaria (cerrada) → Caja General
  const r2 = await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoTransf.payments[0]!.id, nuevoOrigen: 'general' });
  check(r2.destino === 'general', 'transferencia: la corrección informa destino Caja General');
  check((await saldoCG()) === cgAntes - 17000, 'transferencia: Caja General se hace cargo de los 7000', String(await saldoCG()));
  const devolucionTransf = db.$client.prepare("SELECT cash_register_id AS caja FROM cash_movements WHERE supplier_payment_id = ? AND type = 'income'").all(pagoTransf.payments[0]!.id) as { caja: string }[];
  check(devolucionTransf.length === 1 && devolucionTransf[0]!.caja === cajaB.id, 'transferencia: la devolución se anota en la caja ABIERTA, no en la cerrada', JSON.stringify(devolucionTransf));

  // 3) desde Caja General → caja diaria, con la caja del día original cerrada: sale de la de hoy
  const r3 = await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoDesdeCG.payments[0]!.id, nuevoOrigen: 'daily' });
  check(r3.destino === 'daily', 'Caja General → diaria: la corrección informa destino caja diaria');
  check((await efectivoDe(cajaB.id)) === 26000, 'Caja General → diaria: los 4000 salen de la caja ABIERTA de hoy', String(await efectivoDe(cajaB.id)));
  check((await saldoCG()) === cgAntes - 17000 + 4000, 'Caja General → diaria: Caja General recupera los 4000', String(await saldoCG()));

  // ── La caja cerrada quedó intacta
  const movsCerradaDespues = db.$client.prepare('SELECT count(*) AS n FROM cash_movements WHERE cash_register_id = ?').get(cajaA.id) as { n: number };
  check(movsCerradaDespues.n === movsCerradaAntes.n, 'la caja CERRADA no recibió ningún movimiento nuevo', `${movsCerradaAntes.n} → ${movsCerradaDespues.n}`);
  check((await efectivoDe(cajaA.id)) === efectivoAAlCerrar, 'y su arqueo sigue igual', String(await efectivoDe(cajaA.id)));

  // ── La vuelta de los dos primeros, también con la caja original cerrada
  await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoEfectivo.payments[0]!.id, nuevoOrigen: 'daily' });
  await cuentas.corregirOrigenDePago({ supplierPaymentId: pagoTransf.payments[0]!.id, nuevoOrigen: 'daily' });
  check((await saldoCG()) === cgAntes + 4000, 'ida y vuelta: Caja General termina con sólo el pago 3 corregido', String(await saldoCG()));
  check((await efectivoDe(cajaB.id)) === 16000, 'ida y vuelta: la caja de hoy termina con 20000 − 4000', String(await efectivoDe(cajaB.id)));

  closeLocalDb(db);
}

main()
  .catch((e) => { fallas++; console.error('❌ excepción:', e); })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
    process.exit(fallas ? 1 : 0);
  });
