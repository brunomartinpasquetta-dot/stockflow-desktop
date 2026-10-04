/**
 * Smoke test de la base local (sin framework — ejecutable con `tsx`).
 *
 *   pnpm --filter @stockflow/db test:smoke
 *
 * Crea una DB en un archivo temporal, la inicializa (migraciones + seed),
 * verifica las tablas esperadas y los registros base, y limpia los archivos.
 * Sale con código 1 si algo falla.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeLocalDb, initLocalDb, SUCURSAL_CENTRAL_ID } from '../index';

const MIGRACIONES_LOCALES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'local');

const EXPECTED_TABLES = [
  'companies',
  'users',
  'families',
  'suppliers',
  'articles',
  'customers',
  'cards',
  'payment_methods',
  'cash_registers',
  'cash_movements',
  'sales',
  'sale_lines',
  'sale_payments',
  'purchases',
  'purchase_lines',
  'accounts_receivable',
  'payments',
  'supplier_accounts_payable',
  'supplier_payments',
  'price_update_batches',
  'price_update_entries',
  'mp_config',
  'mp_pos_devices',
  'mp_orders',
  'cash_general',
  'cash_general_movements',
  'audit_log',
  'catalogo_pedidos',
  'catalogo_sync',
  'fiscal_config',
  'fiscal_voucher_vat',
  'fiscal_vouchers',
  'promotion_items',
  'promotions',
  'purchase_return_lines',
  'purchase_returns',
  'quote_lines',
  'quotes',
  'return_lines',
  'returns',
  'role_area_access',
  'sale_points',
  'article_supplier_codes',
  'scanned_invoices',
  'branches',
  // 0041: PC de sucursal emparejadas (multisucursal).
  'dispositivos_sucursal',
];

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-smoke-'));
const dbPath = join(tmpDir, 'stockflow.db');
console.log(`\nSmoke test — DB temporal: ${dbPath}\n`);

try {
  const { db, seed } = initLocalDb(dbPath);

  // 1) Archivo creado
  check('archivo .db creado', existsSync(dbPath), dbPath);

  // 2) PRAGMAs aplicados
  const journalMode = (db.$client.pragma('journal_mode', { simple: true }) as string);
  const fkOn = db.$client.pragma('foreign_keys', { simple: true }) === 1;
  check('journal_mode = wal', journalMode.toLowerCase() === 'wal', journalMode);
  check('foreign_keys ON', fkOn);

  // 3) Tablas (PRAGMA table_list)
  const tableList = db.$client.pragma('table_list') as Array<{
    schema: string;
    name: string;
    type: string;
  }>;
  const presentTables = new Set(
    tableList
      .filter((t) => t.schema === 'main' && t.type === 'table' && !t.name.startsWith('sqlite_'))
      .map((t) => t.name),
  );
  const appTables = [...presentTables].filter((n) => n !== '__drizzle_migrations');
  for (const t of EXPECTED_TABLES) {
    check(`tabla ${t}`, presentTables.has(t));
  }
  check(
    `total de tablas de aplicación = ${EXPECTED_TABLES.length}`,
    appTables.length === EXPECTED_TABLES.length,
    `detectadas: ${appTables.sort().join(', ')}`,
  );

  // 4) Seed: admin
  const admin = db.$client
    .prepare("SELECT username, role, full_name FROM users WHERE username = 'admin'")
    .get() as { username: string; role: string; full_name: string } | undefined;
  check('usuario admin existe', !!admin, admin ? `role=${admin.role}, fullName=${admin.full_name}` : '');

  // 5) Seed: CONSUMIDOR FINAL
  const cf = db.$client
    .prepare("SELECT last_name, category, doc_type, price_list FROM customers WHERE last_name = 'CONSUMIDOR FINAL'")
    .get() as { last_name: string; category: string; doc_type: string; price_list: number } | undefined;
  check(
    'cliente CONSUMIDOR FINAL existe',
    !!cf && cf.category === 'CF' && cf.price_list === 1,
    cf ? `category=${cf.category}, docType=${cf.doc_type}, priceList=${cf.price_list}` : '',
  );

  // 6) Seed: familia ARTICULOS + company stub
  const fam = db.$client.prepare("SELECT name FROM families WHERE name = 'ARTICULOS'").get();
  check('familia ARTICULOS existe', !!fam);
  const company = db.$client.prepare('SELECT name FROM companies LIMIT 1').get() as { name: string } | undefined;
  check('company stub existe', !!company, company?.name);

  // 6b) Medios de pago pre-cargados (los inserta la migración 0001)
  const pmRow = db.$client.prepare('SELECT COUNT(*) AS c FROM payment_methods').get() as { c: number };
  const efectivoRow = db.$client
    .prepare("SELECT is_physical_cash AS f FROM payment_methods WHERE id = 'pm-efectivo'")
    .get() as { f: number } | undefined;
  check('4 medios de pago pre-cargados', pmRow.c === 4, `count=${pmRow.c}`);
  check('Efectivo es el medio de efectivo físico', efectivoRow?.f === 1);

  // 6c) Sucursales (migración 0040): "Casa central" con el id FIJO, en toda base.
  {
    const filas = db.$client.prepare('SELECT * FROM branches').all() as Array<{
      id: string; name: string; code: string; active: number; is_main: number; created_at: number; updated_at: number;
    }>;
    const central = filas[0];
    check('una sola sucursal tras migrar', filas.length === 1, `count=${filas.length}`);
    check(
      'Casa central con id fijo, código CENTRAL, activa y principal',
      !!central && central.id === SUCURSAL_CENTRAL_ID && central.name === 'Casa central' && central.code === 'CENTRAL' && central.active === 1 && central.is_main === 1,
      JSON.stringify(central),
    );
    check(
      'Casa central con fechas en milisegundos',
      !!central && central.created_at > 1_700_000_000_000 && central.updated_at === central.created_at,
      String(central?.created_at),
    );
    // A lo sumo una principal (índice único parcial); varias no principales sí.
    let rechazada = false;
    try {
      db.$client
        .prepare("INSERT INTO branches (id, name, code, active, is_main, created_at, updated_at) VALUES ('x-2', 'Otra', 'OTRA', 1, 1, 1, 1)")
        .run();
    } catch {
      rechazada = true;
    }
    check('no puede haber dos sucursales principales', rechazada);
    let codigoRepetido = false;
    try {
      db.$client
        .prepare("INSERT INTO branches (id, name, code, active, is_main, created_at, updated_at) VALUES ('x-3', 'Otra', 'CENTRAL', 1, 0, 1, 1)")
        .run();
    } catch {
      codigoRepetido = true;
    }
    check('el código de sucursal es único', codigoRepetido);
    // Re-correr la migración (base restaurada, etc.) no pisa el nombre que le
    // puso el comercio ni duplica la fila.
    db.$client.prepare("UPDATE branches SET name = 'Coronda' WHERE id = ?").run(SUCURSAL_CENTRAL_ID);
    const sqlMig = readFileSync(join(MIGRACIONES_LOCALES, '0040_sucursales.sql'), 'utf8');
    for (const stmt of sqlMig.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)) {
      db.$client.exec(stmt);
    }
    const tras = db.$client.prepare('SELECT name FROM branches').all() as Array<{ name: string }>;
    check(
      'migración 0040 repetida: no duplica ni pisa el nombre',
      tras.length === 1 && tras[0]?.name === 'Coronda',
      JSON.stringify(tras),
    );
    db.$client.prepare("UPDATE branches SET name = 'Casa central' WHERE id = ?").run(SUCURSAL_CENTRAL_ID);
  }

  // 7) Idempotencia: re-ejecutar el seed no debe crear nada
  const { seedLocalDb } = await import('../seed');
  const second = seedLocalDb(db);
  check(
    'seed idempotente (segunda corrida no crea nada)',
    !second.adminCreated && !second.consumidorFinalCreated && !second.defaultFamilyCreated && !second.companyCreated,
    JSON.stringify(second),
  );
  // primera corrida sí debió crear todo
  check(
    'primera corrida del seed creó los 4 registros base',
    seed.adminCreated && seed.consumidorFinalCreated && seed.defaultFamilyCreated && seed.companyCreated,
    JSON.stringify(seed),
  );

  // 8) La clave de fábrica del admin se reemplaza al actualizar, pero SÓLO si
  // sigue siendo la de fábrica. Pisarle la contraseña al comercio que ya la
  // cambió lo dejaría afuera de su propio sistema: es la mitad que importa.
  {
    const bcrypt = (await import('bcryptjs')).default;
    const leerHash = (): string =>
      (db.$client.prepare("SELECT password_hash AS h FROM users WHERE username = 'admin'").get() as { h: string }).h;

    check('el admin NO queda con la clave de fábrica', !bcrypt.compareSync('admin', leerHash()));
    check('el admin entra con la clave nueva', bcrypt.compareSync('admin36724776', leerHash()));

    // Base vieja, con la clave de fábrica todavía puesta: al re-sembrar se sube.
    db.$client
      .prepare("UPDATE users SET password_hash = ? WHERE username = 'admin'")
      .run(bcrypt.hashSync('admin', 10));
    const subida = seedLocalDb(db);
    check(
      'una base vieja con la clave de fábrica queda con la nueva',
      subida.adminPasswordUpgraded && bcrypt.compareSync('admin36724776', leerHash()),
      JSON.stringify(subida),
    );

    // Comercio que se puso su propia clave: no se le toca.
    db.$client
      .prepare("UPDATE users SET password_hash = ? WHERE username = 'admin'")
      .run(bcrypt.hashSync('la-mia-propia', 10));
    const respetada = seedLocalDb(db);
    check(
      'la clave que puso el comercio NO se pisa',
      !respetada.adminPasswordUpgraded && bcrypt.compareSync('la-mia-propia', leerHash()),
      JSON.stringify(respetada),
    );
  }

  closeLocalDb(db);
} catch (err) {
  console.error('\n✗ Excepción durante el smoke test:', err);
  failures++;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
}

if (failures > 0) {
  console.error(`\nSMOKE TEST FALLÓ — ${failures} check(s) con error.\n`);
  process.exit(1);
}
console.log('\nSMOKE TEST OK ✅\n');
