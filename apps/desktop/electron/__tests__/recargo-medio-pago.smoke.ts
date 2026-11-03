/**
 * RECARGO POR MEDIO DE PAGO (1.18.4): porcentaje que paga el CLIENTE por usar un
 * medio (por ejemplo, 10 % con tarjeta de crédito). Distinto de la comisión,
 * que la absorbe el comercio.
 *   pnpm --filter @stockflow/desktop test:recargo-medio-pago
 *
 * La pantalla de Ventas suma el recargo como un renglón más de la venta
 * («Recargo Tarjeta de crédito 10 %») y se lo agrega al pago de ese medio. Acá
 * se prueba lo que queda en la base por el mismo camino que usa la pantalla
 * (servicios reales), con los mismos números que calcula la pantalla
 * (`calculateSaleTotals`), en modo de precios con IVA incluido y en modo neto.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { createServiceContext, createServices } from '@stockflow/core';
import { calculateSaleTotals } from '../../src/lib/pricing';

let fallas = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) fallas++;
  console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`);
};
const num = (v: string | number) => Math.round(Number(v) * 100) / 100;

/** Lo que arma la pantalla: renglón del recargo y pago con el recargo sumado. */
function conRecargo(
  lineas: { description: string; quantity: string; unitPrice: string; discount: string; vatRate: string }[],
  pagos: { paymentMethodId: string; amount: number }[],
  medios: { id: string; name: string; surchargePct: string }[],
  priceMode: 'gross' | 'net',
  descuentoGlobal = '0',
) {
  const totalBase = Number(calculateSaleTotals(lineas, descuentoGlobal, priceMode).total);
  const recargos = pagos
    .map((p) => ({ p, m: medios.find((m) => m.id === p.paymentMethodId)! }))
    .filter(({ m }) => Number(m.surchargePct) > 0)
    .map(({ p, m }) => ({ paymentMethodId: p.paymentMethodId, nombre: m.name, pct: Number(m.surchargePct), importe: Math.round(p.amount * Number(m.surchargePct)) / 100 }));
  const lineasRecargo = recargos.map((r) => ({
    description: `Recargo ${r.nombre} ${r.pct} %`,
    quantity: '1',
    unitPrice: (priceMode === 'gross' ? r.importe : r.importe / 1.21).toFixed(4),
    discount: '0',
    vatRate: '21.00',
  }));
  const totalACobrar = Number(calculateSaleTotals([...lineas, ...lineasRecargo], descuentoGlobal, priceMode).total);
  const out = pagos.map((p) => ({ ...p }));
  for (const r of recargos) {
    const p = out.find((x) => x.paymentMethodId === r.paymentMethodId);
    if (p) p.amount += r.importe;
  }
  const diff = totalACobrar - out.reduce((a, p) => a + p.amount, 0);
  const ajuste = out.find((x) => recargos.some((r) => r.paymentMethodId === x.paymentMethodId)) ?? out[0];
  if (ajuste && Math.abs(diff) > 0.00001) ajuste.amount += diff;
  return { totalBase, totalACobrar, lineas: [...lineas, ...lineasRecargo], pagos: out.map((p) => ({ paymentMethodId: p.paymentMethodId, amount: p.amount.toFixed(4) })), recargos };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'recargo-'));
  const { db } = initLocalDb(join(dir, 'x.db'));
  const repos = createRepositories(db);
  const admin = await repos.users.findByUsername('admin');
  const { passwordHash: _p, ...safe } = admin!;
  const ctx = createServiceContext(db, safe);
  const svc = createServices(ctx);
  const cf = (await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' }))!;
  await svc.cash.openCashRegister('0.0000');

  console.log('\n[1] El campo nuevo');
  const tarjeta = (await repos.paymentMethods.findByType('credit_card'))[0]!;
  const efectivo = (await repos.paymentMethods.getEfectivo())!;
  check('de fábrica el recargo es 0 en todos los medios', (await repos.paymentMethods.findOrdered()).every((m) => Number(m.surchargePct) === 0));
  await repos.paymentMethods.update(tarjeta.id, { surchargePct: '10' });
  check('se guarda y se relee: Tarjeta de crédito 10 %', Number((await repos.paymentMethods.findById(tarjeta.id))!.surchargePct) === 10);
  let rechazo = '';
  try { await repos.paymentMethods.update(tarjeta.id, { surchargePct: '150' }); } catch (e) { rechazo = (e as Error).message; }
  check('un recargo de 150 % se rechaza', /entre 0 y 100/.test(rechazo), rechazo);
  rechazo = '';
  try { await repos.paymentMethods.update(tarjeta.id, { surchargePct: '7791234567890' }); } catch (e) { rechazo = (e as Error).message; }
  check('un código de barras tipeado como recargo se rechaza', rechazo !== '');
  check('la comisión no se tocó', Number((await repos.paymentMethods.findById(tarjeta.id))!.commissionPct) === 0);
  const medios = (await repos.paymentMethods.findOrdered()).map((m) => ({ id: m.id, name: m.name, surchargePct: m.surchargePct }));

  const venta = async (armado: ReturnType<typeof conRecargo>, discount = '0') =>
    svc.sales.createSale({
      type: 'X', customerId: cf.id, isAccountSale: false, discount,
      payments: armado.pagos,
      lines: armado.lineas.map((l) => ({ ...l, articleId: undefined })),
    } as never);
  /** Se relee TODO de la base: el total de la venta, sus renglones y sus pagos. */
  const leer = async (r: { sale: { id: string }; lines: { description: string | null; lineTotal: string; vatRate: string }[] }) => {
    const s = (await repos.sales.findById(r.sale.id))!;
    const pagos = await repos.salePayments.findBySale(r.sale.id);
    return { total: num(s.total), lines: r.lines.map((l) => ({ d: l.description, t: num(l.lineTotal), iva: l.vatRate })), pagos: pagos.map((p) => ({ pm: p.paymentMethodId, a: num(p.amount), com: num(p.commissionAmount) })) };
  };
  const base = [{ description: 'FACTURAS DOCENA', quantity: '1', unitPrice: '100', discount: '0', vatRate: '21.00' }];

  console.log('\n[2] Sin recargo, todo igual que siempre (efectivo)');
  const a0 = conRecargo(base, [{ paymentMethodId: efectivo.id, amount: 100 }], medios, 'gross');
  const r0 = await leer(await venta(a0));
  check('vendo 100 en efectivo: total 100, un solo renglón, pago 100', r0.total === 100 && r0.lines.length === 1 && r0.pagos[0]!.a === 100, JSON.stringify(r0));

  console.log('\n[3] Con tarjeta al 10 %: el cliente paga 110');
  const a1 = conRecargo(base, [{ paymentMethodId: tarjeta.id, amount: 100 }], medios, 'gross');
  check('la pantalla calcula: base 100, a cobrar 110, recargo 10', a1.totalBase === 100 && num(a1.totalACobrar) === 110 && a1.recargos[0]!.importe === 10);
  const r1 = await leer(await venta(a1));
  check('queda: total 110, renglón «Recargo Tarjeta de crédito 10 %» de 10, pago con tarjeta 110', r1.total === 110 && r1.lines.length === 2 && r1.lines[1]!.d === `Recargo ${tarjeta.name} 10 %` && r1.lines[1]!.t === 10 && r1.pagos[0]!.a === 110, JSON.stringify(r1));

  console.log('\n[4] Pago mixto: 50 efectivo + 50 tarjeta → el recargo sólo sobre la tarjeta');
  const a2 = conRecargo(base, [{ paymentMethodId: efectivo.id, amount: 50 }, { paymentMethodId: tarjeta.id, amount: 50 }], medios, 'gross');
  const r2 = await leer(await venta(a2));
  const ef = r2.pagos.find((p) => p.pm === efectivo.id)!, tj = r2.pagos.find((p) => p.pm === tarjeta.id)!;
  check('total 105: efectivo 50 y tarjeta 55', r2.total === 105 && ef.a === 50 && tj.a === 55, JSON.stringify(r2));

  console.log('\n[5] Con descuento global y recargo: el recargo va sobre lo que paga de verdad');
  const a3 = conRecargo(base, [{ paymentMethodId: tarjeta.id, amount: 90 }], medios, 'gross', '10');
  const r3 = await leer(await venta(a3, '10'));
  check('100 con 10 de descuento = 90; con tarjeta 10 % = 99', r3.total === 99 && r3.pagos[0]!.a === 99, JSON.stringify(r3));

  console.log('\n[6] Comisión y recargo conviven: la comisión se calcula sobre lo que pagó el cliente');
  await repos.paymentMethods.update(tarjeta.id, { commissionPct: '3' });
  const a4 = conRecargo(base, [{ paymentMethodId: tarjeta.id, amount: 100 }], medios, 'gross');
  const r4 = await leer(await venta(a4));
  check('pago 110, comisión 3,30 (3 % de 110), total de la venta 110', r4.total === 110 && r4.pagos[0]!.a === 110 && r4.pagos[0]!.com === 3.3, JSON.stringify(r4));
  await repos.paymentMethods.update(tarjeta.id, { commissionPct: '0' });

  console.log('\n[7] Precios netos (sin IVA en la lista): el recargo también cierra');
  await repos.company.upsert({ name: 'Prueba', priceMode: 'net' } as never);
  const baseNeto = [{ description: 'FACTURAS DOCENA', quantity: '1', unitPrice: '100', discount: '0', vatRate: '21.00' }];
  const a5 = conRecargo(baseNeto, [{ paymentMethodId: tarjeta.id, amount: 121 }], medios, 'net');
  check('la pantalla: base 121 (100 + IVA), a cobrar 133,10', num(a5.totalBase) === 121 && num(a5.totalACobrar) === 133.1, `${a5.totalBase} → ${a5.totalACobrar}`);
  const r5 = await leer(await venta(a5));
  check('queda total 133,10 y el pago cierra exacto con el total', r5.total === 133.1 && r5.pagos[0]!.a === 133.1, JSON.stringify(r5));
  await repos.company.upsert({ name: 'Prueba', priceMode: 'gross' } as never);

  console.log('\n[8] La caja refleja lo que pagó el cliente');
  const caja = (await repos.cashRegisters.getCurrentOpen())!;
  const resumen = await svc.cash.getCashReport(caja.id);
  const porTarjeta = resumen.byPaymentMethod.find((b) => b.paymentMethodId === tarjeta.id);
  check('ingresos de la caja = suma de las ventas con recargo', num(resumen.salesTotal) === num(100 + 110 + 105 + 99 + 110 + 133.1), `${resumen.salesTotal}`);
  check('por tarjeta entró lo cobrado con recargo', !!porTarjeta && num(porTarjeta.incomeTotal) === num(110 + 55 + 99 + 110 + 133.1), JSON.stringify(porTarjeta));

  closeLocalDb(db);
  rmSync(dir, { recursive: true, force: true });
  console.log(fallas === 0 ? '\n✅ TODO OK\n' : `\n❌ ${fallas} FALLAS\n`);
  process.exit(fallas === 0 ? 0 : 1);
}
void main();
