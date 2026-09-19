/**
 * DEVOLUCIONES — plata y stock que no se duplican (auditoría sep-2026, tanda 1).
 *   pnpm --filter @stockflow/desktop test:devoluciones
 *
 * Escenarios reales que antes fallaban:
 *   1. Venta 2u efectivo → DEV 1u → anular: el stock volvía dos veces (11 en vez
 *      de 10) y la caja devolvía $3000 sobre $2000 cobrados.
 *   2. Lo mismo en compras con devolución al proveedor previa.
 *   3. Venta con descuento global devolvía el importe SIN el descuento; en modo
 *      'net' devolvía el neto sin IVA (menos de lo que el cliente pagó).
 *   4. Reintegro en efectivo de una venta cobrada con débito dejaba la caja en
 *      negativo: no miraba el efectivo disponible.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import { ReturnsService, createServiceContext, createServices } from '@stockflow/core';

let fallas = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (!ok) fallas++;
  console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'devoluciones-'));
const { db } = initLocalDb(join(dir, 'x.db'));
const repos = createRepositories(db);

const PM_CASH = 'pm-efectivo';
const PM_DEBITO = 'pm-tarjeta-debito';

const main = async () => {
  const admin = await repos.users.findByUsername('admin');
  const { passwordHash: _p, ...safe } = admin!;
  const ctx = createServiceContext(db, safe);
  const svc = createServices(ctx);
  const returns = new ReturnsService(ctx);
  const cf = await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
  await repos.company.upsert({ name: 'Prueba', priceMode: 'gross', allowNegativeStock: true } as never);

  const reg = await svc.cash.openCashRegister('0.0000');
  // Fondeo: las compras y los reintegros en efectivo salen del cajón.
  await svc.cash.addMovement({ type: 'income', description: 'Fondeo', amount: '10000.0000', paymentMethodId: PM_CASH });

  const stockDe = async (id: string) => (await repos.articles.findById(id))!.stock;
  const movimientosDe = async (filtro: (m: { relatedSaleId: string | null; relatedPurchaseId: string | null }) => boolean) =>
    (await repos.cashMovements.findByRegister(reg.id)).filter(filtro);
  const sumar = (xs: Array<{ amount: string }>) => xs.reduce((a, m) => a + Number(m.amount), 0);
  const falla = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  /* ------------------------------------------------------------------ */
  console.log('\n[1] Anular una venta con devolución previa');
  const artA = await repos.articles.create({ barcode: 'A-1', description: 'Art A', listPrice1: '1000.0000', stock: '10.000' });
  const v1 = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '2000.0000' }],
    lines: [{ articleId: artA.id, quantity: '2.000' }],
  });
  check('venta 2u: stock 8', (await stockDe(artA.id)) === '8.000', await stockDe(artA.id));
  const d1 = await returns.createSaleReturn({
    saleId: v1.sale.id, refundMethod: 'cash',
    lines: [{ saleLineId: v1.lines[0]!.id, quantity: '1.000' }],
  });
  check('DEV 1u: reintegra $1000 y stock 9', d1.ret.total === '1000.0000' && (await stockDe(artA.id)) === '9.000', `${d1.ret.total} / ${await stockDe(artA.id)}`);
  await svc.sales.voidSale(v1.sale.id);
  check('anular después de la DEV: stock vuelve a 10 (no 11)', (await stockDe(artA.id)) === '10.000', await stockDe(artA.id));
  const egresosV1 = await movimientosDe((m) => m.relatedSaleId === v1.sale.id);
  const salidasV1 = sumar(egresosV1.filter((m) => m.type === 'expense'));
  check('la caja devolvió $2000 en total (DEV + anulación), no $3000', salidasV1 === 2000, `egresos=${salidasV1}`);

  const v1b = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
    lines: [{ articleId: artA.id, quantity: '1.000' }],
  });
  await returns.createSaleReturn({ saleId: v1b.sale.id, refundMethod: 'cash', lines: [{ saleLineId: v1b.lines[0]!.id, quantity: '1.000' }] });
  const errTodoDevuelto = await falla(() => svc.sales.voidSale(v1b.sale.id));
  check('venta ya devuelta por completo: la anulación se rechaza', errTodoDevuelto != null, errTodoDevuelto ?? 'anuló igual');
  check('… y el stock no se movió', (await stockDe(artA.id)) === '10.000', await stockDe(artA.id));

  /* ------------------------------------------------------------------ */
  console.log('\n[2] Anular una compra con devolución al proveedor previa');
  const artB = await repos.articles.create({ barcode: 'B-1', description: 'Art B', listPrice1: '2000.0000', costPrice: '1000.0000', stock: '10.000' });
  const prov = await repos.suppliers.create({ name: 'Proveedor', code: 'P1' } as never);
  const c1 = await svc.purchases.createPurchase({
    type: 'X', supplierId: prov.id, isAccountPurchase: false, fundingSource: 'daily', updatePrices: false,
    payments: [{ paymentMethodId: PM_CASH, amount: '2000.0000' }],
    lines: [{ articleId: artB.id, quantity: '2.000', costPrice: '1000.0000' }],
  });
  check('compra 2u: stock 12', (await stockDe(artB.id)) === '12.000', await stockDe(artB.id));
  const dp1 = await returns.createPurchaseReturn({
    purchaseId: c1.purchase.id, refundMethod: 'cash',
    lines: [{ purchaseLineId: c1.lines[0]!.id, quantity: '1.000' }],
  });
  check('DPC 1u: entra $1000 y stock 11', dp1.ret.total === '1000.0000' && (await stockDe(artB.id)) === '11.000', `${dp1.ret.total} / ${await stockDe(artB.id)}`);
  await svc.purchases.voidPurchase(c1.purchase.id);
  check('anular después de la DPC: stock vuelve a 10 (no 9)', (await stockDe(artB.id)) === '10.000', await stockDe(artB.id));
  const movsC1 = await movimientosDe((m) => m.relatedPurchaseId === c1.purchase.id);
  const entradasC1 = sumar(movsC1.filter((m) => m.type === 'income'));
  check('la caja recuperó $2000 en total (DPC + anulación), no $3000', entradasC1 === 2000, `ingresos=${entradasC1}`);

  const c1b = await svc.purchases.createPurchase({
    type: 'X', supplierId: prov.id, isAccountPurchase: false, fundingSource: 'daily', updatePrices: false,
    payments: [{ paymentMethodId: PM_CASH, amount: '1000.0000' }],
    lines: [{ articleId: artB.id, quantity: '1.000', costPrice: '1000.0000' }],
  });
  await returns.createPurchaseReturn({ purchaseId: c1b.purchase.id, refundMethod: 'cash', lines: [{ purchaseLineId: c1b.lines[0]!.id, quantity: '1.000' }] });
  const errCompraDevuelta = await falla(() => svc.purchases.voidPurchase(c1b.purchase.id));
  check('compra ya devuelta por completo: la anulación se rechaza', errCompraDevuelta != null, errCompraDevuelta ?? 'anuló igual');
  check('… y el stock no se movió', (await stockDe(artB.id)) === '10.000', await stockDe(artB.id));

  /* ------------------------------------------------------------------ */
  console.log('\n[3] La devolución reintegra lo que el cliente PAGÓ');
  const v3 = await svc.sales.createSale({
    type: 'X', customerId: cf!.id, discount: '100.0000',
    payments: [{ paymentMethodId: PM_CASH, amount: '900.0000' }],
    lines: [{ articleId: artA.id, quantity: '1.000' }],
  });
  check('venta $1000 con descuento $100: total 900', v3.sale.total === '900.0000', v3.sale.total);
  const d3 = await returns.createSaleReturn({ saleId: v3.sale.id, refundMethod: 'cash', lines: [{ saleLineId: v3.lines[0]!.id, quantity: '1.000' }] });
  check('devolución total reintegra $900 (no $1000)', d3.ret.total === '900.0000', d3.ret.total);

  // Parcial con descuento y dos líneas: cada unidad se devuelve con su parte del descuento.
  const v3b = await svc.sales.createSale({
    type: 'X', customerId: cf!.id, discount: '300.0000',
    payments: [{ paymentMethodId: PM_CASH, amount: '2700.0000' }],
    lines: [{ articleId: artA.id, quantity: '2.000' }, { articleId: artB.id, quantity: '0.500' }],
  });
  const d3b = await returns.createSaleReturn({ saleId: v3b.sale.id, refundMethod: 'cash', lines: [{ saleLineId: v3b.lines[0]!.id, quantity: '1.000' }] });
  check('parcial: 1u de $1000 con 10 % de descuento global → $900', d3b.ret.total === '900.0000', d3b.ret.total);
  const d3c = await returns.createSaleReturn({
    saleId: v3b.sale.id, refundMethod: 'cash',
    lines: [{ saleLineId: v3b.lines[0]!.id, quantity: '1.000' }, { saleLineId: v3b.lines[1]!.id, quantity: '0.500' }],
  });
  check('el resto cierra exacto: Σ reintegros = total de la venta', Number(d3b.ret.total) + Number(d3c.ret.total) === 2700, `${d3b.ret.total} + ${d3c.ret.total}`);

  await repos.company.upsert({ priceMode: 'net' } as never);
  const v3n = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
    lines: [{ articleId: artA.id, quantity: '1.000' }],
  });
  check('modo net: venta 1×$1000 neto cobra 1210', v3n.sale.total === '1210.0000', v3n.sale.total);
  const d3n = await returns.createSaleReturn({ saleId: v3n.sale.id, refundMethod: 'cash', lines: [{ saleLineId: v3n.lines[0]!.id, quantity: '1.000' }] });
  check('modo net: la devolución reintegra 1210 con IVA (no 1000)', d3n.ret.total === '1210.0000', d3n.ret.total);
  await repos.company.upsert({ priceMode: 'gross' } as never);

  /* ------------------------------------------------------------------ */
  console.log('\n[4] Reintegro en efectivo sólo si hay efectivo en la caja');
  const disponible = (await svc.cash.getCashReport(reg.id)).expectedCash;
  const v4 = await svc.sales.createSale({
    type: 'X', customerId: cf!.id,
    payments: [{ paymentMethodId: PM_DEBITO, amount: '50000.0000' }],
    lines: [{ articleId: artA.id, quantity: '1.000', unitPrice: '50000.0000' }],
  });
  const errSinEfectivo = await falla(() =>
    returns.createSaleReturn({ saleId: v4.sale.id, refundMethod: 'cash', lines: [{ saleLineId: v4.lines[0]!.id, quantity: '1.000' }] }),
  );
  check(`venta $50.000 con débito, caja con $${Number(disponible)}: la DEV en efectivo se rechaza`, errSinEfectivo != null, errSinEfectivo ?? 'devolvió igual');
  const despues = (await svc.cash.getCashReport(reg.id)).expectedCash;
  check('el efectivo esperado no quedó en negativo', despues === disponible && Number(despues) >= 0, `antes=${disponible} después=${despues}`);
  check('no se registró la devolución', (await returns.listBySale(v4.sale.id)).length === 0);

  /* ------------------------------------------------------------------ */
  console.log('\n[5] Devolución de COMPRA con descuento global y en modo net');
  const artC = await repos.articles.create({ barcode: 'C-1', description: 'Art C', listPrice1: '1500.0000', stock: '10.000' });
  const c5 = await svc.purchases.createPurchase({
    type: 'X', supplierId: prov.id, isAccountPurchase: false, fundingSource: 'daily', updatePrices: false,
    discount: '200.0000',
    payments: [{ paymentMethodId: PM_CASH, amount: '1800.0000' }],
    lines: [{ articleId: artC.id, quantity: '2.000', costPrice: '1000.0000' }],
  } as never);
  check('compra 2×1000 con $200 de descuento: total 1800', c5.purchase.total === '1800.0000', c5.purchase.total);
  const dpc5a = await returns.createPurchaseReturn({ purchaseId: c5.purchase.id, refundMethod: 'cash', lines: [{ purchaseLineId: c5.lines[0]!.id, quantity: '1.000' }] });
  check('DPC 1u reintegra 900 (con su parte del descuento), no 1000', dpc5a.ret.total === '900.0000', dpc5a.ret.total);
  const dpc5b = await returns.createPurchaseReturn({ purchaseId: c5.purchase.id, refundMethod: 'cash', lines: [{ purchaseLineId: c5.lines[0]!.id, quantity: '1.000' }] });
  check('la segunda DPC completa exactamente los 1800 pagados', dpc5b.ret.total === '900.0000' && Number(dpc5a.ret.total) + Number(dpc5b.ret.total) === 1800, dpc5b.ret.total);

  await repos.company.upsert({ priceMode: 'net' } as never);
  const c5n = await svc.purchases.createPurchase({
    type: 'X', supplierId: prov.id, isAccountPurchase: false, fundingSource: 'daily', updatePrices: false,
    payments: [{ paymentMethodId: PM_CASH, amount: '1210.0000' }],
    lines: [{ articleId: artC.id, quantity: '1.000', costPrice: '1000.0000' }],
  } as never);
  check('modo net: compra 1×1000 neto paga 1210', c5n.purchase.total === '1210.0000', c5n.purchase.total);
  const dpc5n = await returns.createPurchaseReturn({ purchaseId: c5n.purchase.id, refundMethod: 'cash', lines: [{ purchaseLineId: c5n.lines[0]!.id, quantity: '1.000' }] });
  check('modo net: la DPC reintegra 1210 con IVA (no 1000)', dpc5n.ret.total === '1210.0000', dpc5n.ret.total);
  await repos.company.upsert({ priceMode: 'gross' } as never);

  closeLocalDb(db);
  rmSync(dir, { recursive: true, force: true });
  console.log(fallas === 0 ? '\n✅ TODO OK\n' : `\n❌ ${fallas} FALLAS\n`);
  process.exit(fallas === 0 ? 0 : 1);
};
void main();
