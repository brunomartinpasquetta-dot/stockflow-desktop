/**
 * Anular una cobranza de cliente (Bruno, 13-oct-2026: «me equivoqué de
 * cliente, ¿puedo revertir ese cobro?»). Se verifica el ESTADO que queda:
 * deuda del cliente, saldo de la caja, estado del comprobante, estado de
 * cuenta, y los bordes: anular dos veces, cobro mixto, cobro a nivel cliente
 * sobre varios comprobantes, caja del cobro cerrada (sale de la de hoy) y sin
 * caja abierta.
 *   pnpm --filter @stockflow/desktop test:anular-cobro
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { AccountsReceivableService, CashService, SalesService, type ServiceContext } from '@stockflow/core';

const dir = mkdtempSync(join(tmpdir(), 'stockflow-anular-cobro-'));
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
  const ventas = new SalesService(ctx);
  const cuentas = new AccountsReceivableService(ctx);
  const metodos = await repos.paymentMethods.findAll();
  const efectivo = metodos.find((m) => m.isPhysicalCash)!;
  const transferencia = metodos.find((m) => m.isPhysicalCash === false && m.active)!;
  const art = await repos.articles.create({ barcode: 'AC-1', description: 'Artículo', listPrice1: '1000.0000', stock: '100.000' } as never);
  const cliente = await repos.customers.create({ lastName: 'CLIENTE EQUIVOCADO', category: 'CF', docType: 'DNI', docNumber: '30111333' } as never);
  const efectivoDe = async (id: string) => Number((await cash.getCashReport(id)).expectedCash);
  const deuda = async () => Number(await repos.accountsReceivable.getTotalBalance(cliente.id));

  const cajaA = await cash.openCashRegister('10000.0000');
  // Dos ventas a cuenta: 5000 y 3000.
  const ventaACuenta = async (precio: string) =>
    ventas.createSale({ type: 'X', customerId: cliente.id, isAccountSale: true, lines: [{ articleId: art.id, quantity: '1.000', unitPrice: precio }] } as never);
  await ventaACuenta('5000.0000');
  await ventaACuenta('3000.0000');
  check((await deuda()) === 8000, 'el cliente debe 8000 (dos ventas a cuenta)', String(await deuda()));
  const abiertas = await repos.accountsReceivable.findOpenByCustomer(cliente.id);
  const c5000 = abiertas.find((a) => a.total === '5000.0000')!;

  // ── Cobro por comprobante, en efectivo, y su anulación
  const cobro1 = await cuentas.receivePayment({ accountId: c5000.id, payments: [{ paymentMethodId: efectivo.id, amount: '5000.0000' }], expectedAmount: '5000.0000' });
  check((await deuda()) === 3000 && (await efectivoDe(cajaA.id)) === 15000, 'cobro de 5000 en efectivo: deuda 3000, caja 15000');
  const r1 = await cuentas.anularCobro({ paymentId: cobro1.payments[0]!.id, motivo: 'se cobró al cliente equivocado' });
  check(r1.anulados === 1 && Number(r1.total) === 5000, 'anular informa 1 cobranza por 5000', JSON.stringify(r1));
  check((await deuda()) === 8000, 'la deuda VOLVIÓ a 8000', String(await deuda()));
  check((await efectivoDe(cajaA.id)) === 10000, 'el dinero SALIÓ de la caja (vuelve a 10000)', String(await efectivoDe(cajaA.id)));
  const comp = await repos.accountsReceivable.findById(c5000.id);
  check(comp?.status === 'open' && comp.balance === '5000.0000', 'el comprobante vuelve a abierto con su saldo', `${comp?.status} ${comp?.balance}`);
  const st = await cuentas.getCustomerStatement(cliente.id);
  const anulada = st.entries.find((e) => e.kind === 'payment' && e.voided);
  const anulacion = st.entries.find((e) => e.kind === 'void');
  check(!!anulada && !!anulacion && anulacion.debit === '5000.0000', 'el estado de cuenta muestra la cobranza anulada y su anulación', JSON.stringify(st.entries.map((e) => [e.kind, e.credit, e.debit, e.voided])));
  check(Number(st.currentBalance) === 8000, 'y el saldo del estado de cuenta es 8000', st.currentBalance);
  let err: string | null = null;
  try { await cuentas.anularCobro({ paymentId: cobro1.payments[0]!.id, motivo: 'otra vez' }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check(err != null && /ya está anulada/.test(err), 'anular dos veces se rechaza', err ?? 'dejó');
  err = null;
  try { await cuentas.anularCobro({ paymentId: cobro1.payments[0]!.id, motivo: '   ' }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check(err != null, 'sin motivo se rechaza', err ?? 'dejó');

  // ── Cobro a nivel cliente, MIXTO (efectivo + transferencia), cubre los dos comprobantes
  const cobro2 = await cuentas.receivePaymentToCustomer({ customerId: cliente.id, payments: [{ paymentMethodId: efectivo.id, amount: '6000.0000' }, { paymentMethodId: transferencia.id, amount: '2000.0000' }] } as never);
  check((await deuda()) === 0, 'cobro mixto a nivel cliente: deuda 0', String(await deuda()));
  const pagoDelMixto = (await repos.payments.findByAccount(c5000.id)).find((p) => p.voidedAt == null)!;
  const r2 = await cuentas.anularCobro({ paymentId: pagoDelMixto.id, motivo: 'cliente equivocado' });
  check(r2.anulados >= 2 && Number(r2.total) === 8000, 'anular el mixto anula TODAS sus filas (dos comprobantes, dos medios) por 8000', JSON.stringify(r2));
  check((await deuda()) === 8000, 'la deuda vuelve a 8000', String(await deuda()));
  check((await efectivoDe(cajaA.id)) === 10000, 'el efectivo de la caja vuelve a 10000 (los 2000 por transferencia no son efectivo)', String(await efectivoDe(cajaA.id)));
  void cobro2;

  // ── Caja del cobro CERRADA: la salida va a la caja abierta de hoy
  const cobro3 = await cuentas.receivePayment({ accountId: c5000.id, payments: [{ paymentMethodId: efectivo.id, amount: '5000.0000' }], expectedAmount: '5000.0000' });
  await cash.closeCashRegister(cajaA.id, String(await efectivoDe(cajaA.id)) + '.0000', undefined, '0.0000');
  const movsAAntes = (db.$client.prepare('SELECT count(*) AS n FROM cash_movements WHERE cash_register_id = ?').get(cajaA.id) as { n: number }).n;
  err = null;
  try { await cuentas.anularCobro({ paymentId: cobro3.payments[0]!.id, motivo: 'x' }); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check(err != null && /caja abierta/i.test(err), 'sin caja abierta: aviso claro y no se anula', err ?? 'dejó');
  check((await deuda()) === 3000, 'y la deuda no cambió', String(await deuda()));
  const cajaB = await cash.openCashRegister('2000.0000');
  const r3 = await cuentas.anularCobro({ paymentId: cobro3.payments[0]!.id, motivo: 'cliente equivocado' });
  check(r3.cajaUsada === cajaB.id, 'con la caja del cobro cerrada, la salida va a la caja de hoy');
  check((await efectivoDe(cajaB.id)) === -3000 || (await efectivoDe(cajaB.id)) === 2000 - 5000, 'la caja de hoy registra la salida de 5000', String(await efectivoDe(cajaB.id)));
  check((await deuda()) === 8000, 'la deuda vuelve a 8000', String(await deuda()));
  const movsADespues = (db.$client.prepare('SELECT count(*) AS n FROM cash_movements WHERE cash_register_id = ?').get(cajaA.id) as { n: number }).n;
  check(movsADespues === movsAAntes, 'la caja CERRADA no recibió ningún movimiento por esta anulación', `${movsAAntes} → ${movsADespues}`);

  closeLocalDb(db);
}

main()
  .catch((e) => { fallas++; console.error('❌ excepción:', e); })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
    process.exit(fallas ? 1 : 0);
  });
