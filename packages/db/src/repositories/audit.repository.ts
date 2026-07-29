/**
 * Repositorio de AUDITORÍA: registro append-only de operaciones del sistema.
 *
 * Las filas las inserta la capa IPC después de cada operación de escritura
 * exitosa (ver apps/desktop/electron/ipc/audit.ts). La inserción nunca debe
 * hacer fallar la operación original: quien llama la envuelve en try/catch.
 */
import { and, desc, eq, gte, like, lte, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { LocalDatabase } from '../local/client';
import { auditLog, type AuditLogEntry } from '../schema/local';

export interface InsertAuditInput {
  userId: string | null;
  username: string;
  channel: string;
  area: string;
  description: string;
}

export interface ListAuditInput {
  from?: number;
  to?: number;
  userId?: string;
  area?: string;
  /** búsqueda por texto libre en la descripción */
  q?: string;
  limit?: number;
}

export class AuditRepository {
  constructor(private readonly db: LocalDatabase) {}

  insert(input: InsertAuditInput): AuditLogEntry {
    const row: AuditLogEntry = {
      id: uuidv7(),
      createdAt: Date.now(),
      userId: input.userId,
      username: input.username,
      channel: input.channel,
      area: input.area,
      description: input.description,
    };
    this.db.insert(auditLog).values(row).run();
    return row;
  }

  list(input: ListAuditInput = {}): AuditLogEntry[] {
    const conds: SQL[] = [];
    if (input.from != null) conds.push(gte(auditLog.createdAt, input.from));
    if (input.to != null) conds.push(lte(auditLog.createdAt, input.to));
    if (input.userId) conds.push(eq(auditLog.userId, input.userId));
    if (input.area) conds.push(eq(auditLog.area, input.area));
    if (input.q) conds.push(like(auditLog.description, `%${input.q}%`));
    return this.db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(input.limit ?? 500, 2000))
      .all();
  }

  /** Áreas distintas presentes en el log (para el filtro de la pantalla). */
  listAreas(): string[] {
    const rows = this.db.selectDistinct({ area: auditLog.area }).from(auditLog).all();
    return rows.map((r) => r.area).sort();
  }
}
