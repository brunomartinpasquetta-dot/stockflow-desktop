/**
 * Repositorio de permisos configurables por rol/área (`role_area_access`).
 *
 * No extiende `BaseRepository` porque la tabla usa PK compuesta (role, area) y
 * no tiene columna `id`. Sólo `manager` y `seller` son configurables; `admin`
 * nunca se persiste (siempre tiene acceso total).
 */
import { and, eq } from 'drizzle-orm';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { roleAreaAccess, type RoleAreaAccess } from '../schema/local';

/** Roles cuya configuración de áreas es editable (admin queda excluido). */
export type ConfigurableRole = 'manager' | 'seller';

export class RolePermissionRepository {
  constructor(private readonly db: LocalDatabase) {}

  /** Todas las filas de configuración (role, area, allowed). */
  async getAll(): Promise<RoleAreaAccess[]> {
    try {
      return this.db.select().from(roleAreaAccess).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Filas de configuración de un rol puntual. */
  async getForRole(role: ConfigurableRole): Promise<RoleAreaAccess[]> {
    try {
      return this.db
        .select()
        .from(roleAreaAccess)
        .where(eq(roleAreaAccess.role, role))
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Reemplaza la configuración de áreas de un rol: habilita (allowed=1) las
   * áreas listadas en `areaKeys` y deshabilita (allowed=0) todas las áreas ya
   * presentes en la tabla para ese rol que no estén en la lista.
   *
   * Idempotente y transaccional. No crea áreas nuevas: opera sobre el universo
   * de áreas ya sembradas para el rol (más las que se pasen explícitamente).
   */
  async setForRole(role: ConfigurableRole, areaKeys: readonly string[]): Promise<void> {
    try {
      const wanted = new Set(areaKeys);
      this.db.transaction((tx) => {
        const existing = tx
          .select()
          .from(roleAreaAccess)
          .where(eq(roleAreaAccess.role, role))
          .all();
        const existingAreas = new Set(existing.map((r) => r.area));

        // 1) Insertar/habilitar las áreas pedidas.
        for (const area of wanted) {
          if (existingAreas.has(area)) {
            tx.update(roleAreaAccess)
              .set({ allowed: true })
              .where(and(eq(roleAreaAccess.role, role), eq(roleAreaAccess.area, area)))
              .run();
          } else {
            tx.insert(roleAreaAccess).values({ role, area, allowed: true }).run();
          }
        }

        // 2) Deshabilitar el resto de las áreas existentes.
        for (const row of existing) {
          if (wanted.has(row.area)) continue;
          tx.update(roleAreaAccess)
            .set({ allowed: false })
            .where(and(eq(roleAreaAccess.role, role), eq(roleAreaAccess.area, row.area)))
            .run();
        }
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }
}
