/**
 * Smoke test de la base local (sin framework — ejecutable con `tsx`).
 *
 *   pnpm --filter @stockflow/db test:smoke
 *
 * Crea una DB en un archivo temporal, la inicializa (migraciones + seed),
 * verifica las tablas esperadas y los registros base, y limpia los archivos.
 * Sale con código 1 si algo falla.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, initLocalDb } from '../index';

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
