/**
 * MODO DEMO (E5) — carga y descarte de los datos de ejemplo, con reversa
 * BYTE-EXACTA por snapshot.
 *
 * Reglas duras:
 *  - La demo SOLO se carga con la base virgen (cero ventas/compras/artículos/
 *    presupuestos y sin clientes más allá de CONSUMIDOR FINAL). Jamás se
 *    siembra sobre datos reales.
 *  - Antes de sembrar se copia stockflow.db → stockflow.db.pre-demo
 *    (checkpoint WAL primero). "Quitar datos demo" marca el descarte y en el
 *    PRÓXIMO ARRANQUE se restaura ese snapshot; la base demo descartada se
 *    conserva renombrada (nada se pierde de forma irreversible).
 *  - El estado vive en {userData}/demo.json y la UI muestra un distintivo
 *    DEMO permanente mientras esté activa.
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = 'demo.json';
const PRE_DEMO_BACKUP = 'stockflow.db.pre-demo';

export interface DemoState {
  active: boolean;
  loadedAt?: number;
  preDemoBackup?: string;
  discardOnRestart?: boolean;
}

export function readDemoState(userDataDir: string): DemoState {
  try {
    const raw = JSON.parse(readFileSync(join(userDataDir, STATE_FILE), 'utf8')) as DemoState;
    return { active: Boolean(raw.active), loadedAt: raw.loadedAt, preDemoBackup: raw.preDemoBackup, discardOnRestart: Boolean(raw.discardOnRestart) };
  } catch {
    return { active: false };
  }
}

export function writeDemoState(userDataDir: string, state: DemoState): void {
  writeFileSync(join(userDataDir, STATE_FILE), JSON.stringify(state, null, 1));
}

/** ¿La base está virgen? (sin operaciones ni maestros cargados por el usuario) */
export function isDbVirgin(dbPath: string): boolean {
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const q = (sql: string): number => (raw.prepare(sql).get() as { n: number }).n;
    return (
      q('SELECT COUNT(*) n FROM sales') === 0 &&
      q('SELECT COUNT(*) n FROM purchases') === 0 &&
      q('SELECT COUNT(*) n FROM quotes') === 0 &&
      q('SELECT COUNT(*) n FROM articles') === 0 &&
      q("SELECT COUNT(*) n FROM customers WHERE last_name != 'CONSUMIDOR FINAL'") === 0 &&
      q('SELECT COUNT(*) n FROM cash_registers') === 0
    );
  } finally {
    raw.close();
  }
}

/** Snapshot de la base virgen ANTES de sembrar. Deja el estado en active. */
export function snapshotBeforeDemo(userDataDir: string, dbPath: string): void {
  // Checkpoint del WAL para que el archivo principal contenga todo.
  const raw = new Database(dbPath, { fileMustExist: true });
  try {
    raw.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    raw.close();
  }
  copyFileSync(dbPath, join(userDataDir, PRE_DEMO_BACKUP));
  writeDemoState(userDataDir, { active: true, loadedAt: Date.now(), preDemoBackup: PRE_DEMO_BACKUP });
}

/** Marca el descarte de la demo; se aplica en el próximo arranque. */
export function requestDemoDiscard(userDataDir: string): { ok: boolean; motivo?: string } {
  const st = readDemoState(userDataDir);
  if (!st.active || !st.preDemoBackup) return { ok: false, motivo: 'no hay una demo activa' };
  if (!existsSync(join(userDataDir, st.preDemoBackup))) {
    return { ok: false, motivo: `falta el respaldo ${st.preDemoBackup} — no se descarta nada sin él` };
  }
  writeDemoState(userDataDir, { ...st, discardOnRestart: true });
  return { ok: true };
}

/**
 * Se llama en el BOOT, ANTES de abrir la base. Si hay un descarte pendiente y
 * el respaldo existe: renombra la base demo (conservándola) y restaura el
 * snapshot pre-demo. Ante cualquier duda, NO toca nada.
 */
export function applyPendingDemoDiscard(userDataDir: string, dbPath: string): { restored: boolean } {
  const st = readDemoState(userDataDir);
  if (!st.discardOnRestart || !st.preDemoBackup) return { restored: false };
  const backup = join(userDataDir, st.preDemoBackup);
  if (!existsSync(backup)) {
    console.error('[demo] descarte pendiente SIN respaldo — no se toca la base');
    writeDemoState(userDataDir, { ...st, discardOnRestart: false });
    return { restored: false };
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  try {
    if (existsSync(dbPath)) renameSync(dbPath, `${dbPath}.demo-descartada-${stamp}`);
    // El snapshot es un archivo plano post-checkpoint: wal/shm viejos no le
    // pertenecen y corromperían la restauración si quedaran.
    for (const suf of ['-wal', '-shm']) rmSync(`${dbPath}${suf}`, { force: true });
    copyFileSync(backup, dbPath);
    writeDemoState(userDataDir, { active: false });
    console.log(`[demo] demo descartada (conservada como .demo-descartada-${stamp}); base pre-demo restaurada`);
    return { restored: true };
  } catch (e) {
    console.error('[demo] falló la restauración:', e);
    return { restored: false };
  }
}
