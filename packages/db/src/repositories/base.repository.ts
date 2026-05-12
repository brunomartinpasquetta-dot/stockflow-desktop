/**
 * Repositorio base genérico (patrón Repository).
 *
 * - Recibe la conexión Drizzle por inyección (Dependency Inversion): no la importa.
 * - Es extendible sin modificarlo (Open/Closed): las subclases agregan métodos
 *   específicos de su entidad, no se toca esta clase.
 * - Mantiene una sola responsabilidad: CRUD genérico sobre UNA tabla.
 * - Convierte cualquier error de SQLite a un error de dominio tipado.
 *
 * Nota: better-sqlite3 es síncrono; los métodos devuelven `Promise` por contrato
 * (para no acoplar a los consumidores al driver) pero internamente no hay I/O async.
 */
import { and, eq, getTableColumns, sql, type Column, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { ZodTypeAny } from 'zod';

import { DatabaseError, NotFoundError, rethrowDbError, ValidationError } from '../errors';
import type { LocalDatabase } from '../local/client';

export abstract class BaseRepository<
  TSelect extends Record<string, unknown>,
  TInsert extends Record<string, unknown>,
> {
  /** Schema Zod para validar el input de `create` (opcional, lo setea la subclase). */
  protected readonly createSchema?: ZodTypeAny;
  /** Schema Zod para validar el input de `update` (opcional, lo setea la subclase). */
  protected readonly updateSchema?: ZodTypeAny;

  protected constructor(
    protected readonly db: LocalDatabase,
    protected readonly table: SQLiteTable,
    protected readonly entityName: string,
  ) {}

  // --- helpers internos --------------------------------------------------

  protected get columns(): Record<string, Column> {
    return getTableColumns(this.table) as Record<string, Column>;
  }

  /** Columna `id` (todas las tablas del schema local la tienen). */
  protected get idColumn(): Column {
    const col = this.columns.id;
    if (!col) throw new Error(`La tabla de ${this.entityName} no tiene columna id`);
    return col;
  }

  protected column(name: string): Column {
    const col = this.columns[name];
    if (!col) {
      throw new Error(`Columna desconocida en ${this.entityName}: ${String(name)}`);
    }
    return col;
  }

  protected buildWhere(filters?: Partial<TSelect>): SQL | undefined {
    if (!filters) return undefined;
    const conds = Object.entries(filters)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => eq(this.column(k), v));
    if (conds.length === 0) return undefined;
    if (conds.length === 1) return conds[0];
    return and(...conds);
  }

  protected parseOrThrow<T>(schema: ZodTypeAny, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw ValidationError.fromZod(result.error);
    }
    return result.data as T;
  }

  // --- API CRUD ----------------------------------------------------------

  async findAll(filters?: Partial<TSelect>): Promise<TSelect[]> {
    try {
      const where = this.buildWhere(filters);
      const q = this.db.select().from(this.table);
      const rows = (where ? q.where(where) : q).all();
      return rows as TSelect[];
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findById(id: string): Promise<TSelect | null> {
    try {
      const row = this.db.select().from(this.table).where(eq(this.idColumn, id)).get();
      return (row ?? null) as TSelect | null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async findOne(where: Partial<TSelect>): Promise<TSelect | null> {
    try {
      const cond = this.buildWhere(where);
      const q = this.db.select().from(this.table);
      const row = (cond ? q.where(cond) : q).get();
      return (row ?? null) as TSelect | null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async create(data: TInsert): Promise<TSelect> {
    try {
      const payload = this.createSchema
        ? this.parseOrThrow<Record<string, unknown>>(this.createSchema, data)
        : data;
      return this.insertRow(payload);
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async update(id: string, data: Partial<TInsert>): Promise<TSelect> {
    try {
      const payload = this.updateSchema
        ? this.parseOrThrow<Record<string, unknown>>(this.updateSchema, data)
        : data;
      const rows = this.db
        .update(this.table)
        .set(payload as Record<string, unknown>)
        .where(eq(this.idColumn, id))
        .returning()
        .all();
      const row = rows[0];
      if (!row) throw new NotFoundError(this.entityName, id);
      return row as TSelect;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const res = this.db.delete(this.table).where(eq(this.idColumn, id)).run();
      if (res.changes === 0) throw new NotFoundError(this.entityName, id);
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async count(filters?: Partial<TSelect>): Promise<number> {
    try {
      const where = this.buildWhere(filters);
      const q = this.db.select({ value: sql<number>`count(*)` }).from(this.table);
      const row = (where ? q.where(where) : q).get();
      return Number(row?.value ?? 0);
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  // --- protegidos para subclases ----------------------------------------

  /** Inserta una fila ya validada (sin pasar de nuevo por el schema). */
  protected insertRow(payload: Record<string, unknown>): TSelect {
    const rows = this.db.insert(this.table).values(payload).returning().all();
    const row = rows[0];
    if (!row) {
      throw new DatabaseError(
        new Error(`El insert en ${this.entityName} no devolvió ninguna fila`),
      );
    }
    return row as TSelect;
  }
}
