/**
 * SEEDER DE DEMO PARA MATERIAL DE MARKETING — "Ferretería del Litoral".
 *
 *   cd apps/desktop
 *   ELECTRON_RUN_AS_NODE=1 npx electron \
 *     ../../node_modules/.pnpm/tsx@<ver>/node_modules/tsx/dist/cli.mjs \
 *     scripts/seed-demo-marketing.ts
 *
 * Deja la base LOCAL de esta Mac con datos publicables para grabar videos.
 * El SEMBRADO vive en electron/demo/seedDemoData.ts — el MISMO módulo que usa
 * la función de producto "Cargar datos de ejemplo" (E5). Este script solo
 * bootstrapea el entorno dev (base nueva + handlers + sesión admin).
 *
 * REVERTIR: cerrar StockFlow, borrar la stockflow.db nueva y devolverle el
 * nombre al respaldo (ver instrucciones del commit original).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { BackupService } from '../electron/backup/BackupService';
import { seedDemoData } from '../electron/demo/seedDemoData';
import { HardwareManager } from '../electron/hardware/HardwareManager';
import { ExcelImportService } from '../electron/import/ExcelImportService';
import { LicenseManager } from '../electron/license/LicenseManager';
import { buildAllHandlers } from '../electron/ipc/index';
import { SessionStore } from '../electron/ipc/session-store';
import type { IpcResponse } from '../electron/ipc/types';

const USER_DATA = join(process.env.HOME ?? '', 'Library/Application Support/@stockflow/desktop');
const DB_PATH = join(USER_DATA, 'stockflow.db');
const AQUI = dirname(fileURLToPath(import.meta.url));
const XLSX_PATH = join(AQUI, '..', '..', '..', 'marketing', 'demo-data', 'StockFlow-demo-articulos.xlsx');

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
  const login = (await h['auth:login']!({ username: 'admin', password: 'admin' })) as IpcResponse<unknown>;
  if (!login.ok) throw new Error('login admin/admin falló (¿la base no está virgen?)');

  const r = await seedDemoData(h, {
    dbPath: DB_PATH,
    xlsxPath: XLSX_PATH,
    beforeDateShift: () => closeLocalDb(db),
  });

  console.log('\n── Resumen ──');
  console.log(JSON.stringify(r.resumen, null, 1));
  console.log(`ventas sembradas: ${r.ventas} · compras: ${r.compras}`);
  if (r.fallas > 0) {
    console.error(`\n✗ ${r.fallas} verificación(es) FALLARON`);
    process.exit(1);
  }
  console.log('\n✅ DEMO LISTA (falta el arqueo en vivo: se verifica con la app abierta)');
}

main().catch((e) => { console.error('SEED DEMO FALLÓ:', e); process.exit(1); });
