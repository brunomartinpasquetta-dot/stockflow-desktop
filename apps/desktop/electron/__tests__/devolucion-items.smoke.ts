/**
 * Selector de Devolución POR ARTÍCULO (6-oct-2026): lista los renglones vendidos
 * que todavía admiten devolución, del más nuevo al más viejo, y se busca por
 * artículo, código, cliente o N° de comprobante sin distinguir acentos.
 * Datos inventados sobre una base temporal (el repo es público).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '../../../../packages/db/src/index';

let fallas = 0;
function check(ok: boolean, msg: string, extra?: unknown): void {
  console.log(`${ok ? '✅' : '❌'} ${msg}${ok || extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!ok) fallas++;
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'sf-devol-'));
const { db } = initLocalDb(path.join(dir, 'sf.db'), { seed: true });
const sq = db.$client;
const repos = createRepositories(db);

const admin = sq.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string };
const cf = (sq.prepare('SELECT id FROM customers LIMIT 1').get() as { id: string }).id;
sq.prepare("INSERT INTO customers (id, first_name, last_name, category, created_at, updated_at) VALUES ('cli-2', 'Ana', 'Pérez', 'CF', 0, 0)").run();
const AHORA = Date.now();
const DIA = 86_400_000;

sq.prepare(
  "INSERT INTO cash_registers (id, number, open_date, close_date, opening_amount, closing_amount, status, user_id, notes, created_at) VALUES ('caja', 1, ?, NULL, '0.0000', NULL, 'open', ?, NULL, ?)",
).run(AHORA - 60 * DIA, admin.id, AHORA);

const art = sq.prepare(
  "INSERT INTO articles (id, barcode, description, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
);
art.run('a1', '7790001', 'Azúcar Ledesma 1 kg');
art.run('a2', '7790002', 'Fernet Branca 750 ml');
art.run('a3', '7790003', 'Yerba Playadito 500 g');

const venta = sq.prepare(
  'INSERT INTO sales (id, number, type, date, customer_id, seller_id, cash_register_id, subtotal, total, vat_amount, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
);
const linea = sq.prepare(
  'INSERT INTO sale_lines (id, sale_id, article_id, description, line_number, quantity, unit_price, discount, vat_rate, line_total, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
);
const nuevaVenta = (id: string, numero: number, tipo: string, hace: number, cliente: string, estado = 'completed'): void => {
  venta.run(id, numero, tipo, AHORA - hace * DIA, cliente, admin.id, 'caja', '0', '0', '0', estado, AHORA, AHORA);
};

nuevaVenta('s1', 101, 'B', 1, cf);
linea.run('l-1a', 's1', 'a1', null, 1, '2.000', '1000', '0', '21.00', '2000', AHORA);
linea.run('l-1b', 's1', 'a2', null, 2, '1.000', '15000', '0', '21.00', '15000', AHORA);
nuevaVenta('s2', 102, 'X', 2, 'cli-2');
linea.run('l-2a', 's2', 'a1', null, 1, '1.000', '1000', '0', '21.00', '1000', AHORA);
linea.run('l-2b', 's2', null, 'Caramelos sueltos', 2, '3.000', '200', '0', '21.00', '600', AHORA);
nuevaVenta('s3', 103, 'B', 3, cf, 'voided');
linea.run('l-3a', 's3', 'a3', null, 1, '1.000', '5000', '0', '21.00', '5000', AHORA);
nuevaVenta('s4', 104, 'B', 40, cf);
linea.run('l-4a', 's4', 'a2', null, 1, '1.000', '15000', '0', '21.00', '15000', AHORA);
nuevaVenta('s5', 105, 'B', 5, cf);
linea.run('l-5a', 's5', 'a3', null, 1, '1.000', '5000', '0', '21.00', '5000', AHORA);

// Devoluciones: parcial de 1 sobre el azúcar de la venta 101 y total de la yerba de la 105.
const dev = sq.prepare('INSERT INTO returns (id, number, sale_id, customer_id, user_id, date, refund_method, total, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
const devLinea = sq.prepare('INSERT INTO return_lines (id, return_id, sale_line_id, article_id, quantity, unit_price, line_total, created_at) VALUES (?,?,?,?,?,?,?,?)');
dev.run('r1', 1, 's1', cf, admin.id, AHORA, 'cash', '1000', AHORA);
devLinea.run('rl-1', 'r1', 'l-1a', 'a1', '1.000', '1000', '1000', AHORA);
dev.run('r2', 2, 's5', cf, admin.id, AHORA, 'cash', '5000', AHORA);
devLinea.run('rl-2', 'r2', 'l-5a', 'a3', '1.000', '5000', '5000', AHORA);

const ventana = { desde: AHORA - 30 * DIA, hasta: AHORA + 3_600_000 };
const todos = await repos.sales.itemsParaDevolucion(ventana);
check(
  todos.map((i) => i.lineId).join(',') === 'l-1a,l-1b,l-2a,l-2b',
  'sin filtro: sólo lo vendido y devolvible, del más nuevo al más viejo (sin anuladas, sin fuera de fecha, sin lo ya devuelto entero)',
  todos.map((i) => i.lineId),
);
check(todos[0]?.devuelto === '1' && todos[0]?.quantity === '2.000', 'un renglón con devolución parcial muestra cuánto ya se devolvió', todos[0]);
check(todos[0]?.description === 'Azúcar Ledesma 1 kg' && todos[0]?.code === '7790001', 'trae el nombre y el código del artículo', todos[0]);

const azucar = await repos.sales.itemsParaDevolucion({ ...ventana, texto: 'azucar' });
check(azucar.map((i) => i.lineId).join(',') === 'l-1a,l-2a', 'busca por artículo sin distinguir acentos ("azucar" → Azúcar)', azucar.map((i) => i.lineId));

const fernet = await repos.sales.itemsParaDevolucion({ ...ventana, texto: 'FERNET' });
check(fernet.length === 1 && fernet[0]?.lineId === 'l-1b', 'mayúsculas da igual; el de hace 40 días queda afuera', fernet.map((i) => i.lineId));

const rapido = await repos.sales.itemsParaDevolucion({ ...ventana, texto: 'caramelos' });
check(rapido.length === 1 && rapido[0]?.articleId === null && rapido[0]?.description === 'Caramelos sueltos', 'el artículo rápido se busca y se muestra por lo escrito a mano', rapido);

const porCliente = await repos.sales.itemsParaDevolucion({ ...ventana, texto: 'perez' });
check(porCliente.map((i) => i.lineId).join(',') === 'l-2a,l-2b' && porCliente[0]?.customerName === 'Pérez, Ana', 'busca por cliente sin distinguir acentos', porCliente.map((i) => i.lineId));

const porNumero = await repos.sales.itemsParaDevolucion({ ...ventana, texto: '102' });
check(porNumero.length === 2, 'busca por N° de comprobante', porNumero.map((i) => i.lineId));

const dosPalabras = await repos.sales.itemsParaDevolucion({ ...ventana, texto: 'azucar 101' });
check(dosPalabras.length === 1 && dosPalabras[0]?.lineId === 'l-1a', 'varias palabras: todas tienen que coincidir en el mismo renglón', dosPalabras.map((i) => i.lineId));

const ninguno = await repos.sales.itemsParaDevolucion({ ...ventana, texto: 'azucar fernet' });
check(ninguno.length === 0, 'palabras de renglones distintos no se mezclan');

const yerba = await repos.sales.itemsParaDevolucion({ ...ventana, texto: 'playadito' });
check(yerba.length === 0, 'lo ya devuelto entero y lo anulado no aparecen aunque se busquen', yerba.map((i) => i.lineId));

const limitado = await repos.sales.itemsParaDevolucion({ ...ventana, limite: 2 });
check(limitado.length === 2, 'respeta el límite');

closeLocalDb(db);
rmSync(dir, { recursive: true, force: true });
console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
