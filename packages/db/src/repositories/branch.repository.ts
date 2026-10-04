/**
 * Repositorio de SUCURSALES (multisucursal, ver docs/PLAN_MULTISUCURSAL.md).
 *
 * Mínimo a propósito: listar, obtener, la principal y renombrar. Dar de alta
 * más sucursales llega con el stock por sucursal (etapa 2). Síncrono, como
 * articleSupplierCode.repository.ts.
 */
import { asc, desc, eq } from 'drizzle-orm';

import { NotFoundError, ValidationError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  branches,
  SUCURSAL_CENTRAL_CODIGO,
  SUCURSAL_CENTRAL_ID,
  SUCURSAL_CENTRAL_NOMBRE,
  type Branch,
} from '../schema/local';

/** Largo máximo del nombre: entra en un ticket y en un encabezado de reporte. */
export const SUCURSAL_NOMBRE_MAX = 60;

export class BranchRepository {
  constructor(private readonly db: LocalDatabase) {}

  /** Todas las sucursales: la principal primero, después por nombre. */
  listar(): Branch[] {
    this.asegurarCentral();
    return this.db.select().from(branches).orderBy(desc(branches.isMain), asc(branches.name)).all();
  }

  /** Una sucursal por id, o null si no existe. */
  obtener(id: string): Branch | null {
    if (!id) return null;
    return this.db.select().from(branches).where(eq(branches.id, id)).get() ?? null;
  }

  /**
   * La sucursal principal ("Casa central" salvo que la hayan renombrado).
   * La crea la migración 0040; si alguien la borró a mano de la base, se
   * vuelve a crear con el mismo id fijo para que nada quede sin sucursal.
   */
  principal(): Branch {
    this.asegurarCentral();
    const row =
      this.db.select().from(branches).where(eq(branches.isMain, true)).get() ??
      this.db.select().from(branches).where(eq(branches.id, SUCURSAL_CENTRAL_ID)).get();
    if (!row) throw new NotFoundError('Sucursal', SUCURSAL_CENTRAL_ID);
    return row;
  }

  /** Cambia el nombre visible. El código (CENTRAL, …) no cambia. */
  renombrar(id: string, nombre: string): Branch {
    const limpio = String(nombre ?? '').replace(/\s+/g, ' ').trim();
    if (!limpio) throw new ValidationError('name', 'Ingrese el nombre de la sucursal.');
    if (limpio.length > SUCURSAL_NOMBRE_MAX) {
      throw new ValidationError('name', `El nombre admite hasta ${SUCURSAL_NOMBRE_MAX} caracteres.`);
    }
    const actual = this.obtener(id);
    if (!actual) throw new NotFoundError('Sucursal', id);
    if (actual.name === limpio) return actual;
    const row = this.db
      .update(branches)
      .set({ name: limpio, updatedAt: Date.now() })
      .where(eq(branches.id, id))
      .returning()
      .get();
    return row ?? { ...actual, name: limpio };
  }

  /**
   * Red de seguridad: si no hay ninguna sucursal (base tocada a mano), crea
   * "Casa central" con el id fijo. INSERT OR IGNORE: nunca pisa la existente.
   */
  private asegurarCentral(): void {
    const hay = this.db.select({ id: branches.id }).from(branches).limit(1).get();
    if (hay) return;
    const ahora = Date.now();
    this.db
      .insert(branches)
      .values({
        id: SUCURSAL_CENTRAL_ID,
        name: SUCURSAL_CENTRAL_NOMBRE,
        code: SUCURSAL_CENTRAL_CODIGO,
        active: true,
        isMain: true,
        createdAt: ahora,
        updatedAt: ahora,
      })
      .onConflictDoNothing()
      .run();
  }
}
