/**
 * Topes de importes y cantidades en el SERVIDOR (19-oct-2026).
 *
 * Un código de barras tipeado en un casillero numérico dejó cantidades de
 * 77.900.000.000.311 y totales de $985 mil billones. La pantalla ya lo frena,
 * pero lo que protege de verdad es el servidor: esta batería prueba que lo
 * absurdo se RECHAZA y que NO queda nada en la base (ni venta, ni renglones, ni
 * caja, ni stock movido), y que las operaciones normales —incluidos los máximos
 * REALES de las bases de los clientes— siguen pasando.
 *
 * Máximos reales (bases de Bruno, Denver y Leo Citzia; 163.181 ventas): cantidad
 * 10.800, precio unitario $654.250, total de venta $11.722.380,90 (saldo
 * migrado a cuenta corriente), pago $1.000.000, cierre de caja $4.180.660.
 *
 *   pnpm --filter @stockflow/desktop test:topes-importes
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';
import {
  CashGeneralService,
  CashService,
  InventoryService,
  PriceUpdateService,
  PromotionsService,
  PurchasesService,
  QuotesService,
  SalesService,
  type ServiceContext,
} from '@stockflow/core';
import { MENSAJE_CANTIDAD_ALTA, MENSAJE_IMPORTE_ALTO, TOPES, superaElTope } from '@stockflow/shared';

const dir = mkdtempSync(join(tmpdir(), 'stockflow-topes-'));
let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

/** Lo que dejó el lector: un EAN-13 argentino y la misma lectura pegada a un «1». */
const EAN = '7790000000031';
const EAN_PEGADO = '77900000000311';

async function main(): Promise<void> {
  const { db } = initLocalDb(join(dir, 'stockflow.db'));
  const repos = createRepositories(db);
  const admin = await repos.users.findByUsername('admin');
  if (!admin) throw new Error('falta el usuario admin del seed');
  const ctx = { db, repos, currentUser: admin } as unknown as ServiceContext;
  const ventas = new SalesService(ctx);
  const compras = new PurchasesService(ctx);
  const presupuestos = new QuotesService(ctx);
  const cash = new CashService(ctx);
  const cashGeneral = new CashGeneralService(ctx);
  const inventario = new InventoryService(ctx);
  const precios = new PriceUpdateService(ctx);
  const promos = new PromotionsService(ctx);

  const metodos = await repos.paymentMethods.findAll();
  const efectivo = metodos.find((m) => m.isPhysicalCash)!;
  const cliente = await repos.customers.create({ lastName: 'CLIENTE TOPES', category: 'CF', docType: 'DNI', docNumber: '30111444' } as never);
  const prov = await repos.suppliers.create({ code: 'P-TOPE', name: 'Proveedor Topes' } as never);
  const art = await repos.articles.create({ barcode: 'TP-1', description: 'Artículo común', listPrice1: '100.0000', stock: '500000.000' } as never);
  const art2 = await repos.articles.create({ barcode: 'TP-2', description: 'Otro artículo', listPrice1: '250.0000', stock: '10.000' } as never);

  /** Foto del estado: lo que un rechazo NO tiene que tocar. */
  async function foto() {
    const n = (t: string) => (db.$client.prepare(`select count(*) c from ${t}`).get() as { c: number }).c;
    const a = await repos.articles.findById(art.id);
    const a2 = await repos.articles.findById(art2.id);
    return JSON.stringify({
      ventas: n('sales'), renglones: n('sale_lines'), pagos: n('sale_payments'), movCaja: n('cash_movements'),
      presupuestos: n('quotes'), compras: n('purchases'), renglonesCompra: n('purchase_lines'), cuentas: n('accounts_receivable'),
      cajaGeneral: n('cash_general_movements'), cajas: n('cash_registers'), promos: n('promotions'),
      stock: a?.stock, stock2: a2?.stock, precio: a?.listPrice1, costo: a?.costPrice, precio2: a2?.listPrice1,
      cg: await cashGeneral.getBalance(),
    });
  }

  /** La operación se rechaza con el texto pedido y el estado queda IDÉNTICO. */
  async function rechaza(que: string, fn: () => Promise<unknown>, texto: RegExp | string = MENSAJE_IMPORTE_ALTO): Promise<void> {
    const antes = await foto();
    let err: string | null = null;
    try { await fn(); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    const despues = await foto();
    const dice = err != null && (typeof texto === 'string' ? err.includes(texto) : texto.test(err));
    check(err != null, `${que}: se rechaza`, 'se aceptó');
    check(dice, `${que}: el aviso es claro`, String(err));
    check(antes === despues, `${que}: NO quedó nada en la base`, `${antes}\n          ${despues}`);
  }
  async function pasa(que: string, fn: () => Promise<unknown>): Promise<void> {
    let err: string | null = null;
    try { await fn(); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    check(err == null, `${que}: pasa`, String(err));
  }

  // Caja abierta para vender (apertura típica de los comercios reales).
  await pasa('abrir la caja con $934.300 (la apertura más alta real)', async () => { await cash.openCashRegister('934300.0000'); });
  const caja = (await repos.cashRegisters.getCurrentOpen())!;

  const pagoTotal = (total: string) => [{ paymentMethodId: efectivo.id, amount: total }];
  /**
   * Cobra EXACTAMENTE el total de los renglones (cantidad × precio − descuento − descuento global), como lo hace la
   * pantalla: así lo único que puede frenar la venta es el tope, y no un pago que no cierra.
   */
  const venta = (lines: Array<Record<string, string>>, _total: string, extra: Record<string, unknown> = {}) => {
    const bruto = lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice) - Number(l.discount ?? '0'), 0);
    const total = (bruto - Number((extra.discount as string | undefined) ?? '0')).toFixed(4);
    return ventas.createSale({ type: 'X', customerId: cliente.id, payments: pagoTotal(total), lines, ...extra } as never);
  };

  // ══ 1) LO NORMAL PASA (incluidos los máximos reales de las bases) ══
  await pasa('venta común: 2 unidades a $100', () => venta([{ articleId: art.id, quantity: '2.000', unitPrice: '100.0000' }], '200.0000'));
  await pasa('venta de $210.500 (total más alto de Bruno)', () => venta([{ articleId: art.id, quantity: '1.000', unitPrice: '210500.0000' }], '210500.0000'));
  await pasa('10.800 hojas a $96 (la cantidad más alta real: Leo Citzia)', () => venta([{ articleId: art.id, quantity: '10800.000', unitPrice: '96.0000' }], '1036800.0000'));
  await pasa('100.000 unidades de un artículo barato a $50', () => venta([{ articleId: art.id, quantity: '100000.000', unitPrice: '50.0000' }], '5000000.0000'));
  await pasa('un arma de $3.000.000', () => venta([{ articleId: art2.id, quantity: '1.000', unitPrice: '3000000.0000' }], '3000000.0000'));
  await pasa('precio de $654.250 (el más alto real de Leo Citzia)', () => venta([{ articleId: art.id, quantity: '1.000', unitPrice: '654250.0000' }], '654250.0000'));
  await pasa('venta a cuenta corriente de $11.722.380,90 (el saldo más alto real)', () =>
    ventas.createSale({ type: 'X', customerId: cliente.id, isAccountSale: true, lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '11722380.9000' }] } as never));
  await pasa('descuento por renglón de $50 sobre $200', () => venta([{ articleId: art.id, quantity: '2.000', unitPrice: '100.0000', discount: '50.0000' }], '150.0000'));
  await pasa('descuento global de $20 sobre $200', () => venta([{ articleId: art.id, quantity: '2.000', unitPrice: '100.0000' }], '180.0000', { discount: '20.0000' }));
  await pasa('pago mixto que suma el total', () =>
    ventas.createSale({ type: 'X', customerId: cliente.id, payments: [{ paymentMethodId: efectivo.id, amount: '100.0000' }, { paymentMethodId: efectivo.id, amount: '100.0000' }], lines: [{ articleId: art.id, quantity: '2.000', unitPrice: '100.0000' }] } as never));
  await pasa('movimiento de caja de $2.850.000 (el más alto real)', async () => { await cash.addMovement({ type: 'income', description: 'Ingreso real', amount: '2850000.0000' } as never); });

  // ══ 2) EL CÓDIGO DE BARRAS COMO CANTIDAD, PRECIO, DESCUENTO O PAGO: SE RECHAZA ══
  await rechaza('cantidad = código de barras (7790000000031)', () => venta([{ articleId: art.id, quantity: `${EAN}.000`, unitPrice: '100.0000' }], '100.0000'), MENSAJE_CANTIDAD_ALTA);
  await rechaza('cantidad = código pegado a un 1 (77900000000311, el caso real)', () => venta([{ articleId: art.id, quantity: EAN_PEGADO, unitPrice: '100.0000' }], '100.0000'), MENSAJE_CANTIDAD_ALTA);
  await rechaza('cantidad de 1.000.001 (un paso sobre el tope)', () => venta([{ articleId: art.id, quantity: '1000001.000', unitPrice: '1.0000' }], '1000001.0000'), MENSAJE_CANTIDAD_ALTA);
  await rechaza('precio unitario = código de barras', () => venta([{ articleId: art.id, quantity: '1.000', unitPrice: EAN }], EAN));
  await rechaza('precio unitario de $100.000.001 (un paso sobre el tope)', () => venta([{ articleId: art.id, quantity: '1.000', unitPrice: '100000001.0000' }], '100000001.0000'));
  await rechaza('descuento del renglón = código de barras', () => venta([{ articleId: art.id, quantity: '1.000', unitPrice: '100.0000', discount: EAN }], '100.0000'));
  await rechaza('descuento global = código de barras', () => venta([{ articleId: art.id, quantity: '1.000', unitPrice: '100.0000' }], '100.0000', { discount: EAN }));
  await rechaza('importe de un pago = código de barras', () =>
    ventas.createSale({ type: 'X', customerId: cliente.id, payments: pagoTotal(EAN), lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '100.0000' }] } as never));
  await rechaza('total de la venta por encima del tope (1.000.000 × $100.000.000)', () => venta([{ articleId: art.id, quantity: '1000000.000', unitPrice: '100000000.0000' }], '100000000000000.0000'));
  await rechaza('venta a cuenta corriente que supera el tope (500.000 × $5.000)', () =>
    ventas.createSale({ type: 'X', customerId: cliente.id, isAccountSale: true, lines: [{ articleId: art.id, quantity: '500000.000', unitPrice: '5000.0000' }] } as never));
  await rechaza('artículo rápido con precio = código de barras', () =>
    venta([{ description: 'Cosa suelta', quantity: '1.000', unitPrice: EAN }], EAN));
  // Cantidades y precios que ni siquiera son números decimales válidos.
  for (const rara of ['1e21', 'Infinity', 'NaN', '-5', '1,5', '١٢٣']) {
    const antes = await foto();
    let err: string | null = null;
    try { await venta([{ articleId: art.id, quantity: rara, unitPrice: '100.0000' }], '100.0000'); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    check(err != null && (await foto()) === antes, `cantidad «${rara}» (notación científica, Infinity, NaN, negativa o con coma): se rechaza y no queda nada`, String(err));
  }
  await rechaza('descuento del renglón mayor que el importe (deja el renglón en negativo)', () =>
    venta([{ articleId: art.id, quantity: '1.000', unitPrice: '100.0000', discount: '150.0000' }], '100.0000'), /descuento/i);
  await rechaza('descuento global mayor que el subtotal (deja el total en negativo)', () =>
    ventas.createSale({ type: 'X', customerId: cliente.id, isAccountSale: true, discount: '500.0000', lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '100.0000' }] } as never), /descuento/i);

  // ══ 3) COMPRAS ══
  const compra = (lines: Array<Record<string, string>>, extra: Record<string, unknown> = {}) =>
    compras.createPurchase({ type: 'X', supplierId: prov.id, isAccountPurchase: true, updatePrices: false, discount: '0.0000', payments: [], lines, ...extra } as never);
  await pasa('compra normal de 96 unidades a $48.500 (máximos reales)', () => compra([{ articleId: art2.id, quantity: '96.000', costPrice: '48500.0000' }]));
  await rechaza('compra: cantidad = código de barras', () => compra([{ articleId: art.id, quantity: EAN_PEGADO, costPrice: '100.0000' }]), MENSAJE_CANTIDAD_ALTA);
  await rechaza('compra: costo = código de barras', () => compra([{ articleId: art.id, quantity: '1.000', costPrice: EAN }]));
  await rechaza('compra: precio de venta sugerido = código de barras', () => compra([{ articleId: art.id, quantity: '1.000', costPrice: '100.0000', salePrice: EAN }], { updatePrices: true }));
  await rechaza('compra: descuento = código de barras', () => compra([{ articleId: art.id, quantity: '1.000', costPrice: '100.0000' }], { discount: EAN }));

  // ══ 4) PRESUPUESTOS ══
  const presup = (lines: Array<Record<string, string>>, extra: Record<string, unknown> = {}) =>
    presupuestos.createQuote({ customerId: cliente.id, lines, ...extra } as never);
  await pasa('presupuesto normal', () => presup([{ articleId: art.id, quantity: '3.000', unitPrice: '100.0000' }]));
  await rechaza('presupuesto: cantidad = código de barras', () => presup([{ articleId: art.id, quantity: EAN, unitPrice: '100.0000' }]), MENSAJE_CANTIDAD_ALTA);
  await rechaza('presupuesto: precio = código de barras', () => presup([{ articleId: art.id, quantity: '1.000', unitPrice: EAN }]));
  await rechaza('presupuesto: descuento = código de barras', () => presup([{ articleId: art.id, quantity: '1.000', unitPrice: '100.0000' }], { discount: EAN }));

  // ══ 5) CAJA DIARIA Y CAJA GENERAL ══
  await rechaza('movimiento manual de caja = código de barras', async () => { await cash.addMovement({ type: 'income', description: 'Ingreso', amount: EAN } as never); });
  await rechaza('movimiento manual de caja de $1.000.000.001', async () => { await cash.addMovement({ type: 'income', description: 'Ingreso', amount: '1000000001.0000' } as never); });
  await rechaza('Caja General: ingreso = código de barras', async () => { await cashGeneral.addIncome({ amount: EAN, description: 'Ingreso' }); });
  await rechaza('Caja General: egreso = código de barras', async () => { await cashGeneral.addExpense({ amount: EAN, description: 'Egreso' }); });
  await pasa('Caja General: ingreso de $4.180.660 (cierre real más alto)', async () => { await cashGeneral.addIncome({ amount: '4180660.0000', description: 'Ingreso real' }); });
  await rechaza('cerrar la caja con el efectivo contado = código de barras', async () => { await cash.closeCashRegister(caja.id, EAN, undefined, '0.0000'); });
  check((await repos.cashRegisters.findById(caja.id))?.status === 'open', 'la caja sigue ABIERTA tras el cierre rechazado');
  await rechaza('cerrar la caja con el cambio que queda = código de barras', async () => { await cash.closeCashRegister(caja.id, '1000.0000', undefined, EAN); });
  await rechaza('arqueo en negativo absurdo (-código de barras)', async () => { await cash.closeCashRegister(caja.id, `-${EAN}`, undefined, '0.0000'); });
  await pasa('cierre normal con faltante real (-$110.091, sin dejar cambio)', async () => { await cash.closeCashRegister(caja.id, '-110091.0000'); });
  check((await repos.cashRegisters.findById(caja.id))?.closingAmount === '-110091.0000', 'el cierre quedó con el arqueo en rojo, releído de la base');
  await rechaza('abrir una caja con apertura = código de barras', async () => { await cash.openCashRegister(EAN); });
  check((await repos.cashRegisters.getCurrentOpen()) == null, 'no quedó ninguna caja abierta tras la apertura rechazada');

  // ══ 6) ARTÍCULOS, STOCK Y PRECIOS ══
  await rechaza('artículo nuevo con precio de lista = código de barras', async () => {
    await repos.articles.create({ barcode: 'TP-9', description: 'Nuevo', listPrice1: EAN } as never);
  });
  await rechaza('artículo nuevo con stock = código de barras', async () => {
    await repos.articles.create({ barcode: 'TP-9', description: 'Nuevo', stock: EAN } as never);
  }, MENSAJE_CANTIDAD_ALTA);
  await rechaza('editar el precio de un artículo con un código de barras', async () => { await repos.articles.update(art.id, { listPrice1: EAN } as never); });
  await rechaza('editar el costo de un artículo con un código de barras', async () => { await repos.articles.update(art.id, { costPrice: EAN } as never); });
  await rechaza('ajustar el stock a un código de barras', async () => { await inventario.adjustStock(art.id, EAN, 'prueba'); }, MENSAJE_CANTIDAD_ALTA);
  await pasa('ajustar el stock a 909 (el real más alto de Bruno)', async () => { await inventario.adjustStock(art2.id, '909.000', 'prueba'); });
  await rechaza('actualización de precios: 7790000000031 % de aumento', async () => {
    await precios.applyUpdate({ filter: { scope: 'manual', articleIds: [art.id] }, rule: { type: 'percentage', value: EAN, direction: 'increase', fields: ['listPrice1'] }, description: 'prueba' } as never);
  });
  await rechaza('actualización de precios: vista previa con 7790000000031 %', async () => {
    await precios.previewUpdate({ filter: { scope: 'manual', articleIds: [art.id] }, rule: { type: 'percentage', value: EAN, direction: 'increase', fields: ['listPrice1'] } } as never);
  });
  await rechaza('promoción con precio = código de barras', async () => {
    await promos.create({ name: 'Promo absurda', price: EAN, items: [{ articleId: art.id, quantity: '1.000' }] });
  }, /inusualmente/);
  await rechaza('promoción con cantidad = código de barras', async () => {
    await promos.create({ name: 'Promo absurda', price: '100.0000', items: [{ articleId: art.id, quantity: EAN }] });
  }, /inusualmente/);
  await rechaza('cliente con límite de crédito = código de barras', async () => {
    await repos.customers.create({ lastName: 'CLIENTE LIMITE', category: 'CF', docType: 'DNI', docNumber: '30111555', creditLimit: EAN } as never);
  });

  // ══ 6 bis) LA ÚLTIMA LÍNEA: el repositorio, sin pasar por los servicios (IPC directo, red local, terminal vieja) ══
  const abierta = await cash.openCashRegister('1000.0000');
  const exacto = async (que: string, fn: () => Promise<unknown>, texto: string): Promise<void> => {
    const antes = await foto();
    let err: string | null = null;
    try { await fn(); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    check(err === texto, `${que}: el aviso llega SOLO, sin prefijo técnico`, String(err));
    check(antes === (await foto()), `${que}: no quedó nada`);
  };
  await exacto('repositorio de ventas con cantidad = código', () =>
    repos.sales.createWithLines({ type: 'X', customerId: cliente.id, sellerId: admin.id, cashRegisterId: abierta.id, payments: pagoTotal('100.0000'), lines: [{ articleId: art.id, quantity: EAN_PEGADO, unitPrice: '100.0000' }] }), MENSAJE_CANTIDAD_ALTA);
  await exacto('repositorio de ventas con precio = código', () =>
    repos.sales.createWithLines({ type: 'X', customerId: cliente.id, sellerId: admin.id, cashRegisterId: abierta.id, payments: pagoTotal('100.0000'), lines: [{ articleId: art.id, quantity: '1.000', unitPrice: EAN }] }), MENSAJE_IMPORTE_ALTO);
  await exacto('repositorio de ventas con pago = código', () =>
    repos.sales.createWithLines({ type: 'X', customerId: cliente.id, sellerId: admin.id, cashRegisterId: abierta.id, payments: pagoTotal(EAN), lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '100.0000' }] }), MENSAJE_IMPORTE_ALTO);
  await exacto('repositorio de compras con cantidad = código', () =>
    repos.purchases.createWithLines({ type: 'X', supplierId: prov.id, paymentType: 'credit', userId: admin.id, lines: [{ articleId: art.id, quantity: EAN, costPrice: '1.0000', salePrice: '1.0000' }] }), MENSAJE_CANTIDAD_ALTA);
  await exacto('repositorio de movimientos de caja con importe = código', () =>
    repos.cashMovements.createInOpenRegister({ cashRegisterId: abierta.id, type: 'income', description: 'x', amount: EAN, userId: admin.id, date: Date.now() }), MENSAJE_IMPORTE_ALTO);
  await exacto('repositorio de caja: apertura = código', () =>
    repos.cashRegisters.openRegister({ openingAmount: EAN, userId: admin.id }), MENSAJE_IMPORTE_ALTO);
  await cash.closeCashRegister(abierta.id, '1000.0000', undefined, '0.0000');

  // ══ 7) LOS TOPES SE AJUSTAN EN UN SOLO LUGAR ══
  check(TOPES.cantidad >= 100_000 * 10 && TOPES.cantidad > 10_800 * 50, 'tope de cantidad con margen sobre 100.000 unidades y sobre el real (10.800)', String(TOPES.cantidad));
  check(TOPES.precio >= 3_000_000 * 10 && TOPES.precio > 654_250 * 50, 'tope de precio con margen sobre un arma de $3.000.000 y sobre el real ($654.250)', String(TOPES.precio));
  check(TOPES.importe > 11_722_380.9 * 50, 'tope de importe con margen sobre el total más alto real ($11.722.380,90)', String(TOPES.importe));
  check(superaElTope(EAN, 'importe') && superaElTope(`${EAN}.000`, 'cantidad') && !superaElTope('654250', 'precio'), 'superaElTope distingue un código de un precio normal');
  check(superaElTope('1e999', 'importe') && superaElTope('NaN', 'importe') && !superaElTope('', 'importe'), 'superaElTope: infinito y NaN se cuentan como excedidos; vacío no');

  closeLocalDb(db);
}

main()
  .catch((e) => { fallas++; console.error('❌ excepción:', e); })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
    process.exit(fallas ? 1 : 0);
  });
