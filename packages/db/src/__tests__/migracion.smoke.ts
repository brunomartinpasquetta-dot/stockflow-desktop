/**
 * Prueba de MIGRACIÓN sobre una base CON DATOS.
 *
 *   pnpm --filter @stockflow/db test:migracion
 *
 * OJO: `better-sqlite3` está compilado para Electron, así que con el node del
 * sistema falla con NODE_MODULE_VERSION. Igual que el resto de los smoke tests,
 * corre con el runtime de Electron:
 *
 *   cd apps/desktop
 *   ELECTRON_RUN_AS_NODE=1 npx electron <ruta a tsx/dist/cli.mjs> \
 *     ../../packages/db/src/__tests__/migracion.smoke.ts
 *
 * Hoy cubre la 0021 (artículo rápido), que recrea `sale_lines` y `return_lines`.
 *
 * Recrea `sale_lines` y `return_lines`. En Leo Citzia son 105.088 renglones de
 * venta: si el rebuild pierde una fila o rompe una referencia, se entera el
 * cliente, no nosotros. Así que: se arma una base en el estado ANTERIOR (hasta
 * la 0020), se le cargan datos, se corre la 0021 y se verifica que todo siga.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// packages/db/src/__tests__/ → raíz del repo
const AQUI = dirname(fileURLToPath(import.meta.url));
const REPO = join(AQUI, '..', '..', '..', '..');
const MIGR = join(REPO, 'packages/db/migrations/local');

const tmp = mkdtempSync(join(tmpdir(), 'mig21-'));
const viejo = join(tmp, 'migr-viejas');
mkdirSync(viejo, { recursive: true });
cpSync(MIGR, viejo, { recursive: true });

// Journal recortado a ANTES de la 0021 = el estado previo al rebuild. Hay que
// cortar TODO lo posterior, no sólo la 0021: drizzle aplica por timestamp y si
// la base "vieja" ya tiene una migración más nueva, la 0021 se saltea y el
// test deja de probar lo que dice probar (pasó al agregar la 0022).
const jPath = join(viejo, 'meta/_journal.json');
const j = JSON.parse(readFileSync(jPath, 'utf8')) as { entries: { tag: string }[] };
j.entries = j.entries.filter((e) => e.tag < '0021');
writeFileSync(jPath, JSON.stringify(j, null, 2));

const dbPath = join(tmp, 'test.db');
const sqlite = new Database(dbPath);
sqlite.pragma('foreign_keys = OFF');
migrate(drizzle(sqlite), { migrationsFolder: viejo });
console.log('Base creada en el estado 0020 (como la del cliente).');

// ── Datos: una venta con 2 renglones y una devolución sobre uno de ellos.
const ahora = Date.now();
sqlite.exec(`
  INSERT INTO companies (id,name,price_mode,allow_negative_stock,created_at,updated_at)
    VALUES ('c1','Comercio','gross',1,${ahora},${ahora});
  INSERT INTO families (id,name,created_at) VALUES ('f1','GRAL',${ahora});
  INSERT INTO articles (id,barcode,description,family_id,cost_price,list_price1,list_price2,list_price3,
      wholesale_price,wholesale_min_qty,vat_rate,stock,min_stock,ideal_stock,sold_by_weight,unit,active,created_at,updated_at)
    VALUES ('a1','111','ARTICULO UNO','f1','0','100','0','0','0','0','21.00','10','0','0',0,'UN',1,${ahora},${ahora});
  INSERT INTO customers (id,last_name,category,price_list,credit_limit,created_at,updated_at)
    VALUES ('cli1','CONSUMIDOR FINAL','CF',1,'0.0000',${ahora},${ahora});
  INSERT INTO users (id,username,password_hash,full_name,role,active,created_at,updated_at)
    VALUES ('u1','admin','x','Admin','admin',1,${ahora},${ahora});
  INSERT INTO cash_registers (id,number,open_date,opening_amount,status,user_id,created_at)
    VALUES ('r1',1,${ahora},'0.0000','open','u1',${ahora});
  INSERT INTO sales (id,number,type,date,customer_id,seller_id,cash_register_id,is_account_sale,
      subtotal,discount,vat_amount,total,status,created_at,updated_at)
    VALUES ('v1',1,'B',${ahora},'cli1','u1','r1',0,'300.0000','0.0000','52.0661','300.0000','completed',${ahora},${ahora});
  INSERT INTO sale_lines (id,sale_id,article_id,line_number,quantity,unit_price,discount,vat_rate,line_total,created_at)
    VALUES ('sl1','v1','a1',1,'1.000','100.0000','0.0000','21.00','100.0000',${ahora}),
           ('sl2','v1','a1',2,'2.000','100.0000','0.0000','21.00','200.0000',${ahora});
  INSERT INTO returns (id,number,sale_id,customer_id,user_id,date,refund_method,total,created_at)
    VALUES ('d1',1,'v1','cli1','u1',${ahora},'cash','100.0000',${ahora});
  INSERT INTO return_lines (id,return_id,sale_line_id,article_id,quantity,unit_price,line_total,created_at)
    VALUES ('rl1','d1','sl1','a1','1.000','100.0000','100.0000',${ahora});
`);

const antes = {
  lineas: sqlite.prepare('SELECT COUNT(*) n FROM sale_lines').get() as { n: number },
  devol: sqlite.prepare('SELECT COUNT(*) n FROM return_lines').get() as { n: number },
  suma: sqlite.prepare('SELECT SUM(CAST(line_total AS REAL)) s FROM sale_lines').get() as { s: number },
};
console.log('ANTES →', antes.lineas.n, 'renglones,', antes.devol.n, 'devolución(es), suma', antes.suma.s);

// ── Correr la 0021 igual que lo hace initLocalDb.
migrate(drizzle(sqlite), { migrationsFolder: MIGR });
console.log('Migración 0021 aplicada.');

const despues = {
  lineas: sqlite.prepare('SELECT COUNT(*) n FROM sale_lines').get() as { n: number },
  devol: sqlite.prepare('SELECT COUNT(*) n FROM return_lines').get() as { n: number },
  suma: sqlite.prepare('SELECT SUM(CAST(line_total AS REAL)) s FROM sale_lines').get() as { s: number },
};

let fallos = 0;
const ok = (label: string, cond: boolean, detalle = '') => {
  if (cond) console.log(`  ✓ ${label}${detalle ? ` — ${detalle}` : ''}`);
  else { console.error(`  ✗ ${label}${detalle ? ` — ${detalle}` : ''}`); fallos++; }
};

ok('no se perdió ningún renglón', despues.lineas.n === antes.lineas.n, `${antes.lineas.n} → ${despues.lineas.n}`);
ok('no se perdió la devolución', despues.devol.n === antes.devol.n, `${antes.devol.n} → ${despues.devol.n}`);
ok('los importes son los mismos', despues.suma.s === antes.suma.s, `${antes.suma.s} → ${despues.suma.s}`);

const sl1 = sqlite.prepare('SELECT * FROM sale_lines WHERE id=?').get('sl1') as Record<string, unknown>;
ok('los ids se preservan (no se regeneran)', !!sl1, 'sl1 existe');
ok('la referencia de la devolución sigue apuntando', sl1?.id === 'sl1');
ok('article_id viejo intacto', sl1?.article_id === 'a1');
ok('description arranca vacía en lo migrado', sl1?.description === null);

// El punto de todo: ahora se puede insertar una línea SIN artículo.
sqlite.prepare(
  `INSERT INTO sale_lines (id,sale_id,article_id,description,line_number,quantity,unit_price,discount,vat_rate,line_total,created_at)
   VALUES ('sl3','v1',NULL,'FLETE',3,'1.000','500.0000','0.0000','21.00','500.0000',?)`,
).run(ahora);
const sl3 = sqlite.prepare('SELECT * FROM sale_lines WHERE id=?').get('sl3') as Record<string, unknown>;
ok('se puede guardar una línea SIN artículo', sl3?.article_id === null && sl3?.description === 'FLETE');

// Y devolverla.
sqlite.prepare(
  `INSERT INTO return_lines (id,return_id,sale_line_id,article_id,quantity,unit_price,line_total,created_at)
   VALUES ('rl2','d1','sl3',NULL,'1.000','500.0000','500.0000',?)`,
).run(ahora);
ok('se puede devolver un artículo rápido', !!sqlite.prepare('SELECT 1 FROM return_lines WHERE id=?').get('rl2'));

// Índices recreados y FKs sanas.
const idx = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%lines%'`).all() as { name: string }[];
const nombres = idx.map((i) => i.name);
ok('índices recreados', ['idx_sale_lines_sale', 'idx_return_lines_return', 'idx_return_lines_sale_line'].every((n) => nombres.includes(n)), nombres.join(', '));

sqlite.pragma('foreign_keys = ON');
const violaciones = sqlite.pragma('foreign_key_check') as unknown[];
ok('sin referencias rotas', violaciones.length === 0, `${violaciones.length} violación(es)`);

sqlite.close();
rmSync(tmp, { recursive: true, force: true });
console.log(fallos === 0 ? '\nMIGRACIÓN 0021 OK ✅' : `\nFALLÓ — ${fallos} problema(s)`);
process.exit(fallos === 0 ? 0 : 1);
