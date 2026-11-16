/**
 * SALDO INICIAL DE STOCKFÁCIL (1.18.6).
 *   pnpm --filter @stockflow/desktop test:saldo-inicial-stockfacil
 *
 * Bruno (16-nov-2026, resumen de Villanueva): la migración dejaba el saldo
 * inicial ya neto de las entregas viejas y además traía esas entregas, así que
 * el estado de cuenta las descontaba dos veces (saldo renglón a renglón en
 * negativo, saldo real correcto abajo). La migración 0045 corrige las cuentas
 * ya instaladas: total = saldo + entregas, sólo en las sintéticas de StockFácil.
 *
 * Arma cuatro cuentas, mira el estado ANTES, aplica la 0045 como la aplica la
 * app (el SQL tal cual), y mira lo que quedó: las dos sintéticas con el
 * problema se corrigen; la normal de StockFlow y la sintética sana no cambian.
 * Con RESUMEN_SEED_DIR=<carpeta> deja la cuenta de Villanueva SIN corregir en
 * <carpeta>/stockflow.db y marca la 0045 como pendiente, para ver en la ventana
 * real que la app la corrige al abrir.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepositories, initLocalDb } from '@stockflow/db';
import { AccountsReceivableService, CashService, SalesService, type ServiceContext } from '@stockflow/core';
import { jsPDF } from 'jspdf';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}
const dec = (n: number) => n.toFixed(4);
const dia = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const WHEN_0045 = 1786725687541;
const SQL_0045 = fileURLToPath(new URL('../../../../packages/db/migrations/local/0045_saldo_inicial_stockfacil.sql', import.meta.url));

function textoDelPdf(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\) Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1]!.replace(/\\([()\\])/g, '$1').replace(/\x97/g, '—'));
  return out;
}

type Base = {
  db: ReturnType<typeof initLocalDb>['db'];
  repos: ReturnType<typeof createRepositories>;
  cuentas: AccountsReceivableService;
  villanueva: string;
  conRenglon: string;
  normal: string;
  sana: string;
  arVillanueva: string;
};

/** Las cuatro cuentas. Las sintéticas se insertan como las deja la migración (SQL directo). */
async function armar(dir: string): Promise<Base> {
  const { db } = initLocalDb(join(dir, 'stockflow.db'));
  const repos = createRepositories(db);
  const admin = (await repos.users.findByUsername('admin'))!;
  const ctx = { db, repos, currentUser: admin } as unknown as ServiceContext;
  const cash = new CashService(ctx);
  const ventas = new SalesService(ctx);
  const cuentas = new AccountsReceivableService(ctx);
  const caja = await cash.openCashRegister('0.0000');
  const efectivo = (await repos.paymentMethods.findAll()).find((m) => m.isPhysicalCash)!;
  const raw = db.$client;
  const ahora = Date.now();
  let nro = 0; // número de la venta sintética: el siguiente libre
  const uuid = () => crypto.randomUUID();

  const sintetica = (customerId: string, fecha: number, nota: string, total: number, saldo: number, entregas: [number, number][], renglon?: { articleId: string; importe: number }) => {
    const sid = uuid();
    nro = ((raw.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM sales WHERE type = 'X'").get() as { n: number }).n ?? 0) + 1;
    raw.prepare(
      `INSERT INTO sales (id, number, type, date, customer_id, seller_id, cash_register_id, is_account_sale, subtotal, discount, vat_amount, total, status, notes, created_at, updated_at)
       VALUES (?, ?, 'X', ?, ?, ?, ?, 1, ?, '0.0000', '0.0000', ?, 'completed', ?, ?, ?)`,
    ).run(sid, nro, fecha, customerId, admin.id, caja.id, dec(total), dec(total), nota, fecha, fecha);
    if (renglon) {
      raw.prepare(
        `INSERT INTO sale_lines (id, sale_id, article_id, line_number, quantity, unit_price, discount, vat_rate, line_total, created_at) VALUES (?, ?, ?, 1, '1.000', ?, '0.0000', '21.00', ?, ?)`,
      ).run(uuid(), sid, renglon.articleId, dec(renglon.importe), dec(renglon.importe), fecha);
    }
    const arid = uuid();
    raw.prepare(
      `INSERT INTO accounts_receivable (id, customer_id, sale_id, total, balance, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(arid, customerId, sid, dec(total), dec(saldo), saldo === 0 ? 'paid' : saldo === total ? 'open' : 'partial', fecha, ahora);
    for (const [importe, cuando] of entregas) {
      raw.prepare(
        `INSERT INTO payments (id, account_id, amount, date, payment_method_id, notes, created_at) VALUES (?, ?, ?, ?, ?, 'Entrega registrada en StockFácil', ?)`,
      ).run(uuid(), arid, dec(importe), cuando, efectivo.id, ahora);
    }
    return { sid, arid };
  };

  // 1) Villanueva, tal cual quedó en Paranacito: total = saldo = 98.400, 7 entregas por 512.300, sin renglones.
  const villanueva = (await repos.customers.create({ lastName: 'VILLANUEVA LUIS LORENZO', category: 'CF', docType: 'DNI', docNumber: '20111222' } as never)).id;
  const v = sintetica(villanueva, dia(2025, 5, 12), 'Saldo inicial — deuda traída de StockFácil', 98400, 98400, [
    [100000, dia(2025, 5, 14)], [16800, dia(2025, 6, 3)], [90000, dia(2025, 6, 9)], [89700, dia(2025, 6, 26)],
    [78300, dia(2026, 6, 1)], [37500, dia(2026, 6, 19)], [100000, dia(2026, 7, 20)],
  ]);

  // 2) Con el renglón de consumos de la herramienta nueva: total 50.000, debe 20.000, entregas 30.000 + 40.000 → el total tiene que pasar a 90.000.
  const consumos = await repos.articles.create({ barcode: 'SF-SALDO', description: 'Consumos anteriores de cuenta corriente (StockFácil)', listPrice1: '0.0000', stock: '0.000', active: false } as never);
  const conRenglon = (await repos.customers.create({ lastName: 'PEREZ ANA', category: 'CF', docType: 'DNI', docNumber: '20333444' } as never)).id;
  sintetica(conRenglon, dia(2026, 3, 1), 'Saldo de cuenta corriente traído de StockFácil', 50000, 20000, [[30000, dia(2026, 4, 1)], [40000, dia(2026, 5, 1)]], { articleId: consumos.id, importe: 50000 });

  // 3) Una cuenta normal de StockFlow: venta a cuenta de 10.000 y cobro de 4.000.
  const art = await repos.articles.create({ barcode: 'NOR-1', description: 'Artículo normal', listPrice1: '10000.0000', stock: '10.000' } as never);
  const normal = (await repos.customers.create({ lastName: 'LOPEZ JUAN', category: 'CF', docType: 'DNI', docNumber: '20555666' } as never)).id;
  const venta = await ventas.createSale({ type: 'X', customerId: normal, isAccountSale: true, lines: [{ articleId: art.id, quantity: '1.000', unitPrice: '10000.0000' }] } as never);
  const arNormal = (await repos.accountsReceivable.findOne({ saleId: venta.sale.id }))!;
  await cuentas.receivePayment({ accountId: arNormal.id, payments: [{ paymentMethodId: efectivo.id, amount: '4000.0000' }], expectedAmount: '4000.0000' });

  // 4) Una sintética sana: total 7.000, debe 2.000, entregas 5.000 (cierra).
  const sana = (await repos.customers.create({ lastName: 'GARCIA SOL', category: 'CF', docType: 'DNI', docNumber: '20777888' } as never)).id;
  sintetica(sana, dia(2026, 2, 1), 'Saldo de cuenta corriente traído de StockFácil', 7000, 2000, [[5000, dia(2026, 2, 15)]]);

  return { db, repos, cuentas, villanueva, conRenglon, normal, sana, arVillanueva: v.arid };
}

async function main(): Promise<void> {
  const seedDir = process.env.RESUMEN_SEED_DIR;
  if (seedDir) {
    mkdirSync(seedDir, { recursive: true });
    if (existsSync(join(seedDir, 'stockflow.db'))) rmSync(join(seedDir, 'stockflow.db'));
    const b = await armar(seedDir);
    // La 0045 queda pendiente: la aplica la app al abrir, como en un cliente.
    b.db.$client.prepare('DELETE FROM __drizzle_migrations WHERE created_at = ?').run(WHEN_0045);
    const st = await b.cuentas.getCustomerStatement(b.villanueva);
    console.log(`base en ${seedDir}: Villanueva debe ${st.currentBalance}; último saldo renglón a renglón ${st.entries.at(-1)?.runningBalance} (sin corregir; la 0045 queda pendiente)`);
    b.db.$client.close();
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'saldo-sf-'));
  try {
    const b = await armar(dir);
    const raw = b.db.$client;
    const ar = (customerId: string) => raw.prepare('SELECT a.total, a.balance, a.status, s.total AS venta, s.subtotal FROM accounts_receivable a JOIN sales s ON s.id = a.sale_id WHERE a.customer_id = ?').get(customerId) as { total: string; balance: string; status: string; venta: string; subtotal: string };

    console.log('\n[1] Antes de la corrección: el problema');
    let st = await b.cuentas.getCustomerStatement(b.villanueva);
    check(Number(st.currentBalance) === 98400, 'Villanueva debe 98.400 (el saldo real)', st.currentBalance);
    check(Number(st.entries.at(-1)!.runningBalance) === -413900, 'pero renglón a renglón el saldo termina en −413.900', st.entries.at(-1)!.runningBalance);
    check(st.entries[0]!.reference === 'Saldo de cuenta corriente traído de StockFácil (X #1)', 'el saldo inicial ya no se llama «Venta X #1»', st.entries[0]!.reference);

    console.log('\n[2] La migración 0045, aplicada como la aplica la app');
    const sql = readFileSync(SQL_0045, 'utf8');
    raw.exec(sql);
    let a = ar(b.villanueva);
    check(Number(a.total) === 610700 && Number(a.balance) === 98400 && a.status === 'open', 'Villanueva: total 610.700 (98.400 + 512.300), debe 98.400, sigue abierta', JSON.stringify(a));
    check(Number(a.venta) === 610700 && Number(a.subtotal) === 610700, 'la venta sintética también dice 610.700', JSON.stringify(a));
    st = await b.cuentas.getCustomerStatement(b.villanueva);
    check(Number(st.entries[0]!.debit) === 610700, 'el estado de cuenta arranca con 610.700', st.entries[0]!.debit);
    check(Number(st.entries.at(-1)!.runningBalance) === 98400 && Number(st.currentBalance) === 98400, 'y renglón a renglón cierra en 98.400, igual que el saldo real', st.entries.at(-1)!.runningBalance);
    check(st.entries.filter((e) => e.kind === 'payment').length === 7, 'las 7 entregas siguen');

    a = ar(b.conRenglon);
    const renglon = raw.prepare("SELECT l.unit_price, l.line_total FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.customer_id = ?").get(b.conRenglon) as { unit_price: string; line_total: string };
    check(Number(a.total) === 90000 && Number(a.balance) === 20000 && Number(a.venta) === 90000, 'con renglón: total 90.000 (20.000 + 70.000), debe 20.000', JSON.stringify(a));
    check(Number(renglon.unit_price) === 90000 && Number(renglon.line_total) === 90000, 'el renglón «Consumos anteriores» absorbe la diferencia (90.000)', JSON.stringify(renglon));

    a = ar(b.normal);
    check(Number(a.total) === 10000 && Number(a.balance) === 6000 && Number(a.venta) === 10000, 'la cuenta normal de StockFlow no cambia (10.000, debe 6.000)', JSON.stringify(a));
    a = ar(b.sana);
    check(Number(a.total) === 7000 && Number(a.balance) === 2000 && Number(a.venta) === 7000, 'la sintética sana no cambia (7.000, debe 2.000)', JSON.stringify(a));

    raw.exec(sql);
    a = ar(b.villanueva);
    check(Number(a.total) === 610700 && Number(a.venta) === 610700, 'aplicarla otra vez no cambia nada (idempotente)', JSON.stringify(a));

    console.log('\n[3] El Resumen PDF de Villanueva, ya corregido');
    register('./alias-src-loader.mjs', import.meta.url);
    const { exportStatementPdf } = (await import(fileURLToPath(new URL('../../src/lib/statementDoc.ts', import.meta.url)))) as { exportStatementPdf: (d: unknown) => void };
    const { formatCurrency } = (await import(fileURLToPath(new URL('../../src/lib/format.ts', import.meta.url)))) as { formatCurrency: (v: number) => string };
    let pdf: Buffer | null = null;
    (jsPDF as unknown as { API: { save: () => void } }).API.save = function (this: jsPDF) { pdf = Buffer.from(this.output('arraybuffer')); };
    const empresa = await b.repos.company.getOrCreate();
    exportStatementPdf({ company: { name: empresa.name, address: empresa.address, phone: empresa.phone, cuit: empresa.cuit }, customer: st.customer, entries: st.entries, balance: st.currentBalance, range: null });
    const t = textoDelPdf(pdf!);
    check(t.includes('Saldo de cuenta corriente traído de StockFácil (X #1)'), 'el PDF nombra el saldo inicial como tal');
    check(t.includes(`Compras: ${formatCurrency(610700)}   ·   Entregas a cuenta: ${formatCurrency(512300)}`), 'Compras 610.700 · Entregas 512.300', t.find((x) => x.startsWith('Compras:')));
    const iS = t.indexOf('SALDO ADEUDADO');
    check(t[iS + 1] === formatCurrency(98400), 'SALDO ADEUDADO 98.400', t[iS + 1]);
    check(t[t.indexOf('Saldo de cuenta corriente traído de StockFácil (X #1)') + 2] === formatCurrency(610700), 'el primer renglón arranca el saldo en 610.700');

    console.log('\n[4] Herramienta de migración y novedades');
    const raiz = fileURLToPath(new URL('../../../..', import.meta.url));
    check(readFileSync(join(raiz, 'tools/migracion/migrar.py'), 'utf8').includes('total_cta = saldo + entregas_cta'), 'migrar.py ya no deja el total por debajo de saldo + entregas');
    const nov = JSON.parse(readFileSync(join(raiz, 'apps/desktop/electron/novedades/release-notes.json'), 'utf8')) as { versiones: { version: string; novedades: string[] }[] };
    check(nov.versiones[0]!.version === '1.18.6' && nov.versiones[0]!.novedades.some((n) => /StockFácil/.test(n)), 'novedades 1.18.6');
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
  process.exit(fallas ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
