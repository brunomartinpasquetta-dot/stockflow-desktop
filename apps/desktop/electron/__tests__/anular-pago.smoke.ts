/**
 * Anular un pago a proveedor (Bruno, 13-oct-2026). Se verifica el ESTADO que
 * queda: deuda con el proveedor, saldo de la caja diaria o de Caja General
 * según de dónde salió el pago, estado del comprobante y del estado de cuenta;
 * bordes: dos veces, caja del pago cerrada, sin caja abierta.
 *   pnpm --filter @stockflow/desktop test:anular-pago
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { CashGeneralService, CashService, PurchasesService, SupplierAccountsService, type ServiceContext } from '@stockflow/core';

const dir = mkdtempSync(join(tmpdir(), 'stockflow-anular-pago-'));
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
  const prov = await repos.suppliers.create({ code: 'P-ANUL', name: 'Proveedor Anulación' } as never);
  const art = await repos.articles.create({ barcode: 'AP-1', description: 'Artículo', listPrice1: '100.0000', stock: '0.000' } as never);
  const factura = async (costo: string) => compras.createPurchase({ type: 'X', supplierId: prov.id, isAccountPurchase: true, updatePrices: false, discount: '0.0000', payments: [], lines: [{ articleId: art.id, quantity: '1.000', costPrice: costo }] } as never);
  const efectivoDe = async (id: string) => Number((await cash.getCashReport(id)).expectedCash);
  const saldoCG = async () => Number(await cashGeneral.getBalance());
  await cashGeneral.addIncome({ amount: '50000', description: 'Fondeo' });

  const cajaA = await cash.openCashRegister('20000.0000');
  const f1 = await factura('7000.0000');
  const f2 = await factura('9000.0000');

  // ── Pago desde la caja diaria y su anulación
  const p1 = await cuentas.payInvoice({ accountId: f1.accountPayable!.id, payments: [{ paymentMethodId: efectivo.id, amount: '7000.0000' }], expectedAmount: '7000.0000', fundingSource: 'daily' });
  check((await efectivoDe(cajaA.id)) === 13000, 'pago de 7000 desde caja diaria: caja 13000');
  const r1 = await cuentas.anularPago({ supplierPaymentId: p1.payments[0]!.id, motivo: 'factura equivocada' });
  check(r1.destino === 'daily' && Number(r1.total) === 7000, 'anular informa destino caja diaria por 7000', JSON.stringify(r1));
  check((await efectivoDe(cajaA.id)) === 20000, 'el dinero VOLVIÓ a la caja diaria (20000)', String(await efectivoDe(cajaA.id)));
  const c1 = await repos.supplierAccountsPayable.findById(f1.accountPayable!.id);
  check(c1?.status === 'open' && c1.balance === '7000.0000', 'la factura vuelve a deber 7000', `${c1?.status} ${c1?.balance}`);
  const st = await cuentas.getSupplierStatement(prov.id);
  check(st.entries.some((e) => e.kind === 'payment' && e.voided) && st.entries.some((e) => e.kind === 'void' && e.debit === '7000.0000'), 'el estado de cuenta muestra el pago anulado y su anulación');
  check(Number(st.currentBalance) === 16000, 'saldo del proveedor 16000', st.currentBalance);
  let err: string | null = null;
  try { await cuentas.anularPago({ supplierPaymentId: p1.payments[0]!.id, motivo: 'x' }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check(err != null && /ya está anulado/.test(err), 'anular dos veces se rechaza', err ?? 'dejó');

  // ── Pago desde Caja General y su anulación
  const cgAntes = await saldoCG();
  const p2 = await cuentas.payInvoice({ accountId: f2.accountPayable!.id, payments: [{ paymentMethodId: efectivo.id, amount: '9000.0000' }], expectedAmount: '9000.0000', fundingSource: 'general' });
  check((await saldoCG()) === cgAntes - 9000, 'pago de 9000 desde Caja General');
  const r2 = await cuentas.anularPago({ supplierPaymentId: p2.payments[0]!.id, motivo: 'se pagó dos veces' });
  check(r2.destino === 'general', 'anular informa destino Caja General');
  check((await saldoCG()) === cgAntes, 'el dinero VOLVIÓ a Caja General', String(await saldoCG()));
  check((await efectivoDe(cajaA.id)) === 20000, 'la caja diaria no se tocó', String(await efectivoDe(cajaA.id)));
  check((await repos.supplierAccountsPayable.findById(f2.accountPayable!.id))?.balance === '9000.0000', 'la factura vuelve a deber 9000');

  // ── Caja del pago cerrada: vuelve a la caja abierta de hoy
  const p3 = await cuentas.payInvoice({ accountId: f1.accountPayable!.id, payments: [{ paymentMethodId: efectivo.id, amount: '7000.0000' }], expectedAmount: '7000.0000', fundingSource: 'daily' });
  await cash.closeCashRegister(cajaA.id, '13000.0000', undefined, '0.0000');
  err = null;
  try { await cuentas.anularPago({ supplierPaymentId: p3.payments[0]!.id, motivo: 'x' }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check(err != null && /caja abierta/i.test(err), 'sin caja abierta: aviso claro', err ?? 'dejó');
  const cajaB = await cash.openCashRegister('1000.0000');
  const r3 = await cuentas.anularPago({ supplierPaymentId: p3.payments[0]!.id, motivo: 'factura equivocada' });
  check(r3.cajaUsada === cajaB.id && (await efectivoDe(cajaB.id)) === 8000, 'con la caja del pago cerrada, el dinero vuelve a la caja de hoy (1000 + 7000)', String(await efectivoDe(cajaB.id)));
  check((await efectivoDe(cajaA.id)) === 13000, 'la caja cerrada no se tocó', String(await efectivoDe(cajaA.id)));

  closeLocalDb(db);
}

main()
  .catch((e) => { fallas++; console.error('❌ excepción:', e); })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
    process.exit(fallas ? 1 : 0);
  });
