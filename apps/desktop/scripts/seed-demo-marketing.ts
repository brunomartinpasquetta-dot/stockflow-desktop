/**
 * SEEDER DE DEMO PARA MATERIAL DE MARKETING — "Ferretería del Litoral".
 *
 *   cd apps/desktop
 *   ELECTRON_RUN_AS_NODE=1 npx electron \
 *     ../../node_modules/.pnpm/tsx@<ver>/node_modules/tsx/dist/cli.mjs \
 *     scripts/seed-demo-marketing.ts
 *
 * Deja la base LOCAL de esta Mac con datos publicables para grabar videos:
 * 44 artículos reales de ferretería (importados del Excel de marketing),
 * 8 clientes con cuenta corriente, compras, ~30 ventas en 15 días, caja del
 * día abierta y presupuestos. NADA de "PRUEBA/TEST/DEMO" visible en cámara.
 *
 * Siembra por los HANDLERS IPC (patrón de seed-local.ts): stock, caja,
 * cuentas y saldos los calculan las mismas reglas de la app. La única
 * excepción es correr FECHAS hacia atrás por SQL, porque los servicios
 * sellan Date.now().
 *
 * REVERTIR: cerrar StockFlow, borrar la stockflow.db nueva y devolverle el
 * nombre al respaldo:
 *   cd "$HOME/Library/Application Support/@stockflow/desktop"
 *   mv stockflow.db stockflow.db.demo-descartada
 *   mv stockflow.db.respaldo-AAAA-MM-DD-HHMM stockflow.db
 *
 * NOTAS DE FIDELIDAD AL PEDIDO:
 *  - La ficha de empresa NO tiene campo "condición de IVA" (eso vive en la
 *    config fiscal de ARCA, fuera de esta demo). Se cargan razón social,
 *    CUIT, domicilio y teléfono.
 *  - Varios CUIT del listado no pasaban el dígito verificador que la app
 *    exige: se ajustó el ÚLTIMO dígito (invisible en cámara). El detalle se
 *    imprime al final.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { BackupService } from '../electron/backup/BackupService';
import { HardwareManager } from '../electron/hardware/HardwareManager';
import { ExcelImportService } from '../electron/import/ExcelImportService';
import { LicenseManager } from '../electron/license/LicenseManager';
import { buildAllHandlers } from '../electron/ipc/index';
import { SessionStore } from '../electron/ipc/session-store';
import type { HandlerMap } from '../electron/ipc/handler-context';
import type { IpcResponse } from '../electron/ipc/types';

const USER_DATA = join(process.env.HOME ?? '', 'Library/Application Support/@stockflow/desktop');
const DB_PATH = join(USER_DATA, 'stockflow.db');
const AQUI = dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = join(AQUI, '..', '..', '..', 'marketing', 'demo-data', 'StockFlow-demo-articulos.xlsx');
const DIA = 86_400_000;
const HOY = Date.now();

const PM = { efectivo: 'pm-efectivo', transf: 'pm-transferencia', credito: 'pm-tarjeta-credito', debito: 'pm-tarjeta-debito' } as const;

async function call<T = any>(h: HandlerMap, ch: string, p?: unknown): Promise<T> {
  const fn = h[ch];
  if (!fn) throw new Error(`canal inexistente: ${ch}`);
  const r = (await fn(p)) as IpcResponse<T>;
  if (!r.ok) throw new Error(`${ch} → ${(r as any).code}: ${(r as any).message}`);
  return (r as any).data as T;
}
const money = (n: number): string => n.toFixed(4);

process.env.STOCKFLOW_SESSION_SECRET = 'seed-demo';

async function main(): Promise<void> {
  const { db } = initLocalDb(DB_PATH); // base nueva → migra + seed obligatorio
  const repos = createRepositories(db);
  const h = buildAllHandlers({
    db, repos,
    sessionStore: new SessionStore(),
    machineId: 'seed-demo', appVersion: '0.0.0-demo',
    dbPath: DB_PATH, userDataDir: USER_DATA,
    licenseManager: new LicenseManager({ userDataDir: USER_DATA, machineId: 'seed-demo', apiUrl: 'http://localhost:1', publicKeyPem: '' }),
    hardware: new HardwareManager({ userDataDir: USER_DATA }),
    backup: new BackupService({ dbPath: DB_PATH, backupDir: USER_DATA, appVersion: '0.0.0-demo' }),
    importService: new ExcelImportService(),
    emit: () => { /* noop */ },
  });
  await call(h, 'auth:login', { username: 'admin', password: 'admin' });

  // ── a) Empresa: el membrete del ticket y del A4 sale de acá.
  await call(h, 'company:upsert', {
    name: 'Ferretería del Litoral',
    cuit: '30712345671', // 30-71234567-8 del brief no pasa el verificador → último dígito ajustado
    address: 'Av. San Martín 1240, Coronda, Santa Fe',
    phone: '3425 447812',
  });

  // Comisiones de tarjeta ANTES de vender: el arqueo tiene que mostrar neto.
  await call(h, 'paymentMethods:update', { id: PM.credito, data: { commissionPct: '4.50' } });
  await call(h, 'paymentMethods:update', { id: PM.debito, data: { commissionPct: '1.80' } });

  // ── b) 44 artículos desde el Excel de marketing (familias y proveedores solos).
  const mapping = {
    barcode: 'Codigo de barras', description: 'Descripcion', brand: 'Marca',
    familyName: 'Familia', supplierName: 'Proveedor', costPrice: 'Costo',
    listPrice1: 'Precio Lista 1', listPrice2: 'Precio Lista 2', listPrice3: 'Precio Lista 3',
    vatRate: 'IVA', stock: 'Stock', minStock: 'Stock minimo',
  };
  const val = await call<{ valid: number; errors: unknown[] }>(h, 'import:validate', { filePath: XLSX_PATH, mapping });
  if (val.valid !== 44 || val.errors.length > 0) {
    throw new Error(`el Excel no validó 44/0: ${val.valid} válidas, ${val.errors.length} errores`);
  }
  const imp = await call<{ created: number; familiesCreated: number; suppliersCreated: number }>(h, 'import:execute', {
    filePath: XLSX_PATH, mapping,
    options: { createMissingFamilies: true, createMissingSuppliers: true, skipRowsWithErrors: false },
  });
  console.log(`Importados: ${imp.created} artículos · ${imp.familiesCreated} familias · ${imp.suppliersCreated} proveedores`);

  const articulos = await call<any[]>(h, 'articles:list');
  const porCodigo = new Map(articulos.map((a) => [a.barcode, a]));
  // Para ventas a CUENTA se usan artículos de la mitad barata del catálogo:
  // el límite de crédito es una regla real de la app y una venta cara la pisa.
  const baratos = [...articulos].sort((a, b) => Number(a.listPrice1) - Number(b.listPrice1)).slice(0, Math.floor(articulos.length / 2));
  const art = (bc: string) => {
    const a = porCodigo.get(bc);
    if (!a) throw new Error(`falta el artículo ${bc}`);
    return a;
  };
  const proveedores = await call<any[]>(h, 'suppliers:list');

  // ── c) 8 clientes (CUIT con verificador corregido; el original va al log).
  const CLIENTES: Array<[string, string, string, string, string, string, number]> = [
    ['Constructora del Litoral', '30712345671', '30712345678', 'Av. San Martín 1240', 'Coronda', '3425447812', 500000],
    ['Sanitarios Yrigoyen', '30698745122', '30698745123', 'Yrigoyen 875', 'Santa Fe', '3424331209', 300000],
    ['Electricidad Belgrano', '27354789014', '27354789012', 'Belgrano 442', 'Coronda', '3425118834', 250000],
    ['Corralón San Jorge', '30655412782', '30655412789', 'Ruta 11 km 42', 'San Jorge', '3406552210', 800000],
    ['Pinturería Rivadavia', '20289456717', '20289456713', 'Rivadavia 1567', 'Santa Fe', '3424907745', 200000],
    ['Herrería Moreno', '20334567894', '20334567891', 'Moreno 233', 'Coronda', '3425664190', 150000],
    ['Obras Paraná SRL', '30711223343', '30711223344', 'Costanera 90', 'Paraná', '3434556677', 600000],
    ['Instalaciones Godoy', '20256789125', '20256789123', 'Godoy Cruz 78', 'Coronda', '3425220118', 180000],
  ];
  const clientes: Record<string, any> = {};
  for (const [nombre, cuit, original, dir, ciudad, tel, limite] of CLIENTES) {
    clientes[nombre] = await call(h, 'customers:create', {
      lastName: nombre, firstName: null, docType: 'CUIT', docNumber: cuit,
      category: 'RI', priceList: 1, creditLimit: money(limite),
      address: dir, city: ciudad, phone: tel, mobile: null, email: null, facebook: null,
    });
    if (cuit !== original) console.log(`  CUIT ajustado: ${nombre} ${original} → ${cuit}`);
  }

  // Jornadas: [díasAtrás, qué pasa]. La caja de HOY queda abierta al final.
  const registros: { id: string; delta: number }[] = [];
  const ventasACuenta: Record<string, number> = {}; // suma manual por cliente
  const cobranzas: Record<string, number> = {};
  const pagosAcorrer: { id: string; delta: number }[] = [];
  let nVentas = 0;
  let nCompras = 0;

  async function abrirCaja(delta: number, apertura: number): Promise<any> {
    const abierta = await call<any>(h, 'cash:getCurrent');
    if (abierta) {
      const rep = await call<any>(h, 'cash:getReport', { registerId: abierta.id });
      await call(h, 'cash:close', { registerId: abierta.id, closingAmount: rep.expectedCash, notes: null });
    }
    const caja = await call<any>(h, 'cash:open', { openingAmount: money(apertura) });
    registros.push({ id: caja.id, delta });
    return caja;
  }

  async function venta(cliente: any | null, lineas: { bc: string; qty: number }[], pagos: 'efectivo' | 'debito' | 'credito' | 'transf' | 'mixto' | 'cuenta'): Promise<void> {
    const ls = lineas.map((l) => ({ articleId: art(l.bc).id, quantity: `${l.qty}.000`, unitPrice: art(l.bc).listPrice1 }));
    const total = ls.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0);
    const cId = cliente ? cliente.id : (await call<any[]>(h, 'customers:list')).find((c) => c.lastName === 'CONSUMIDOR FINAL')!.id;
    let payments: { paymentMethodId: string; amount: string }[] = [];
    if (pagos === 'mixto') {
      payments = [
        { paymentMethodId: PM.efectivo, amount: money(Math.round(total / 2)) },
        { paymentMethodId: PM.debito, amount: money(total - Math.round(total / 2)) },
      ];
    } else if (pagos !== 'cuenta') {
      payments = [{ paymentMethodId: PM[pagos], amount: money(total) }];
    }
    await call(h, 'sales:create', {
      type: 'X', customerId: cId,
      isAccountSale: pagos === 'cuenta',
      payments,
      lines: ls,
    });
    nVentas++;
    if (pagos === 'cuenta' && cliente) ventasACuenta[cliente.lastName] = (ventasACuenta[cliente.lastName] ?? 0) + total;
  }

  async function compra(delta: number, provIdx: number, lineas: { bc: string; qty: number }[], nroFactura: string): Promise<void> {
    const ls = lineas.map((l) => ({ articleId: art(l.bc).id, quantity: `${l.qty}.000`, costPrice: art(l.bc).costPrice }));
    const total = ls.reduce((a, l) => a + Number(l.quantity) * Number(l.costPrice), 0);
    await call(h, 'purchases:create', {
      type: 'A', supplierId: proveedores[provIdx % proveedores.length]!.id,
      supplierInvoiceNumber: nroFactura, date: HOY - delta * DIA,
      isAccountPurchase: false, fundingSource: 'daily', updatePrices: false,
      payments: [{ paymentMethodId: PM.transf, amount: money(total) }],
      lines: ls,
    });
    nCompras++;
  }

  async function cobranzaParcial(nombre: string, delta: number): Promise<void> {
    const cuentas = await call<any[]>(h, 'accounts:listOpenByCustomer', { customerId: clientes[nombre].id });
    const abierta = cuentas.find((c) => Number(c.balance) > 0);
    if (!abierta) throw new Error(`sin cuenta abierta: ${nombre}`);
    // PARCIAL de verdad: ~40% del saldo abierto, redondeado a pesos. Un monto
    // fijo se pasaba del saldo (la app lo rechaza, con razón).
    const monto = Math.max(1, Math.round(Number(abierta.balance) * 0.4));
    const antes = Date.now();
    await call(h, 'accounts:receivePayment', {
      accountId: abierta.id,
      payments: [{ paymentMethodId: PM.efectivo, amount: money(monto) }],
    });
    cobranzas[nombre] = (cobranzas[nombre] ?? 0) + monto;
    // los pagos recién insertados se corren de fecha después, por rango temporal
    pagosAcorrer.push({ id: `ts:${antes}`, delta });
  }

  // Códigos del Excel (por familia): electricidad 14/23, sanitarios, herramientas…
  const BC = articulos.map((a) => a.barcode);
  const pick = (i: number) => BC[i % BC.length]!;

  // ── d+e) Jornadas pasadas: 3 compras + ~30 ventas repartidas en 15 días.
  const plan: Array<{ delta: number; compra?: { prov: number; nro: string }; ventas: Array<'efectivo' | 'debito' | 'credito' | 'transf' | 'mixto' | 'cuenta'>; cuentaDe?: string[] }> = [
    { delta: 18, compra: { prov: 0, nro: '0003-00014521' }, ventas: [] },
    { delta: 14, compra: { prov: 1, nro: '0001-00003318' }, ventas: ['efectivo', 'efectivo', 'debito', 'cuenta'], cuentaDe: ['Constructora del Litoral'] },
    { delta: 12, ventas: ['efectivo', 'credito', 'efectivo', 'cuenta'], cuentaDe: ['Corralón San Jorge'] },
    { delta: 9, compra: { prov: 2, nro: '0002-00008907' }, ventas: ['efectivo', 'transf', 'mixto', 'cuenta'], cuentaDe: ['Sanitarios Yrigoyen'] },
    { delta: 7, ventas: ['efectivo', 'efectivo', 'debito', 'cuenta', 'cuenta'], cuentaDe: ['Obras Paraná SRL', 'Herrería Moreno'] },
    { delta: 5, ventas: ['efectivo', 'credito', 'efectivo', 'transf'] },
    { delta: 3, ventas: ['efectivo', 'mixto', 'debito', 'cuenta'], cuentaDe: ['Constructora del Litoral'] },
    { delta: 2, ventas: ['efectivo', 'efectivo', 'credito'] },
  ];
  let vIdx = 0;
  for (const dia of plan) {
    await abrirCaja(dia.delta, 25000);
    if (dia.compra) {
      // La PRIMERA compra es la reposición grande: todo lo que vino flojo de
      // stock en el Excel entra acá — así ningún artículo queda en negativo
      // por las ventas de los días siguientes (criterio que hace fallar la
      // tarea: stock negativo no puede aparecer en cámara).
      const lineas = dia.delta === 18
        ? articulos.filter((a) => Number(a.stock) < 25).map((a) => ({ bc: a.barcode as string, qty: 30 }))
        : [{ bc: pick(vIdx), qty: 24 }, { bc: pick(vIdx + 7), qty: 36 }, { bc: pick(vIdx + 13), qty: 18 }]
      await compra(dia.delta, dia.compra.prov, lineas, dia.compra.nro);
    }
    let cuentaIdx = 0;
    for (const modo of dia.ventas) {
      const cliente = modo === 'cuenta' ? clientes[dia.cuentaDe![cuentaIdx++]!] : null;
      const lineas = modo === 'cuenta'
        ? [
            { bc: baratos[vIdx % baratos.length]!.barcode, qty: 1 + (vIdx % 2) },
            { bc: baratos[(vIdx + 5) % baratos.length]!.barcode, qty: 1 },
          ]
        : [
            { bc: pick(vIdx), qty: 1 + (vIdx % 3) },
            { bc: pick(vIdx + 11), qty: 1 + ((vIdx + 1) % 2) },
          ];
      await venta(cliente, lineas, modo);
      vIdx += 2;
    }
    // Cobranzas parciales: día -5 le cobra a Constructora, día -2 a Corralón.
    if (dia.delta === 5) await cobranzaParcial('Constructora del Litoral', 5);
    if (dia.delta === 2) await cobranzaParcial('Corralón San Jorge', 2);
  }

  // ── f) Caja de HOY, abierta, con movimientos en varios medios.
  await abrirCaja(0, 30000);
  await venta(null, [{ bc: pick(3), qty: 2 }, { bc: pick(19), qty: 1 }], 'efectivo');
  await venta(null, [{ bc: pick(8), qty: 1 }], 'debito');
  await venta(null, [{ bc: pick(24), qty: 3 }], 'transf');
  await call(h, 'cash:addMovement', { type: 'expense', amount: '8500.0000', description: 'Reparto de la mañana — combustible', paymentMethodId: PM.efectivo });
  await call(h, 'cash:addMovement', { type: 'income', amount: '15000.0000', description: 'Seña obra Costanera', paymentMethodId: PM.efectivo });

  // ── g) 2 presupuestos vigentes; uno convertido a venta (hoy, caja abierta).
  const q1 = await call<any>(h, 'quotes:create', {
    type: 'B', customerId: clientes['Obras Paraná SRL'].id, validityDays: 30,
    lines: [
      { articleId: art(pick(2)).id, quantity: '10.000', unitPrice: art(pick(2)).listPrice1 },
      { articleId: art(pick(16)).id, quantity: '4.000', unitPrice: art(pick(16)).listPrice1 },
    ],
  });
  await call(h, 'quotes:create', {
    type: 'B', customerId: clientes['Instalaciones Godoy'].id, validityDays: 30,
    lines: [{ articleId: art(pick(30)).id, quantity: '6.000', unitPrice: art(pick(30)).listPrice1 }],
  });
  const prev = await call<any>(h, 'quotes:previewConvert', { quoteId: q1.quote.id, refreshPrices: false });
  await call(h, 'quotes:convertToSale', {
    quoteId: q1.quote.id, isAccountSale: false, refreshPrices: false,
    payments: [{ paymentMethodId: PM.transf, amount: prev.total }],
  });
  nVentas++;

  closeLocalDb(db);

  // ── ÚNICA excepción por SQL: correr las fechas de las jornadas pasadas.
  const raw = new Database(DB_PATH);
  for (const r of registros) {
    if (r.delta === 0) continue;
    const d = r.delta * DIA;
    raw.prepare('UPDATE cash_registers SET open_date = open_date - ?, close_date = CASE WHEN close_date IS NULL THEN NULL ELSE close_date - ? END WHERE id = ?').run(d, d, r.id);
    raw.prepare('UPDATE cash_movements SET date = date - ? WHERE cash_register_id = ?').run(d, r.id);
    raw.prepare('UPDATE sales SET date = date - ?, created_at = created_at - ? WHERE cash_register_id = ?').run(d, d, r.id);
    raw.prepare('UPDATE accounts_receivable SET created_at = created_at - ? WHERE sale_id IN (SELECT id FROM sales WHERE cash_register_id = ?)').run(d, r.id);
  }
  for (const p of pagosAcorrer) {
    const desde = Number(p.id.slice(3)) - 2000;
    raw.prepare('UPDATE payments SET date = date - ? WHERE date >= ?').run(p.delta * DIA, desde);
  }

  // ── VERIFICACIÓN (los criterios que hacen fallar la tarea) ──────────────
  let fallas = 0;
  const negativos = raw.prepare("SELECT COUNT(*) n FROM articles WHERE CAST(stock AS REAL) < 0").get() as { n: number };
  console.log(`\n── Verificación ──`);
  console.log(`Stock negativo: ${negativos.n} artículo(s) ${negativos.n === 0 ? '✓' : '✗ FALLA'}`);
  if (negativos.n > 0) fallas++;

  const saldos = raw.prepare(`
    SELECT c.last_name nombre, printf('%.2f', SUM(CAST(ar.balance AS REAL))) saldo
    FROM accounts_receivable ar JOIN customers c ON c.id = ar.customer_id
    GROUP BY c.id HAVING SUM(CAST(ar.balance AS REAL)) > 0.005 ORDER BY c.last_name`).all() as { nombre: string; saldo: string }[];
  console.log(`Clientes con saldo: ${saldos.length}`);
  for (const sRow of saldos) {
    const esperado = (ventasACuenta[sRow.nombre] ?? 0) - (cobranzas[sRow.nombre] ?? 0);
    const ok = Math.abs(Number(sRow.saldo) - esperado) < 0.01;
    console.log(`  ${sRow.nombre}: sistema $${sRow.saldo} · manual $${esperado.toFixed(2)} ${ok ? '✓' : '✗ FALLA'}`);
    if (!ok) fallas++;
  }
  const distintos = new Set(saldos.map((x) => x.saldo));
  console.log(`Saldos distintos entre sí: ${distintos.size === saldos.length ? '✓' : '✗ FALLA'}`);
  if (distintos.size !== saldos.length) fallas++;

  const resumen = raw.prepare(`
    SELECT (SELECT COUNT(*) FROM articles) articulos,
           (SELECT COUNT(*) FROM customers WHERE last_name != 'CONSUMIDOR FINAL') clientes,
           (SELECT COUNT(*) FROM suppliers) proveedores,
           (SELECT COUNT(*) FROM families) familias,
           (SELECT COUNT(*) FROM sales) ventas,
           (SELECT COUNT(*) FROM purchases) compras,
           (SELECT COUNT(*) FROM quotes) presupuestos,
           (SELECT COUNT(*) FROM cash_registers) cajas,
           (SELECT COUNT(*) FROM cash_registers WHERE status='open') cajasAbiertas,
           (SELECT COUNT(*) FROM payments) cobranzas`).get();
  const feos = raw.prepare(`
    SELECT COUNT(*) n FROM (
      SELECT description t FROM articles UNION ALL
      SELECT last_name FROM customers UNION ALL
      SELECT name FROM suppliers UNION ALL SELECT name FROM families)
    WHERE UPPER(t) LIKE '%PRUEBA%' OR UPPER(t) LIKE '%TEST%' OR UPPER(t) LIKE '%SEED%' OR UPPER(t) LIKE '%DEMO%'`).get() as { n: number };
  console.log(`Nombres no publicables (PRUEBA/TEST/SEED/DEMO): ${feos.n} ${feos.n === 0 ? '✓' : '✗ FALLA'}`);
  if (feos.n > 0) fallas++;
  raw.close();

  console.log(`\n── Resumen ──`);
  console.log(JSON.stringify(resumen, null, 1));
  console.log(`ventas sembradas por el script: ${nVentas} · compras: ${nCompras}`);
  if (fallas > 0) { console.error(`\n✗ ${fallas} verificación(es) FALLARON`); process.exit(1); }
  console.log('\n✅ DEMO LISTA (falta el arqueo en vivo: se verifica con la app abierta)');
}

main().catch((e) => { console.error('SEED DEMO FALLÓ:', e); process.exit(1); });
