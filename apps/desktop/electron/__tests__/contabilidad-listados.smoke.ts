/**
 * Listados de Contabilidad y cajas importadas (6-oct-2026):
 *  - "Facturas emitidas" abre con TODAS: páginas de la más nueva a la más vieja
 *    con cursor (sin repetir ni saltear), filtros en la consulta y totales de
 *    todo lo filtrado (lo anulado no suma; las notas de crédito restan).
 *  - Cajas importadas del sistema anterior: se reconocen por la caja sintética
 *    "Caja histórica (migración desde StockFácil)" y no se ingresan a Caja General.
 * Datos inventados sobre una base temporal (el repo es público).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CashRegisterRepository, closeLocalDb, createRepositories, initLocalDb } from '../../../../packages/db/src/index';

let fallas = 0;
function check(ok: boolean, msg: string, extra?: unknown): void {
  console.log(`${ok ? '✅' : '❌'} ${msg}${ok || extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!ok) fallas++;
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'sf-contab-'));
const { db } = initLocalDb(path.join(dir, 'sf.db'), { seed: true });
const sq = db.$client;
const repos = createRepositories(db);

const admin = sq.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
const cf = sq.prepare('SELECT id FROM customers LIMIT 1').get() as { id: string };
sq.prepare("INSERT INTO customers (id, first_name, last_name, category, created_at, updated_at) VALUES ('cli-2', 'Ana', 'Pérez', 'CF', 0, 0)").run();
const DIA = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const MIGRACION = T0 + 50 * DIA;

// Cajas: 3 viejas sin terminal (importadas), la sintética de la migración y una de StockFlow.
const caja = sq.prepare(
  'INSERT INTO cash_registers (id, number, open_date, close_date, opening_amount, closing_amount, status, user_id, notes, created_at, terminal_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
);
for (let i = 1; i <= 3; i++) caja.run(`vieja-${i}`, i, T0 + i * DIA, T0 + i * DIA + 3600_000, '0.0000', '1000.0000', 'closed', admin.id, null, T0, null);
caja.run('historica', 4, MIGRACION, MIGRACION, '0.0000', '0.0000', 'closed', admin.id, 'Caja histórica (migración desde StockFácil)', MIGRACION, null);
caja.run('nueva', 5, MIGRACION + DIA, MIGRACION + DIA + 3600_000, '0.0000', '500.0000', 'closed', admin.id, null, MIGRACION + DIA, 'maquina-1');

// 450 ventas (una cada hora): las múltiplos de 10 anuladas, las pares al otro cliente, tipos B y X.
const venta = sq.prepare(
  'INSERT INTO sales (id, number, type, date, customer_id, seller_id, cash_register_id, subtotal, total, vat_amount, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
);
let totalEsperado = 0;
let ivaEsperado = 0;
let anuladas = 0;
for (let i = 1; i <= 450; i++) {
  const anulada = i % 10 === 0;
  const total = 100 + i;
  const iva = Math.round((total * 21) / 121 * 10000) / 10000;
  venta.run(`v-${String(i).padStart(4, '0')}`, i, i % 3 === 0 ? 'X' : 'B', T0 + i * 3600_000, i % 2 === 0 ? 'cli-2' : cf.id, admin.id, 'nueva', String(total), String(total), String(iva), anulada ? 'voided' : 'completed', T0, T0);
  if (anulada) anuladas++;
  else { totalEsperado += total; ivaEsperado += iva; }
}
// Una nota de crédito B aprobada de $50.
sq.prepare(
  "INSERT INTO fiscal_vouchers (id, voucher_code, letter, kind, sale_point, number, date, customer_id, customer_doc_type, customer_doc_number, customer_name, total, vat_amount, net_amount, status, user_id, created_at, updated_at) VALUES ('nc-1', 8, 'B', 'credit_note', 4, 1, ?, ?, 99, '0', 'Consumidor Final', '50.0000', '8.6777', '41.3223', 'approved', ?, ?, ?)",
).run(T0 + 100 * 3600_000, cf.id, admin.id, T0, T0);

// ── Páginas ──
const vistas = new Set<string>();
let cursor: { date: number; id: string } | null = null;
let paginas = 0;
let ordenOk = true;
let ultimaFecha = Number.POSITIVE_INFINITY;
for (;;) {
  const p = await repos.sales.paginaFacturasEmitidas({ antesDe: cursor, limite: 200 });
  paginas++;
  for (const v of p.ventas) {
    if (v.date > ultimaFecha) ordenOk = false;
    ultimaFecha = v.date;
    vistas.add(v.id);
  }
  const u = p.ventas[p.ventas.length - 1];
  if (!p.hayMas || !u) break;
  cursor = { date: u.date, id: u.id };
}
check(vistas.size === 450 - anuladas && paginas === 3, 'sin anuladas: todas las ventas en 3 páginas, sin repetir ni saltear', { vistas: vistas.size, paginas });
check(ordenOk, 'páginas de la más nueva a la más vieja');

const conAnuladas = await repos.sales.paginaFacturasEmitidas({ incluirAnuladas: true, limite: 1000 });
check(conAnuladas.ventas.length === 450 && !conAnuladas.hayMas, 'incluyendo anuladas: las 450');

const soloCli2 = await repos.sales.paginaFacturasEmitidas({ customerId: 'cli-2', type: 'B', limite: 1000 });
check(soloCli2.ventas.every((v) => v.customerId === 'cli-2' && v.type === 'B'), 'filtro por cliente y tipo en la consulta');

const rango = await repos.sales.paginaFacturasEmitidas({ from: T0 + 10 * 3600_000, to: T0 + 19 * 3600_000, incluirAnuladas: true, limite: 1000 });
check(rango.ventas.length === 10, 'filtro por fechas (10 horas = 10 ventas)', rango.ventas.length);

// ── Totales ──
const t = await repos.sales.totalesFacturasEmitidas({});
check(t.cantidad === 450 - anuladas && t.anuladas === 0, 'totales sin anuladas: cuenta sólo las registradas', t);
check(Math.abs(t.total - totalEsperado) < 0.01 && Math.abs(t.vat - ivaEsperado) < 0.01, 'totales: suma de total e IVA de lo filtrado', { t, totalEsperado, ivaEsperado });
const tA = await repos.sales.totalesFacturasEmitidas({ incluirAnuladas: true });
check(tA.anuladas === anuladas && tA.cantidad === 450 - anuladas, 'con anuladas: se cuentan aparte y no suman', tA);
const notas = repos.fiscal.notasEmitidas({});
check(notas.length === 1 && notas[0]!.kind === 'credit_note', 'notas de crédito/débito con los filtros');
check(repos.fiscal.notasEmitidas({ customerId: 'cli-2' }).length === 0, 'notas filtradas por cliente');

// ── Cajas importadas ──
const fecha = await repos.cashRegisters.fechaDeMigracion();
const todas = await repos.cashRegisters.findByDateRange({ from: 0, to: MIGRACION + 10 * DIA });
const imp = todas.filter((r) => CashRegisterRepository.esImportada(r, fecha)).map((r) => r.id).sort();
check(fecha === MIGRACION, 'fecha de migración = apertura de la caja histórica', fecha);
check(JSON.stringify(imp) === JSON.stringify(['historica', 'vieja-1', 'vieja-2', 'vieja-3']), 'importadas: las viejas y la histórica; la de StockFlow no', imp);

closeLocalDb(db);
const dir2 = mkdtempSync(path.join(os.tmpdir(), 'sf-contab2-'));
const nueva = initLocalDb(path.join(dir2, 'sf.db'), { seed: true });
check((await createRepositories(nueva.db).cashRegisters.fechaDeMigracion()) === null, 'base que no vino de una migración: sin fecha (nada es importado)');
closeLocalDb(nueva.db);
rmSync(dir, { recursive: true, force: true });
rmSync(dir2, { recursive: true, force: true });

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
