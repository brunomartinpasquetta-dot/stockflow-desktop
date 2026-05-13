/**
 * Servicio de backup automático.
 *
 * Empaqueta la DB de StockFlow en un .zip con `archiver`, dentro de un
 * directorio configurable. La política de retención mantiene los últimos 7
 * diarios + 4 semanales + 12 mensuales (~23 en total).
 *
 * Restore: usa `unzip` (macOS/Linux) o `tar` (Windows 10+) por childprocess
 * para no agregar otra dep de unzip.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, promises as fsp, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BackupEntry } from '../hardware/types';

const execFileP = promisify(execFile);

interface BackupServiceDeps {
  dbPath: string;
  backupDir: string;
  appVersion: string;
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

  async createBackup(destOverride?: string): Promise<BackupEntry> {
    const dest = destOverride ?? this.deps.backupDir;
    if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
    const now = Date.now();
    const filename = this.filenameFor(now);
    const fullPath = path.join(dest, filename);
    const tmpPath = `${fullPath}.tmp`;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const archiverMod: any = await import('archiver');
      const archiver = archiverMod.default ?? archiverMod;
      const { createWriteStream } = await import('node:fs');

      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        if (existsSync(this.deps.dbPath)) {
          archive.file(this.deps.dbPath, { name: 'database/stockflow.db' });
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

      await fsp.rename(tmpPath, fullPath);
      const st = await fsp.stat(fullPath);
      return { filename, fullPath, sizeBytes: st.size, createdAt: now };
    } catch (err) {
      try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
      throw new Error('No se pudo crear el backup', { cause: err });
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
      // Reemplazar la DB actual atómicamente.
      const tmpTarget = `${this.deps.dbPath}.restoring`;
      await fsp.copyFile(dbInZip, tmpTarget);
      await fsp.rename(tmpTarget, this.deps.dbPath);
      return { requiresRestart: true };
    } catch (err) {
      throw new Error('No se pudo restaurar el backup', { cause: err });
    } finally {
      try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  async cleanupOldBackups(): Promise<{ removed: number }> {
    const all = await this.listBackups();
    if (all.length === 0) return { removed: 0 };
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const keep = new Set<string>();

    // Últimos 7 diarios: un backup por día (el más reciente) de los últimos 7 días.
    const dailyByKey = new Map<string, BackupEntry>();
    for (const b of all) {
      if (now - b.createdAt > 7 * DAY) continue;
      const key = new Date(b.createdAt).toISOString().slice(0, 10);
      const existing = dailyByKey.get(key);
      if (!existing || existing.createdAt < b.createdAt) dailyByKey.set(key, b);
    }
    for (const b of dailyByKey.values()) keep.add(b.fullPath);

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
