/**
 * Smoke test de BackupService con la base ABIERTA (modo WAL).
 *
 *   pnpm --filter @stockflow/desktop test:backup
 *
 * Lo que `hardware.smoke` nunca vio, porque cierra la base antes de backupear:
 *  - Con 300 filas todavía en el -wal (sin checkpoint), el stockflow.db del zip
 *    tiene las 300 filas.
 *  - La retención no borra un zip ajeno ni un segundo backup del mismo día, y
 *    sí borra uno nuestro viejo.
 *  - Restaurar un zip truncado o uno cuya base no es SQLite no toca la base
 *    actual ni deja copia .pre-restore.
 *  - Restaurar un zip sano deja la copia .pre-restore con lo que había.
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { closeLocalDb, initLocalDb } from '@stockflow/db';

import { BackupService } from '../backup/BackupService';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-backup-smoke-'));
console.log(`\nTest de backup con base abierta — dir temporal: ${tmpDir}\n`);

const dbPath = join(tmpDir, 'stockflow.db');
const backupDir = join(tmpDir, 'backups');
const ROWS = 300;

function countRows(file: string): number {
  const raw = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = raw.prepare('SELECT COUNT(*) AS n FROM smoke_rows').get() as { n: number };
    return row.n;
  } finally {
    raw.close();
  }
}

function unzipTo(zipPath: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') execFileSync('tar', ['-xf', zipPath, '-C', dir]);
  else execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir]);
}

async function zipWithEntries(zipPath: string, entries: Array<{ name: string; content: Buffer | string }>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const archiverMod: any = await import('archiver');
  const archiver = archiverMod.default ?? archiverMod;
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip');
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const e of entries) archive.append(e.content, { name: e.name });
    void archive.finalize();
  });
}

function preRestoreCopies(): string[] {
  // Sólo las bases: el -wal que acompaña a una copia no es otra copia.
  return readdirSync(tmpDir).filter((f) => f.startsWith('stockflow.db.pre-restore-') && !f.endsWith('-wal'));
}

async function main(): Promise<void> {
  console.log('— createBackup con WAL sin checkpoint —');
  const { db } = initLocalDb(dbPath);
  db.$client.exec('CREATE TABLE smoke_rows (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  const insert = db.$client.prepare('INSERT INTO smoke_rows (v) VALUES (?)');
  db.$client.transaction(() => {
    for (let i = 0; i < ROWS; i++) insert.run(`fila ${i}`);
  })();
  const walSize = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
  check('las filas están en el -wal (todavía sin checkpoint)', walSize > 0, `${walSize} bytes`);

  const svc = new BackupService({ dbPath, backupDir, appVersion: '0.0.0-test', getDb: () => db.$client });
  const entry = await svc.createBackup();
  check('createBackup() devuelve entry', !!entry.fullPath && entry.sizeBytes > 0, `${entry.filename} (${entry.sizeBytes} bytes)`);
  check('nombre con el formato stockflow-AAAA-MM-DD-HHMMSS.zip', /^stockflow-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/.test(entry.filename));
  // Sólo la copia de ESTE proceso: un residuo de otra corrida abortada no es
  // culpa del código que se está probando.
  const ownCopy = (f: string): boolean => f.startsWith('stockflow-backup-') && f.endsWith(`-${process.pid}.db`);
  check('no queda .tmp ni copia intermedia', !existsSync(`${entry.fullPath}.tmp`) && !readdirSync(tmpdir()).some(ownCopy));

  const extracted = join(tmpDir, 'extract-1');
  unzipTo(entry.fullPath, extracted);
  const dbInZip = join(extracted, 'database', 'stockflow.db');
  check('el zip trae database/stockflow.db y metadata.json', existsSync(dbInZip) && existsSync(join(extracted, 'metadata.json')));
  const n = countRows(dbInZip);
  check(`el stockflow.db del zip tiene las ${ROWS} filas`, n === ROWS, `${n} filas`);

  // Sin conexión viva (la app ya cerró la base) también tiene que incluir el WAL.
  const svcSinDb = new BackupService({ dbPath, backupDir: join(tmpDir, 'backups-2'), appVersion: '0.0.0-test' });
  const entry2 = await svcSinDb.createBackup();
  const extracted2 = join(tmpDir, 'extract-2');
  unzipTo(entry2.fullPath, extracted2);
  const n2 = countRows(join(extracted2, 'database', 'stockflow.db'));
  check(`sin getDb (conexión propia) el zip también tiene las ${ROWS} filas`, n2 === ROWS, `${n2} filas`);

  console.log('\n— timeout: aborta y no deja .tmp —');
  try {
    await svc.createBackup(join(tmpDir, 'backups-timeout'), { timeoutMs: 1 });
    check('createBackup con timeoutMs=1 falla', false);
  } catch (err) {
    check('createBackup con timeoutMs=1 falla', /tiempo máximo/.test(String((err as Error).message)), (err as Error).message);
  }
  const leftovers = existsSync(join(tmpDir, 'backups-timeout')) ? readdirSync(join(tmpDir, 'backups-timeout')) : [];
  check('la carpeta destino queda sin .tmp ni zip', leftovers.length === 0, leftovers.join(','));

  console.log('\n— cleanupOldBackups —');
  const today = entry.filename.slice(0, 'stockflow-AAAA-MM-DD'.length);
  const sameDay = join(backupDir, `${today}-000001.zip`);
  writeFileSync(sameDay, readFileSync(entry.fullPath));
  const ajeno = join(backupDir, 'otro.zip');
  writeFileSync(ajeno, 'no es nuestro');
  const viejo = join(backupDir, 'stockflow-2020-01-01-120000.zip');
  writeFileSync(viejo, readFileSync(entry.fullPath));
  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000);
  utimesSync(viejo, twoYearsAgo, twoYearsAgo);
  utimesSync(ajeno, twoYearsAgo, twoYearsAgo);
  const { removed } = await svc.cleanupOldBackups();
  check('borra sólo el backup nuestro fuera de retención', removed === 1, `removed=${removed}`);
  check('el zip ajeno (otro.zip) sigue', existsSync(ajeno));
  check('el segundo backup del mismo día sigue', existsSync(sameDay));
  check('el backup recién creado sigue', existsSync(entry.fullPath));
  check('el viejo (2020) se borró', !existsSync(viejo));

  console.log('\n— restoreBackup: zip truncado / base inválida —');
  closeLocalDb(db); // como hace el handler: la base se cierra antes de restaurar
  const before = readFileSync(dbPath);
  const truncado = join(tmpDir, 'truncado.zip');
  const full = readFileSync(entry.fullPath);
  writeFileSync(truncado, full.subarray(0, Math.floor(full.length / 2)));
  try {
    await svc.restoreBackup(truncado);
    check('restore de zip truncado falla', false);
  } catch (err) {
    check('restore de zip truncado falla', true, (err as Error).message);
  }
  check('la base no cambió tras el zip truncado', readFileSync(dbPath).equals(before));
  check('no se creó copia .pre-restore', preRestoreCopies().length === 0);

  const noSqlite = join(tmpDir, 'no-sqlite.zip');
  await zipWithEntries(noSqlite, [
    { name: 'database/stockflow.db', content: Buffer.from('esto no es una base de datos') },
    { name: 'metadata.json', content: '{}' },
  ]);
  try {
    await svc.restoreBackup(noSqlite);
    check('restore de zip con base no-SQLite falla', false);
  } catch (err) {
    check('restore de zip con base no-SQLite falla', /no es una base de datos SQLite/.test((err as Error).message), (err as Error).message);
  }
  check('la base no cambió tras la base no-SQLite', readFileSync(dbPath).equals(before));

  // Base SQLite con cabecera válida pero páginas rotas: quick_check debe frenarla.
  const roto = Buffer.from(readFileSync(dbInZip));
  roto.fill(0xff, 200);
  const rotoZip = join(tmpDir, 'roto.zip');
  await zipWithEntries(rotoZip, [
    { name: 'database/stockflow.db', content: roto },
    { name: 'metadata.json', content: '{}' },
  ]);
  try {
    await svc.restoreBackup(rotoZip);
    check('restore de base dañada (quick_check) falla', false);
  } catch (err) {
    check('restore de base dañada (quick_check) falla', true, (err as Error).message);
  }
  check('la base no cambió tras la base dañada', readFileSync(dbPath).equals(before));
  check('sigue sin copia .pre-restore', preRestoreCopies().length === 0);

  console.log('\n— restoreBackup: zip sano —');
  const res = await svc.restoreBackup(entry.fullPath);
  check('restore sano pide reinicio', res.requiresRestart === true);
  // Antes de reabrir nada: al abrir la base restaurada SQLite vuelve a crearlos.
  check('no quedó -wal ni -shm de la base anterior', !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`));
  const copies = preRestoreCopies();
  check('quedó UNA copia .pre-restore', copies.length === 1, copies.join(','));
  if (copies.length === 1) {
    const nPre = countRows(join(tmpDir, copies[0]!));
    check(`la copia .pre-restore tiene las ${ROWS} filas`, nPre === ROWS, `${nPre} filas`);
  }
  check('la base restaurada abre y tiene las filas', countRows(dbPath) === ROWS);

  // Un segundo restore no acumula copias: se conserva sólo la última.
  await new Promise((r) => setTimeout(r, 5));
  await svc.restoreBackup(entry.fullPath);
  const copies2 = preRestoreCopies();
  check('tras otro restore sigue habiendo UNA copia .pre-restore', copies2.length === 1, copies2.join(','));
  check('y es la nueva, no la anterior', copies2.length === 1 && copies2[0] !== copies[0]);
}

main()
  .catch((err) => {
    console.error('\n✗ Excepción durante el test:', err);
    failures++;
  })
  .finally(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
    if (failures > 0) {
      console.error(`\nTEST BACKUP FALLÓ — ${failures} check(s) con error.\n`);
      process.exit(1);
    }
    console.log('\n✅ TODO OK — TEST BACKUP\n');
  });
