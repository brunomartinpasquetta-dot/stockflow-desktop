/**
 * Servicio de backup automático.
 *
 * Empaqueta la DB de StockFlow en un .zip con `archiver`, dentro de un
 * directorio configurable. La política de retención mantiene todos los de los
 * últimos 7 días + 4 semanales + 12 mensuales.
 *
 * Restore: usa `unzip` (macOS/Linux) o `tar` (Windows 10+) por childprocess
 * para no agregar otra dep de unzip.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, promises as fsp, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';

import type { BackupEntry } from '../hardware/types';

const execFileP = promisify(execFile);

/**
 * Sólo los zips con este nombre son nuestros. La carpeta destino suele ser
 * Documentos o un pendrive con otros zips del cliente: la retención no puede
 * tocar nada que no haya generado el sistema.
 */
const BACKUP_FILENAME_RE = /^stockflow-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/;

interface BackupServiceDeps {
  dbPath: string;
  backupDir: string;
  appVersion: string;
  /**
   * Conexión viva a la base, si la hay. La base trabaja en modo WAL: copiar el
   * archivo stockflow.db a secas deja afuera todo lo que todavía está en el
   * -wal (una base con 300 ventas salía con 0 en el zip). La API de backup de
   * SQLite lee a través de la conexión y se lleva todo.
   *
   * Restricción: si OTRA conexión (no ésta) escribe en continuo sobre la misma
   * base, SQLite reinicia la copia una y otra vez y sin timeout no termina nunca.
   * Las conexiones auxiliares que hay hoy (seed demo, DemoManager, lecturas
   * readonly) son puntuales; no agregar una que escriba en loop.
   */
  getDb?: () => Database | null | undefined;
}

export class BackupService {
  private deps: BackupServiceDeps;

  constructor(deps: BackupServiceDeps) {
    this.deps = deps;
  }

  setBackupDir(dir: string): void {
    this.deps.backupDir = dir;
  }

  private filenameFor(now: number): string {
    const d = new Date(now);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `stockflow-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
  }

  /**
   * Copia consistente de la base (con lo que haya en el WAL) a `dest`, con la
   * API de backup de SQLite. Usa la conexión viva si está abierta; si no (la app
   * ya cerró la base, o el servicio corre sin ella), abre una propia y la cierra.
   * `isTimedOut` corta la copia entre páginas para no dejar un archivo a medias.
   */
  private async copyDatabaseTo(dest: string, isTimedOut: () => boolean): Promise<boolean> {
    const progress = (): void => {
      if (isTimedOut()) throw new Error('la copia de la base superó el tiempo máximo');
    };
    const live = this.deps.getDb?.();
    if (live && live.open) {
      await live.backup(dest, { progress });
      return true;
    }
    if (!existsSync(this.deps.dbPath)) return false;
    const own = new Database(this.deps.dbPath, { fileMustExist: true });
    try {
      await own.backup(dest, { progress });
    } finally {
      own.close();
    }
    return true;
  }

  async createBackup(destOverride?: string, opts?: { timeoutMs?: number }): Promise<BackupEntry> {
    const dest = destOverride || this.deps.backupDir;
    if (!dest) {
      throw new Error('No hay una carpeta de backup configurada. Seleccione una en Configuración → Backup.');
    }
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const now = Date.now();
    const filename = this.filenameFor(now);
    const fullPath = path.join(dest, filename);
    const tmpPath = `${fullPath}.tmp`;
    // La copia de la base va al tmp del sistema (disco local): el destino puede
    // ser un pendrive lento y no conviene escribir y releer la base entera ahí.
    const dbCopyPath = path.join(tmpdir(), `stockflow-backup-${now}-${process.pid}.db`);

    // Con tiempo máximo (backup de salida): si se agota, se aborta lo que esté en
    // curso y el catch de abajo borra el .tmp. Antes el cierre forzado dejaba un
    // .tmp truncado en la carpeta de backups y nadie se enteraba.
    let timedOut = false;
    let abortArchive: (() => void) | null = null;
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          // Puede caer en la copia (todavía no hay .tmp) o en el zip: en ambos
          // casos se descarta lo hecho y no queda nada en la carpeta destino.
          console.warn(`[backup] se agotó el tiempo máximo (${opts.timeoutMs} ms): se descarta el backup ${filename}`);
          abortArchive?.();
        }, opts.timeoutMs)
      : null;

    try {
      const hasDb = await this.copyDatabaseTo(dbCopyPath, () => timedOut);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const archiverMod: any = await import('archiver');
      const archiver = archiverMod.default ?? archiverMod;
      const { createWriteStream } = await import('node:fs');

      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        abortArchive = () => {
          try { archive.abort(); } catch { /* ya finalizado */ }
          output.destroy(new Error('el backup superó el tiempo máximo'));
        };
        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        if (hasDb) {
          archive.file(dbCopyPath, { name: 'database/stockflow.db' });
        }
        const metadata = {
          createdAt: now,
          appVersion: this.deps.appVersion,
          dbPath: this.deps.dbPath,
          schemaVersion: 'auto',
        };
        archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });
        void archive.finalize();
      });
      if (timedOut) throw new Error('el backup superó el tiempo máximo');

      await fsp.rename(tmpPath, fullPath);
      const st = await fsp.stat(fullPath);
      return { filename, fullPath, sizeBytes: st.size, createdAt: now };
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
      const detail = err instanceof Error ? (err.message || String(err)) : String(err);
      console.error('[backup] createBackup falló:', err);
      throw new Error(`No se pudo crear el backup: ${detail}`, { cause: err });
    } finally {
      if (timer) clearTimeout(timer);
      try { await fsp.unlink(dbCopyPath); } catch { /* no llegó a crearse */ }
    }
  }

  async listBackups(): Promise<BackupEntry[]> {
    if (!existsSync(this.deps.backupDir)) return [];
    const files = await fsp.readdir(this.deps.backupDir);
    const out: BackupEntry[] = [];
    for (const f of files) {
      if (!f.endsWith('.zip')) continue;
      const full = path.join(this.deps.backupDir, f);
      try {
        const st = await fsp.stat(full);
        out.push({ filename: f, fullPath: full, sizeBytes: st.size, createdAt: st.mtimeMs });
      } catch {
        // ignore
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }

  async restoreBackup(zipPath: string): Promise<{ requiresRestart: true }> {
    if (!existsSync(zipPath)) throw new Error('El archivo de backup no existe');
    const tmpDir = path.join(this.deps.backupDir, `.restore-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      if (process.platform === 'win32') {
        // tar viene incluido en Win10+ y maneja zip.
        await execFileP('tar', ['-xf', zipPath, '-C', tmpDir]);
      } else {
        await execFileP('unzip', ['-o', zipPath, '-d', tmpDir]);
      }
      const dbInZip = path.join(tmpDir, 'database', 'stockflow.db');
      const metaInZip = path.join(tmpDir, 'metadata.json');
      if (!existsSync(dbInZip) || !existsSync(metaInZip)) {
        throw new Error('Backup inválido: faltan database/stockflow.db o metadata.json');
      }
      // Validar el archivo ANTES de tocar la base actual: un zip viejo, truncado
      // o de otro programa dejaba al cliente sin base y con la app que no abre.
      await this.assertValidSqliteFile(dbInZip);
      // Copia de la base actual al lado, por si el backup elegido no era el que
      // se creía: se recupera renombrando el .pre-restore-<ts> a stockflow.db.
      // Se conserva sólo la última: cada copia es una base completa en userData.
      let preRestore: string | null = null;
      if (existsSync(this.deps.dbPath)) {
        await this.removePreRestoreCopies();
        preRestore = `${this.deps.dbPath}.pre-restore-${Date.now()}`;
        await fsp.copyFile(this.deps.dbPath, preRestore);
        // Si quedó un -wal (la base no se cerró del todo), va con la copia:
        // SQLite lo asocia por nombre, así que la copia sigue siendo completa.
        if (existsSync(`${this.deps.dbPath}-wal`)) {
          await fsp.copyFile(`${this.deps.dbPath}-wal`, `${preRestore}-wal`);
        }
      }
      // Reemplazar la DB actual atómicamente.
      const tmpTarget = `${this.deps.dbPath}.restoring`;
      try {
        await fsp.copyFile(dbInZip, tmpTarget);
        await fsp.rename(tmpTarget, this.deps.dbPath);
      } catch (err) {
        // Falló antes de pisar la base (disco lleno, típicamente): la actual
        // sigue intacta, así que la copia recién hecha sobra.
        try { await fsp.unlink(tmpTarget); } catch { /* no llegó a crearse */ }
        if (preRestore) await this.removePreRestoreCopies();
        throw err;
      }
      // CRÍTICO: eliminar el WAL/SHM de la base anterior. Si quedan, SQLite
      // reaplica esas escrituras pendientes sobre la base recién restaurada al
      // reabrir → el restore "no toma efecto". Al arrancar sin WAL, la base
      // restaurada queda tal cual.
      for (const suffix of ['-wal', '-shm']) {
        try {
          await fsp.unlink(`${this.deps.dbPath}${suffix}`);
        } catch {
          /* no existía: ok */
        }
      }
      return { requiresRestart: true };
    } catch (err) {
      const detail = err instanceof Error ? (err.message || String(err)) : String(err);
      throw new Error(`No se pudo restaurar el backup: ${detail}`, { cause: err });
    } finally {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** Borra las copias <dbPath>.pre-restore-* (y su -wal) que hubiera. */
  private async removePreRestoreCopies(): Promise<void> {
    const dir = path.dirname(this.deps.dbPath);
    const prefix = `${path.basename(this.deps.dbPath)}.pre-restore-`;
    let names: string[];
    try { names = await fsp.readdir(dir); } catch { return; }
    for (const f of names) {
      if (!f.startsWith(prefix)) continue;
      try { await fsp.unlink(path.join(dir, f)); } catch { /* ignore */ }
    }
  }

  /** Cabecera de SQLite + `PRAGMA quick_check`; tira con el motivo si no pasa. */
  private async assertValidSqliteFile(file: string): Promise<void> {
    const HEADER = 'SQLite format 3\0';
    const fh = await fsp.open(file, 'r');
    let header: string;
    try {
      const buf = Buffer.alloc(HEADER.length);
      const { bytesRead } = await fh.read(buf, 0, HEADER.length, 0);
      header = buf.subarray(0, bytesRead).toString('latin1');
    } finally {
      await fh.close();
    }
    if (header !== HEADER) {
      throw new Error('Backup inválido: database/stockflow.db no es una base de datos SQLite');
    }
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db.pragma('quick_check') as Array<{ quick_check: string }>;
      const result = rows.map((r) => r.quick_check).join('; ');
      if (result !== 'ok') {
        throw new Error(`Backup inválido: la base está dañada (${result})`);
      }
    } finally {
      db.close();
    }
  }

  async cleanupOldBackups(): Promise<{ removed: number }> {
    // Sólo los zips con nuestro nombre: la carpeta puede tener otros del cliente.
    const all = (await this.listBackups()).filter((b) => BACKUP_FILENAME_RE.test(b.filename));
    if (all.length === 0) return { removed: 0 };
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const keep = new Set<string>();

    // Últimos 7 días: se conservan TODOS (cierre de caja, salida, manual). Quedarse
    // con uno por día borraba el backup previo a un restore hecho el mismo día.
    for (const b of all) {
      if (now - b.createdAt <= 7 * DAY) keep.add(b.fullPath);
    }

    // 4 semanales: una por semana de las últimas 4 semanas.
    const weeklyByKey = new Map<string, BackupEntry>();
    for (const b of all) {
      if (now - b.createdAt > 4 * 7 * DAY) continue;
      const d = new Date(b.createdAt);
      // semana ISO aprox: año + número de semana (no exacto, alcanza para retención).
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d.getTime() - onejan.getTime()) / DAY + onejan.getDay() + 1) / 7);
      const key = `${d.getFullYear()}-W${week}`;
      const existing = weeklyByKey.get(key);
      if (!existing || existing.createdAt < b.createdAt) weeklyByKey.set(key, b);
    }
    for (const b of weeklyByKey.values()) keep.add(b.fullPath);

    // 12 mensuales: uno por mes de los últimos 12 meses.
    const monthlyByKey = new Map<string, BackupEntry>();
    for (const b of all) {
      if (now - b.createdAt > 365 * DAY) continue;
      const d = new Date(b.createdAt);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      const existing = monthlyByKey.get(key);
      if (!existing || existing.createdAt < b.createdAt) monthlyByKey.set(key, b);
    }
    for (const b of monthlyByKey.values()) keep.add(b.fullPath);

    let removed = 0;
    for (const b of all) {
      if (!keep.has(b.fullPath)) {
        try {
          await fsp.unlink(b.fullPath);
          removed++;
        } catch {
          // ignore
        }
      }
    }
    return { removed };
  }

  /** Utilitario para tests: stat de un archivo. */
  statSyncSafe(p: string): number | null {
    try { return statSync(p).size; } catch { return null; }
  }
}
