import { eq, isNull } from 'drizzle-orm';
import { CreateFamilySchema, UpdateFamilySchema } from '@stockflow/shared';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { families, type Family, type NewFamily } from '../schema/local';
import { BaseRepository } from './base.repository';

export class FamilyRepository extends BaseRepository<Family, NewFamily> {
  protected override readonly createSchema = CreateFamilySchema;
  protected override readonly updateSchema = UpdateFamilySchema;

  constructor(db: LocalDatabase) {
    super(db, families, 'Familia');
  }

  /** Familias raíz (sin padre). */
  async findRoots(): Promise<Family[]> {
    try {
      return this.db.select().from(families).where(isNull(families.parentId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Hijos directos de una familia. */
  async findDirectChildren(parentId: string): Promise<Family[]> {
    try {
      return this.db.select().from(families).where(eq(families.parentId, parentId)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Todos los descendientes de una familia (recorrido recursivo en memoria). */
  async findChildren(parentId: string): Promise<Family[]> {
    try {
      const all = this.db.select().from(families).all();
      const byParent = new Map<string, Family[]>();
      for (const f of all) {
        if (f.parentId == null) continue;
        const list = byParent.get(f.parentId) ?? [];
        list.push(f);
        byParent.set(f.parentId, list);
      }
      const out: Family[] = [];
      const stack = [...(byParent.get(parentId) ?? [])];
      while (stack.length > 0) {
        const node = stack.pop()!;
        out.push(node);
        const kids = byParent.get(node.id);
        if (kids) stack.push(...kids);
      }
      return out;
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
