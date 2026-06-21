import { eq, isNull } from 'drizzle-orm';
import { CreateFamilySchema, UpdateFamilySchema } from '@stockflow/shared';

import { rethrowDbError, ValidationError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { families, type Family, type NewFamily } from '../schema/local';
import { BaseRepository } from './base.repository';

export class FamilyRepository extends BaseRepository<Family, NewFamily> {
  protected override readonly createSchema = CreateFamilySchema;
  protected override readonly updateSchema = UpdateFamilySchema;

  constructor(db: LocalDatabase) {
    super(db, families, 'Familia');
  }

  /**
   * Override del update: valida que no se genere un ciclo en el árbol de familias
   * ANTES de escribir. Asignar como padre la propia familia o uno de sus
   * descendientes colgaría la app (bucle infinito en `findChildren`/`treeOrder`).
   */
  override async update(id: string, data: Partial<NewFamily>): Promise<Family> {
    if ('parentId' in data && data.parentId != null) {
      const newParentId = data.parentId as string;
      if (newParentId === id) {
        throw new ValidationError(
          'parentId',
          'No se puede asignar una familia hija como padre (ciclo)',
        );
      }
      const descendants = this.collectDescendantIds(id);
      if (descendants.has(newParentId)) {
        throw new ValidationError(
          'parentId',
          'No se puede asignar una familia hija como padre (ciclo)',
        );
      }
    }
    return super.update(id, data);
  }

  /**
   * IDs de todos los descendientes de `rootId`. Recorrido iterativo con set de
   * visitados para no colgarse si la data ya tuviera un ciclo preexistente.
   */
  private collectDescendantIds(rootId: string): Set<string> {
    const all = this.db.select().from(families).all();
    const byParent = new Map<string, string[]>();
    for (const f of all) {
      if (f.parentId == null) continue;
      const list = byParent.get(f.parentId) ?? [];
      list.push(f.id);
      byParent.set(f.parentId, list);
    }
    const out = new Set<string>();
    const stack = [...(byParent.get(rootId) ?? [])];
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (out.has(nodeId)) continue;
      out.add(nodeId);
      const kids = byParent.get(nodeId);
      if (kids) stack.push(...kids);
    }
    return out;
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
