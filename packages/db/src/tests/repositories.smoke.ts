/**
 * Smoke test de la capa de repositorios (sin framework — ejecutable con `tsx`).
 *
 *   pnpm --filter @stockflow/db test:smoke:repos
 *
 * Inicializa una DB temporal, arma los repositorios con `createRepositories`,
 * ejercita los flujos principales (artículos, clientes + validación Zod, ventas
 * con líneas, caja) y limpia los archivos al terminar. Sale con código 1 si algo falla.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConstraintError,
  ValidationError,
  closeLocalDb,
  createRepositories,
  initLocalDb,
} from '../index';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}
async function expectThrows(
  label: string,
  fn: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
): Promise<void> {
  try {
    await fn();
    check(label, false, 'no lanzó ningún error');
  } catch (err) {
    check(label, predicate(err), err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-repos-smoke-'));
const dbPath = join(tmpDir, 'stockflow.db');
console.log(`\nSmoke test (repositorios) — DB temporal: ${dbPath}\n`);

async function main(): Promise<void> {
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);

  // --- contexto base (seed) -------------------------------------------
  const admin = await repos.users.findByUsername('admin');
  check('seed: usuario admin presente', !!admin, admin?.id);
  const cf = await repos.customers.findOne({ lastName: 'CONSUMIDOR FINAL' });
  check('seed: cliente CONSUMIDOR FINAL presente', !!cf, cf?.id);
  if (!admin || !cf) throw new Error('Faltan datos del seed');

  // --- articles --------------------------------------------------------
  console.log('\n[articles]');
  const art = await repos.articles.create({
    barcode: '7790000000017',
    description: 'Gaseosa cola 2.25L',
    brand: 'ColaTest',
    listPrice1: '850.0000',
    costPrice: '600.0000',
    stock: '10.000',
    minStock: '3.000',
    vatRate: '21.00',
    unit: 'UN',
  });
  check('articles.create', !!art.id && art.barcode === '7790000000017', `stock=${art.stock}`);

  const byBarcode = await repos.articles.findByBarcode('7790000000017');
  check('articles.findByBarcode', byBarcode?.id === art.id);

  // --- utilidad desde los precios actuales -----------------------------
  // Un comercio migrado entra con precios y sin utilidad. La carga masiva
  // tiene que ser el inverso EXACTO de la fórmula de las compras
  // (precio = costo × (1 + m/100), redondeado a peso), respetar lo que el
  // comercio ya cargó a mano y saltear lo que no tiene costo.
  {
    const precioPorMargen = (costo: string, m: string): number => Math.round(Number(costo) * (1 + Number(m) / 100));
    const conMargen = await repos.articles.create({
      barcode: '7799000000011', description: 'Ya tiene utilidad cargada', costPrice: '1000.0000',
      listPrice1: '1500.0000', listPrice2: '1400.0000', margin1: '33.00', vatRate: '21.00', unit: 'UN',
    });
    const sinCosto = await repos.articles.create({
      barcode: '7799000000028', description: 'Sin costo', costPrice: '0.0000', listPrice1: '900.0000', vatRate: '21.00', unit: 'UN',
    });
    const r1 = await repos.articles.recalcularMargenesDesdePrecios({ soloVacios: true });
    const a1 = await repos.articles.findById(art.id);
    const a2 = await repos.articles.findById(conMargen.id);
    const a3 = await repos.articles.findById(sinCosto.id);
    check(
      'recalcularMargenes: 600 → 850 da 41.67% y la lista 1 se reproduce redondeada',
      a1?.margin1 === '41.67' && precioPorMargen('600.0000', a1?.margin1 ?? '0') === 850,
      `margin1=${a1?.margin1}`,
    );
    check('recalcularMargenes: las listas sin precio quedan sin utilidad', a1?.margin2 == null && a1?.margin3 == null, `m2=${a1?.margin2} m3=${a1?.margin3}`);
    check(
      'recalcularMargenes (soloVacios): respeta la utilidad cargada a mano y completa la que falta',
      a2?.margin1 === '33.00' && a2?.margin2 === '40.00',
      `m1=${a2?.margin1} m2=${a2?.margin2}`,
    );
    check('recalcularMargenes: sin costo no se toca ni se inventa', a3?.margin1 == null && r1.sinCosto >= 1, `m1=${a3?.margin1} sinCosto=${r1.sinCosto}`);
    check('recalcularMargenes: cuenta lo actualizado', r1.actualizados >= 2, JSON.stringify(r1));

    const r2 = await repos.articles.recalcularMargenesDesdePrecios({ soloVacios: false });
    const a2b = await repos.articles.findById(conMargen.id);
    check('recalcularMargenes (todos): pisa la utilidad cargada con la real (1000 → 1500 = 50%)', a2b?.margin1 === '50.00', `m1=${a2b?.margin1} ${JSON.stringify(r2)}`);
  }

  await repos.articles.incrementStock(art.id, '5.000');
  const afterInc = await repos.articles.findById(art.id);
  check('articles.incrementStock', afterInc?.stock === '15.000', `stock=${afterInc?.stock}`);

  await repos.articles.decrementStock(art.id, '4.000');
  const afterDec = await repos.articles.findById(art.id);
  check('articles.decrementStock', afterDec?.stock === '11.000', `stock=${afterDec?.stock}`);

  await expectThrows(
    'articles.decrementStock con stock insuficiente lanza ConstraintError',
    () => repos.articles.decrementStock(art.id, '999.000'),
    (e) => e instanceof ConstraintError,
  );

  // artículo de baja rotación para low stock
  const lowArt = await repos.articles.create({
    barcode: '7790000000024',
    description: 'Producto escaso',
    stock: '1.000',
    minStock: '5.000',
  });
  const low = await repos.articles.findLowStock();
  check(
    'articles.findLowStock',
    low.some((a) => a.id === lowArt.id) && !low.some((a) => a.id === art.id),
    `detectados: ${low.length}`,
  );

  const search = await repos.articles.searchByText('cola');
  check('articles.searchByText', search.some((a) => a.id === art.id));

  await expectThrows(
    'articles.create con barcode duplicado lanza ConstraintError',
    () => repos.articles.create({ barcode: '7790000000017', description: 'dup' }),
    (e) => e instanceof ConstraintError,
  );

  // --- customers + validación Zod -------------------------------------
  console.log('\n[customers]');
  const cust = await repos.customers.create({
    lastName: 'PEREZ',
    firstName: 'Juan',
    category: 'RI',
    docType: 'CUIT',
    docNumber: '20-12345678-6', // CUIT con dígito verificador válido
  });
  check('customers.create (CUIT válido)', !!cust.id, `docNumber=${cust.docNumber}`);

  const found = await repos.customers.searchByText('erez');
  check('customers.searchByText', found.some((c) => c.id === cust.id));

  const byDoc = await repos.customers.findByDocNumber('20-12345678-6');
  check('customers.findByDocNumber', byDoc?.id === cust.id);

  await expectThrows(
    'customers.create con CUIT inválido lanza ValidationError',
    () => repos.customers.create({ lastName: 'X', category: 'RI', docType: 'CUIT', docNumber: '20123456789' }),
    (e) => e instanceof ValidationError,
  );
  await expectThrows(
    'customers.create con DNI inválido lanza ValidationError',
    () => repos.customers.create({ lastName: 'Y', category: 'CF', docType: 'DNI', docNumber: 'abc' }),
    (e) => e instanceof ValidationError,
  );

  // --- cash register + sales ------------------------------------------
  console.log('\n[cashRegisters + sales]');
  const reg = await repos.cashRegisters.openRegister({ openingAmount: '1000.0000', userId: admin.id });
  check('cashRegisters.openRegister', reg.status === 'open', `number=${reg.number}`);
  const current = await repos.cashRegisters.getCurrentOpen();
  check('cashRegisters.getCurrentOpen', current?.id === reg.id);
  await expectThrows(
    'cashRegisters.openRegister con caja abierta lanza ConstraintError',
    () => repos.cashRegisters.openRegister({ openingAmount: '0.0000', userId: admin.id }),
    (e) => e instanceof ConstraintError,
  );

  const PM_CASH = 'pm-efectivo';
  const PM_TRANSFER = 'pm-transferencia';
  const stockBefore = (await repos.articles.findById(art.id))!.stock;
  const { sale, lines, payments } = await repos.sales.createWithLines({
    type: 'B',
    customerId: cf.id,
    sellerId: admin.id,
    cashRegisterId: reg.id,
    isAccountSale: false,
    payments: [
      { paymentMethodId: PM_CASH, amount: '1500.0000' },
      { paymentMethodId: PM_TRANSFER, amount: '300.0000' },
    ],
    lines: [
      { articleId: art.id, quantity: '2.000', unitPrice: '850.0000', vatRate: '21.00' },
      { articleId: lowArt.id, quantity: '1.000', unitPrice: '100.0000', vatRate: '21.00' },
    ],
  });
  check('sales.createWithLines crea la venta', !!sale.id && sale.number === 1, `total=${sale.total}`);
  check('sales.createWithLines crea 2 líneas', lines.length === 2);
  check('sales.createWithLines total correcto', sale.total === '1800.0000', `total=${sale.total}`);
  check('sales.createWithLines crea 2 sale_payments', payments.length === 2);

  // --- DÍA DE CAJA (jornada) ---------------------------------------------
  // Pedido de Bruno: caja abierta el lunes, venta el martes a la 1:30 → la
  // venta es del LUNES. Pero una caja olvidada abierta días, o la "Caja
  // histórica" de una migración (abierta DESPUÉS de sus ventas), no pueden
  // arrastrar ventas a otro día: ahí manda la hora de la venta.
  {
    const raw = db.$client;
    const regOrig = raw.prepare('SELECT open_date AS o FROM cash_registers WHERE id = ?').get(reg.id) as { o: number };
    const saleOrig = raw.prepare('SELECT date AS d FROM sales WHERE id = ?').get(sale.id) as { d: number };
    const lunes20 = new Date(2026, 8, 28, 20, 0).getTime(); // lunes 28-sep 20:00
    const lunes = { from: new Date(2026, 8, 28, 0, 0).getTime(), to: new Date(2026, 8, 28, 23, 59, 59, 999).getTime() };
    const jornadaDe = () => (raw.prepare('SELECT jornada AS j FROM sales WHERE id = ?').get(sale.id) as { j: number }).j;
    raw.prepare('UPDATE cash_registers SET open_date = ? WHERE id = ?').run(lunes20, reg.id);

    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(new Date(2026, 8, 29, 1, 30).getTime(), sale.id); // martes 1:30
    check('jornada: venta del martes 1:30 con la caja del lunes abierta → es del lunes', jornadaDe() === lunes20, String(jornadaDe()));
    const porCaja = await repos.sales.findByJornadaRange(lunes.from, lunes.to);
    const porHora = await repos.sales.findByDateRange(lunes.from, lunes.to);
    check('jornada: el filtro "lunes" la trae; por hora real no', porCaja.some((s) => s.id === sale.id) && !porHora.some((s) => s.id === sale.id));
    const pagosPorCaja = await repos.salePayments.findBySaleDateRange(lunes.from, lunes.to, true);
    const pagosPorHora = await repos.salePayments.findBySaleDateRange(lunes.from, lunes.to);
    check(
      'jornada: con la opción, sus pagos caen el lunes; sin ella (por defecto) no',
      pagosPorCaja.filter((p) => p.saleId === sale.id).length === 2 && pagosPorHora.filter((p) => p.saleId === sale.id).length === 0,
    );

    const miercoles = new Date(2026, 8, 30, 10, 0).getTime(); // caja olvidada abierta: +38 h
    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(miercoles, sale.id);
    check('jornada: caja olvidada abierta días → cuenta por la hora de la venta', jornadaDe() === miercoles, String(jornadaDe()));

    const antes = new Date(2025, 0, 10, 12, 0).getTime(); // "Caja histórica": venta ANTERIOR a la apertura
    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(antes, sale.id);
    check('jornada: venta anterior a la apertura (migración) → no se mueve', jornadaDe() === antes, String(jornadaDe()));

    raw.prepare('UPDATE cash_registers SET open_date = ? WHERE id = ?').run(regOrig.o, reg.id);
    raw.prepare('UPDATE sales SET date = ? WHERE id = ?').run(saleOrig.d, sale.id);
    check('jornada: una venta normal (dentro de su caja) queda en su propio día de caja', jornadaDe() === regOrig.o || jornadaDe() === saleOrig.d);
  }

  const stockAfter = (await repos.articles.findById(art.id))!.stock;
  check(
    'sales.createWithLines descuenta stock',
    Number(stockBefore) - Number(stockAfter) === 2,
    `${stockBefore} -> ${stockAfter}`,
  );

  const movs = await repos.cashMovements.findByRegister(reg.id);
  const cashIncome = movs.find((m) => m.relatedSaleId === sale.id && m.paymentMethodId === PM_CASH);
  const transferIncome = movs.find((m) => m.relatedSaleId === sale.id && m.paymentMethodId === PM_TRANSFER);
  check(
    'sales.createWithLines genera 1 cashMovement por pago, sólo efectivo afecta el cajón',
    cashIncome?.amount === '1500.0000' && transferIncome?.amount === '300.0000',
    `efectivo=${cashIncome?.amount} transferencia=${transferIncome?.amount}`,
  );

  // Venta a cuenta corriente: sin sale_payments.
  const cust2 = await repos.customers.create({
    lastName: 'LOPEZ', firstName: 'Eva', category: 'CF', docType: 'DNI', docNumber: '30111118',
  });
  const accSale = await repos.sales.createWithLines({
    type: 'B', customerId: cust2.id, sellerId: admin.id, cashRegisterId: reg.id, isAccountSale: true,
    lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '500.0000' }],
  });
  check('sales.createWithLines a cuenta → isAccountSale, sin pagos', accSale.sale.isAccountSale === true && accSale.payments.length === 0);

  await expectThrows(
    'sales.createWithLines con pagos que no suman el total → ConstraintError',
    () => repos.sales.createWithLines({
      type: 'B', customerId: cf.id, sellerId: admin.id, cashRegisterId: reg.id, isAccountSale: false,
      payments: [{ paymentMethodId: PM_CASH, amount: '999.0000' }],
      lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '1000.0000' }],
    }),
    (e) => e instanceof ConstraintError,
  );

  const nextNum = await repos.sales.getNextNumber('B');
  check('sales.getNextNumber', nextNum === 3, `next=${nextNum}`);

  // anulación de la venta mixta → reverso de caja sólo por la parte efectivo, sale_payments eliminados
  const stockBeforeVoid = (await repos.articles.findById(art.id))!.stock;
  const voided = await repos.sales.voidSale(sale.id);
  check('sales.voidSale marca voided', voided.status === 'voided');
  const stockRestored = (await repos.articles.findById(art.id))!.stock;
  check('sales.voidSale restaura stock', Number(stockRestored) - Number(stockBeforeVoid) === 2, `${stockBeforeVoid}→${stockRestored}`);
  check('sales.voidSale elimina los sale_payments', (await repos.salePayments.findBySale(sale.id)).length === 0);
  const reversal = (await repos.cashMovements.findByRegister(reg.id)).find((m) => m.relatedSaleId === sale.id && m.type === 'expense');
  check('sales.voidSale reverso de caja sólo por efectivo (1500)', reversal?.amount === '1500.0000', `reversal=${reversal?.amount}`);

  // La empresa nace con "vender sin stock" ACTIVADO (default de producción):
  // para probar el bloqueo hay que apagarlo explícitamente.
  await repos.company.upsert({ allowNegativeStock: false } as never);
  await expectThrows(
    'sales.createWithLines con stock insuficiente revierte y lanza ConstraintError',
    () =>
      repos.sales.createWithLines({
        type: 'B',
        customerId: cf.id,
        sellerId: admin.id,
        cashRegisterId: reg.id,
        isAccountSale: false,
        payments: [{ paymentMethodId: PM_CASH, amount: '99999.0000' }],
        lines: [{ articleId: art.id, quantity: '99999.000', unitPrice: '1.0000' }],
      }),
    (e) => e instanceof ConstraintError,
  );
  // el artículo no debe haber cambiado tras el rollback
  const stockAfterRollback = (await repos.articles.findById(art.id))!.stock;
  check('sales.createWithLines rollback no toca stock', stockAfterRollback === stockRestored);
  await repos.company.upsert({ allowNegativeStock: true } as never);

  // cierre de caja
  const closed = await repos.cashRegisters.closeRegister(reg.id, { closingAmount: '1000.0000' });
  check(
    'cashRegisters.closeRegister',
    closed.status === 'closed' && typeof closed.notes === 'string' && closed.notes!.includes('Diferencia'),
    closed.notes ?? '',
  );

  // --- facturas por teléfono --------------------------------------------
  // Códigos de proveedor (el vínculo que se recuerda entre facturas), la
  // factura escaneada con sus columnas JSON y el proveedor por CUIT.
  console.log('\n[facturas escaneadas]');
  {
    const prov = await repos.suppliers.create({ code: 'PF01', name: 'Mayorista de prueba', cuit: '30-71234567-1' } as never);
    const prov2 = await repos.suppliers.create({ code: 'PF02', name: 'Otro mayorista' } as never);
    // Los proveedores migrados traen el CUIT como estaba escrito (no pasan por la validación del alta).
    db.$client.prepare("UPDATE suppliers SET cuit = '20 11222333 4' WHERE id = ?").run(prov2.id);
    const artA = await repos.articles.create({
      barcode: '7798000000011', description: 'Yerba 1kg', costPrice: '100.0000', listPrice1: '150.0000', vatRate: '21.00', unit: 'UN',
    });
    const artB = await repos.articles.create({
      barcode: '7798000000028', description: 'Azúcar 1kg', costPrice: '100.0000', listPrice1: '150.0000', vatRate: '21.00', unit: 'UN',
    });

    // suppliers.findByCuit: sólo dígitos, de los dos lados
    check('suppliers.findByCuit sin separadores (como llega del QR)', (await repos.suppliers.findByCuit('30712345671'))?.id === prov.id);
    check('suppliers.findByCuit con guiones', (await repos.suppliers.findByCuit('30-71234567-1'))?.id === prov.id);
    check('suppliers.findByCuit guardado con espacios', (await repos.suppliers.findByCuit('20112223334'))?.id === prov2.id);
    check('suppliers.findByCuit desconocido → null', (await repos.suppliers.findByCuit('30999999999')) === null);
    check('suppliers.findByCuit vacío → null (no trae proveedores sin CUIT)', (await repos.suppliers.findByCuit('')) === null && (await repos.suppliers.findByCuit('--')) === null);

    /**
     * Dar de baja en vez de borrar (8-oct-2026). El primer intento salió con
     * «error interno»: el esquema de zod no declaraba `active`, así que lo
     * descartaba y la actualización quedaba sin campos. Esta prueba mira el
     * RESULTADO (quedó inactivo), que es lo que faltaba.
     */
    const provLibre = await repos.suppliers.create({ code: 'PF03', name: 'Proveedor sin compras' } as never);
    check('un proveedor SIN movimientos se borra de verdad',
      (await repos.suppliers.borrarODarDeBaja(provLibre.id)) === 'borrado' &&
        (await repos.suppliers.findById(provLibre.id)) === null);
    // article_supplier_codes
    const codigos = repos.articleSupplierCodes;
    check('codigos.buscar sin vínculo → null', codigos.buscar(prov.id, '123456') === null);
    const v1 = codigos.guardar(prov.id, ' 123456 ', artA.id);
    check('codigos.guardar crea y recorta espacios', v1.code === '123456' && v1.articleId === artA.id);
    check('codigos.buscar encuentra el vínculo', codigos.buscar(prov.id, '123456')?.articleId === artA.id);
    const v2 = codigos.guardar(prov.id, '123456', artB.id);
    check('codigos.guardar es upsert: mismo id, artículo nuevo', v2.id === v1.id && v2.articleId === artB.id && v2.createdAt === v1.createdAt);

    // Una COMPRA es lo que de verdad ata al proveedor (el código de artículo
    // se borra en cascada). Se inserta directo para no depender del servicio.
    await repos.suppliers.create({ code: 'PF04', name: 'Cervecería de prueba' } as never);
    const provConCompras = (await repos.suppliers.findByCode('PF04'))!;
    db.$client
      .prepare(
        `INSERT INTO purchases (id, number, type, date, supplier_id, payment_type, subtotal,
           discount, vat_amount, total, status, updated_prices_on_save, created_at, updated_at)
         VALUES ('pur-baja-1', 9001, 'X', ?, ?, 'cash', '0.0000', '0.0000', '0.0000', '0.0000',
                 'completed', 0, ?, ?)`,
      )
      .run(Date.now(), provConCompras.id, Date.now(), Date.now());
    check('un proveedor CON compras queda dado de baja, no borrado',
      (await repos.suppliers.borrarODarDeBaja(provConCompras.id)) === 'dado_de_baja');
    const provBaja2 = await repos.suppliers.findById(provConCompras.id);
    check('y realmente quedó inactivo (el bug: decía dado de baja y seguía activo)',
      provBaja2 != null && provBaja2.active === false, `active=${String(provBaja2?.active)}`);
    check('se puede reactivar', (await repos.suppliers.reactivar(provConCompras.id)).active === true);

    // El vínculo por código de artículo NO alcanza para retenerlo (se borra en
    // cascada). Se usa un proveedor aparte para no romper lo que sigue.
    await repos.suppliers.create({ code: 'PF05', name: 'Sólo con código' } as never);
    const provSoloCodigo = (await repos.suppliers.findByCode('PF05'))!;
    codigos.guardar(provSoloCodigo.id, '999999', artA.id);
    check('un proveedor sólo con código de artículo se borra',
      (await repos.suppliers.borrarODarDeBaja(provSoloCodigo.id)) === 'borrado');
    codigos.guardar(prov2.id, '123456', artA.id);
    check('el mismo código en otro proveedor es otro vínculo', codigos.buscar(prov2.id, '123456')?.articleId === artA.id && codigos.buscar(prov.id, '123456')?.articleId === artB.id);
    codigos.guardar(prov.id, '000777', artA.id);
    const lista = codigos.listarPorProveedor(prov.id);
    check('codigos.listarPorProveedor sólo los de ese proveedor, por código', lista.length === 2 && lista[0]!.code === '000777' && lista[1]!.code === '123456', lista.map((c) => c.code).join(','));
    let lanzo = false;
    try { codigos.guardar(prov.id, '   ', artA.id); } catch { lanzo = true; }
    check('codigos.guardar con código vacío lanza', lanzo);
    lanzo = false;
    try { codigos.guardar(prov.id, '555', 'no-existe'); } catch { lanzo = true; }
    check('codigos.guardar con artículo inexistente lanza (FK)', lanzo);

    // scanned_invoices
    const facturas = repos.scannedInvoices;
    const f1 = facturas.crear({ createdBy: admin.id });
    check(
      'facturas.crear nace recibiendo y vacía',
      f1.status === 'recibiendo' && f1.photos.length === 0 && f1.pagesText.length === 0 && f1.lines.length === 0 &&
        f1.header === null && f1.supplierId === null && f1.pagesDone === 0 && f1.createdBy === admin.id,
    );
    check('facturas.obtener inexistente → null', facturas.obtener('no-existe') === null);
    check('facturas.siguienteEnCola sin nada en cola → null', facturas.siguienteEnCola() === null);

    const renglones = [{ codigo: '123456', descripcion: 'YERBA "X" 1KG', cantidad: 2, importe: -276.78, estado: 'ok' }];
    const f1b = facturas.actualizar(f1.id, {
      status: 'en_cola',
      photos: ['hoja-1.jpg', 'hoja-2.jpg'],
      pagesText: ['línea 1\nlínea 2', '<table><tr><td>ñ</td></tr></table>'],
      header: { cuit: '30712345678', tipoCmp: 1, importe: 1234.56 },
      lines: renglones,
      supplierId: prov.id,
      pagesDone: 1,
    });
    check(
      'facturas.actualizar serializa y devuelve los JSON tal cual',
      !!f1b && f1b.status === 'en_cola' && f1b.photos.length === 2 && f1b.pagesText[1] === '<table><tr><td>ñ</td></tr></table>' &&
        JSON.stringify(f1b.header) === JSON.stringify({ cuit: '30712345678', tipoCmp: 1, importe: 1234.56 }) &&
        JSON.stringify(f1b.lines) === JSON.stringify(renglones) && f1b.supplierId === prov.id && f1b.pagesDone === 1,
    );
    const crudo = db.$client.prepare('SELECT photos, header FROM scanned_invoices WHERE id = ?').get(f1.id) as { photos: string; header: string };
    check('en la base quedan como texto JSON', crudo.photos === '["hoja-1.jpg","hoja-2.jpg"]' && typeof crudo.header === 'string');
    const f1c = facturas.actualizar(f1.id, { error: 'Ollama apagado' });
    check('facturas.actualizar parcial no pisa lo demás', f1c?.error === 'Ollama apagado' && f1c.photos.length === 2 && f1c.status === 'en_cola' && f1c.updatedAt >= f1b!.updatedAt);
    check('facturas.actualizar puede limpiar (header/error/proveedor a null)', (() => {
      const x = facturas.actualizar(f1.id, { header: null, error: null, supplierId: null });
      const ok = !!x && x.header === null && x.error === null && x.supplierId === null;
      facturas.actualizar(f1.id, { supplierId: prov.id });
      return ok;
    })());
    check('facturas.actualizar inexistente → null', facturas.actualizar('no-existe', { status: 'error' }) === null);

    const f2 = facturas.crear();
    facturas.actualizar(f2.id, { status: 'en_cola' });
    const f3 = facturas.crear({ createdBy: null });
    check('facturas.siguienteEnCola devuelve la más vieja en cola', facturas.siguienteEnCola()?.id === f1.id);
    facturas.actualizar(f1.id, { status: 'leyendo' });
    check('facturas.siguienteEnCola avanza al cambiar el estado', facturas.siguienteEnCola()?.id === f2.id);
    const todas = facturas.listar();
    check('facturas.listar: todas, más nuevas primero', todas.length === 3 && todas[0]!.id === f3.id && todas[2]!.id === f1.id);
    const filtradas = facturas.listar({ estados: ['leyendo', 'recibiendo'] });
    check('facturas.listar por estados', filtradas.length === 2 && filtradas.every((f) => f.status !== 'en_cola'));
    check('facturas.listar con estados vacío → nada', facturas.listar({ estados: [] }).length === 0);
    check('facturas.listar respeta el límite', facturas.listar({ limite: 1 }).length === 1);
    const livianas = facturas.listar({ sinTexto: true });
    const liviana1 = livianas.find((f) => f.id === f1.id);
    check(
      'facturas.listar sinTexto: no trae el texto de las hojas y sí todo lo demás',
      livianas.length === 3 && !!liviana1 && liviana1.pagesText.length === 0 && liviana1.photos.length === 2 &&
        JSON.stringify(liviana1.lines) === JSON.stringify(renglones) && liviana1.status === 'leyendo' && liviana1.pagesDone === 1,
    );
    const cuenta = facturas.contarPorEstado();
    check(
      'facturas.contarPorEstado cuenta por estado sin traer filas',
      cuenta.leyendo === 1 && cuenta.en_cola === 1 && cuenta.recibiendo === 1 && cuenta.lista === undefined,
      JSON.stringify(cuenta),
    );
    db.$client.prepare("UPDATE scanned_invoices SET lines = '{roto', photos = 'null' WHERE id = ?").run(f3.id);
    const rota = facturas.obtener(f3.id);
    check('un JSON dañado no rompe la lectura (cae a vacío)', !!rota && rota.lines.length === 0 && rota.photos.length === 0);

    // Borrados: los vínculos se van con el artículo/proveedor; la factura queda sin proveedor.
    db.$client.prepare('DELETE FROM articles WHERE id = ?').run(artB.id);
    check('borrar el artículo se lleva su código de proveedor (cascade)', codigos.buscar(prov.id, '123456') === null);
    codigos.guardar(prov.id, '999', artA.id);
    await repos.suppliers.delete(prov.id);
    check('borrar el proveedor no se traba: se lleva sus códigos', codigos.listarPorProveedor(prov.id).length === 0 && codigos.buscar(prov2.id, '123456') !== null);
    check('…y la factura escaneada queda sin proveedor (set null)', facturas.obtener(f1.id)?.supplierId === null);
  }

  // --- company ---------------------------------------------------------
  console.log('\n[company]');
  const company1 = await repos.company.getOrCreate();
  const company2 = await repos.company.getOrCreate();
  check('company.getOrCreate idempotente', company1.id === company2.id, company1.name);

  closeLocalDb(db);
}

main()
  .catch((err) => {
    console.error('\n✗ Excepción durante el smoke test:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    failures++;
  })
  .finally(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
    if (failures > 0) {
      console.error(`\nSMOKE TEST (repositorios) FALLÓ — ${failures} check(s) con error.\n`);
      process.exit(1);
    }
    console.log('\nSMOKE TEST (repositorios) OK ✅\n');
  });
