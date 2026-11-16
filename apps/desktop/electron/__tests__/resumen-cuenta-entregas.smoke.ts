/**
 * RESUMEN DE CUENTA EN PDF CON LAS ENTREGAS (1.18.5).
 *   pnpm --filter @stockflow/desktop test:resumen-cuenta-entregas
 *
 * Bruno (12-nov-2026): «que en el resumen de cuenta corriente de un cliente se
 * incluyan las entregas que realizó el cliente». Hasta la 1.18.4 el PDF las
 * sumaba en una línea y no las listaba.
 *
 * Arma una cuenta real por los servicios (ventas a cuenta, entregas por
 * comprobante y a cuenta, una entrega anulada y una devolución con crédito) y
 * genera el PDF con el MISMO código de la pantalla (`src/lib/statementDoc.ts`,
 * jsPDF en Node), leyendo el texto que quedó escrito en el PDF.
 *
 * Con RESUMEN_SEED_DIR=<carpeta> sólo deja esa cuenta en <carpeta>/stockflow.db,
 * para la prueba en la ventana real, y termina.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepositories, initLocalDb } from '@stockflow/db';
import {
  AccountsReceivableService,
  CashService,
  ReturnsService,
  SalesService,
  type ServiceContext,
} from '@stockflow/core';
import { jsPDF } from 'jspdf';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

/** Texto escrito en el PDF (jsPDF sin comprimir: cada texto es un `(…) Tj`). */
function textoDelPdf(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\) Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push(
      m[1]!
        .replace(/\\([()\\])/g, '$1')
        // WinAnsi: 0x97 es el guion largo «—», 0x96 el corto «–».
        .replace(/\x97/g, '—')
        .replace(/\x96/g, '–'),
    );
  }
  return out;
}

type Cuenta = {
  dir: string;
  repos: ReturnType<typeof createRepositories>;
  cuentas: AccountsReceivableService;
  clienteId: string;
};

/** La cuenta de prueba: 13.000 de compras, 4.500 de entregas netas, 500 devueltos → debe 8.000. */
async function armarCuenta(dir: string): Promise<Cuenta> {
  const { db } = initLocalDb(join(dir, 'stockflow.db'));
  const repos = createRepositories(db);
  const admin = await repos.users.findByUsername('admin');
  if (!admin) throw new Error('falta el usuario admin del seed');
  const ctx = { db, repos, currentUser: admin } as unknown as ServiceContext;
  const cash = new CashService(ctx);
  const ventas = new SalesService(ctx);
  const cuentas = new AccountsReceivableService(ctx);
  const devoluciones = new ReturnsService(ctx);
  const metodos = await repos.paymentMethods.findAll();
  const efectivo = metodos.find((m) => m.isPhysicalCash)!;
  const transferencia = metodos.find((m) => /transferencia/i.test(m.name)) ?? metodos.find((m) => !m.isPhysicalCash && m.active)!;
  const taladro = await repos.articles.create({ barcode: 'TAL-750', description: 'Taladro percutor 750 W', listPrice1: '10000.0000', stock: '10.000' } as never);
  const mecha = await repos.articles.create({ barcode: 'MEC-6', description: 'Mecha widia 6 mm', listPrice1: '500.0000', stock: '50.000' } as never);
  const cliente = await repos.customers.create({ lastName: 'GOMEZ', firstName: 'MARIA', category: 'CF', docType: 'DNI', docNumber: '27888999', mobile: '3425111222', address: 'San Martín 1200, Coronda' } as never);

  await cash.openCashRegister('20000.0000');
  const pausa = () => new Promise((r) => setTimeout(r, 5)); // fechas distintas, orden estable
  const v1 = await ventas.createSale({ type: 'X', customerId: cliente.id, isAccountSale: true, lines: [
    { articleId: taladro.id, quantity: '1.000', unitPrice: '10000.0000' },
    { articleId: mecha.id, quantity: '2.000', unitPrice: '500.0000' },
  ] } as never);
  await pausa();
  const c1 = (await repos.accountsReceivable.findOne({ saleId: v1.sale.id }))!;
  await cuentas.receivePayment({ accountId: c1.id, payments: [{ paymentMethodId: efectivo.id, amount: '3000.0000' }], expectedAmount: '3000.0000' });
  await pausa();
  const v2 = await ventas.createSale({ type: 'X', customerId: cliente.id, isAccountSale: true, lines: [
    { articleId: mecha.id, quantity: '4.000', unitPrice: '500.0000' },
  ] } as never);
  await pausa();
  const c2 = (await repos.accountsReceivable.findOne({ saleId: v2.sale.id }))!;
  const cobro2 = await cuentas.receivePayment({ accountId: c2.id, payments: [{ paymentMethodId: transferencia.id, amount: '2000.0000' }], expectedAmount: '2000.0000' });
  await pausa();
  await cuentas.anularCobro({ paymentId: cobro2.payments[0]!.id, motivo: 'transferencia equivocada' });
  await pausa();
  await devoluciones.createSaleReturn({ saleId: v1.sale.id, refundMethod: 'account', lines: [{ saleLineId: v1.lines[1]!.id, quantity: '1.000' }] });
  await pausa();
  await cuentas.receivePaymentToCustomer({ customerId: cliente.id, payments: [{ paymentMethodId: efectivo.id, amount: '1500.0000' }] } as never);
  return { dir, repos, cuentas, clienteId: cliente.id };
}

async function main(): Promise<void> {
  const seedDir = process.env.RESUMEN_SEED_DIR;
  if (seedDir) {
    mkdirSync(seedDir, { recursive: true });
    if (existsSync(join(seedDir, 'stockflow.db'))) rmSync(join(seedDir, 'stockflow.db'));
    const c = await armarCuenta(seedDir);
    const st = await c.cuentas.getCustomerStatement(c.clienteId);
    console.log(`base de prueba en ${seedDir}: GOMEZ MARIA debe ${st.currentBalance} con ${st.entries.length} movimientos`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'resumen-cc-'));
  try {
    const c = await armarCuenta(dir);
    const st = await c.cuentas.getCustomerStatement(c.clienteId);
    const empresa = await c.repos.company.getOrCreate();

    console.log('\n[1] La cuenta armada por los servicios');
    check(Number(st.currentBalance) === 8000, 'GOMEZ MARIA debe 8.000', st.currentBalance);
    const kinds = st.entries.map((e) => e.kind).join(',');
    check(kinds === 'sale,payment,sale,payment,void,return,payment', 'los movimientos, en orden: venta, entrega, venta, entrega, anulación, devolución, entrega', kinds);
    check(st.entries.filter((e) => e.kind === 'payment' && e.voided).length === 1, 'una entrega figura anulada');

    // El PDF con el MISMO código de la pantalla. `@/lib/format` se resuelve con
    // el cargador de alias; la ruta va en una variable para que el tsc de
    // electron no intente tipar el código de la pantalla.
    register('./alias-src-loader.mjs', import.meta.url);
    const rutaDoc = fileURLToPath(new URL('../../src/lib/statementDoc.ts', import.meta.url));
    const rutaFormat = fileURLToPath(new URL('../../src/lib/format.ts', import.meta.url));
    const { exportStatementPdf } = (await import(rutaDoc)) as { exportStatementPdf: (d: unknown) => void };
    const { formatCurrency } = (await import(rutaFormat)) as { formatCurrency: (v: string | number) => string };
    let pdf: Buffer | null = null;
    let nombre = '';
    // jsPDF copia sus métodos de `jsPDF.API` a cada instancia al construirla:
    // el `save` (que en el navegador descarga el archivo) se reemplaza ahí.
    (jsPDF as unknown as { API: { save: (n: string) => void } }).API.save = function (this: jsPDF, n: string) {
      nombre = n;
      pdf = Buffer.from(this.output('arraybuffer'));
    };
    const datos = (entries: typeof st.entries, range: { from: number; to: number } | null) => ({
      company: { name: empresa.name, address: empresa.address, phone: empresa.phone, cuit: empresa.cuit },
      customer: st.customer,
      entries,
      balance: st.currentBalance,
      range,
    });

    console.log('\n[2] El PDF completo');
    exportStatementPdf(datos(st.entries, null));
    check(pdf != null && pdf.length > 2000, 'se genera el PDF', String(pdf?.length));
    check(/^resumen-cuenta-gomez-maria-\d{4}-\d{2}-\d{2}\.pdf$/.test(nombre), 'con el nombre de siempre', nombre);
    const t = textoDelPdf(pdf!);
    const todo = t.join('\n');
    const $ = (v: number) => formatCurrency(v);
    const idx = (s: string, desde = 0) => t.findIndex((x, i) => i >= desde && x === s);
    check(['Fecha', 'Detalle', 'Compras', 'Entregas', 'Saldo'].every((h) => t.includes(h)), 'columnas Fecha, Detalle, Compras, Entregas y Saldo');
    check(!t.includes('Devoluciones') || todo.includes('Devoluciones: '), 'ya no hay columna «Devoluciones» (va en los totales)');
    check(t.includes('Venta X #1') && t.includes('Venta X #2'), 'las dos ventas');
    check(todo.includes(`1 × Taladro percutor 750 W — ${$(10000)} c/u = ${$(10000)}`), 'el detalle por artículo sigue', t.find((x) => /Taladro/.test(x)));
    const iEf = idx('Entrega — Efectivo');
    check(iEf > 0, 'la entrega en efectivo está LISTADA');
    check(t[iEf + 1] === $(3000) && t[iEf + 2] === $(8000), 'con su importe (3.000) y el saldo que quedó (8.000)', `${t[iEf + 1]} / ${t[iEf + 2]}`);
    const iTr = idx('Entrega — Transferencia (anulada)');
    check(iTr > 0 && t[iTr + 1] === $(2000), 'la entrega anulada figura marcada, con su importe', t.slice(iTr, iTr + 3).join(' | '));
    const iAn = t.findIndex((x) => x === 'Anulación de entrega — transferencia equivocada');
    check(iAn > iTr && t[iAn + 1] === `-${$(2000)}` && t[iAn + 2] === $(10000), 'su anulación es otro renglón: −2.000 en la columna Entregas y el saldo queda en 10.000', t.slice(iAn, iAn + 3).join(' | '));
    const iDev = idx('Devolución DEV #1');
    check(iDev > 0 && t[iDev + 1] === $(500) && t[iDev + 2] === $(9500), 'la devolución con crédito: 500 y saldo 9.500', t.slice(iDev, iDev + 3).join(' | '));
    check(!todo.includes('Devolución Devolución'), 'sin la palabra «Devolución» repetida');
    const iEf2 = idx('Entrega — Efectivo', iEf + 1);
    check(iEf2 > iDev && t[iEf2 + 1] === $(1500) && t[iEf2 + 2] === $(8000), 'la entrega a cuenta (1.500) también, saldo 8.000', t.slice(iEf2, iEf2 + 3).join(' | '));
    check(t.filter((x) => x.startsWith('Entrega — ')).length === 3, 'tres entregas listadas, ni una más', String(t.filter((x) => x.startsWith('Entrega — ')).length));
    check(t.includes(`Compras: ${$(13000)}   ·   Entregas a cuenta: ${$(4500)}   ·   Devoluciones: ${$(500)}`), 'totales: compras 13.000, entregas netas 4.500, devoluciones 500', t.find((x) => x.startsWith('Compras:')));
    const iSaldo = t.indexOf('SALDO ADEUDADO');
    check(iSaldo > 0 && t[iSaldo + 1] === $(8000), 'SALDO ADEUDADO 8.000', t[iSaldo + 1]);
    check(!t.includes('Saldo anterior'), 'sin «Saldo anterior» cuando no hay filtro');

    console.log('\n[3] El PDF con el período filtrado (desde la segunda venta)');
    const desde = 2;
    const recorte = st.entries.slice(desde);
    pdf = null;
    exportStatementPdf(datos(recorte, { from: recorte[0]!.date, to: Date.now() }));
    const t2 = textoDelPdf(pdf!);
    const iAnt = t2.indexOf('Saldo anterior');
    check(iAnt > 0 && t2[iAnt + 1] === $(8000), 'arranca con «Saldo anterior» 8.000 (lo que debía antes del período)', t2.slice(iAnt, iAnt + 2).join(' | '));
    check(t2.some((x) => x.startsWith('Período: ')), 'dice el período');
    check(!t2.includes('Venta X #1') && t2.includes('Venta X #2'), 'sólo los movimientos del período');
    check(t2.includes(`Compras: ${$(2000)}   ·   Entregas a cuenta: ${$(1500)}   ·   Devoluciones: ${$(500)}`), 'los totales son del período', t2.find((x) => x.startsWith('Compras:')));
    const iS2 = t2.indexOf('SALDO ADEUDADO');
    check(t2[iS2 + 1] === $(8000), 'y el SALDO ADEUDADO sigue siendo el real de la cuenta', t2[iS2 + 1]);

    console.log('\n[4] Lo que dicen las novedades, el manual y Flowy');
    const raiz = fileURLToPath(new URL('../..', import.meta.url));
    const novedades = JSON.parse(readFileSync(join(raiz, 'electron/novedades/release-notes.json'), 'utf8')) as { versiones: { version: string; novedades: string[] }[] };
    const v1185 = novedades.versiones.find((v) => v.version === '1.18.5');
    check(!!v1185 && v1185.novedades.some((n) => /lista las entregas/.test(n)), 'novedades 1.18.5: el resumen lista las entregas');
    const manual = readFileSync(join(raiz, 'manual-src/manual.html'), 'utf8');
    check(!/NO se listan una por una/.test(manual) && /se listan una por una, con la fecha/.test(manual), 'el manual ya no dice que las entregas no se listan');
    const intents = readFileSync(join(raiz, 'electron/assistant/intents.json'), 'utf8');
    check(!/van sumadas en una sola línea/.test(intents) && /lista las entregas de dinero una por una/.test(intents), 'la ficha de Flowy dice que las lista');
    check(readFileSync(join(raiz, 'package.json'), 'utf8').includes('"version": "1.18.5"'), 'versión 1.18.5');
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
