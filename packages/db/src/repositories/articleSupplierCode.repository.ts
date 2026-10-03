/**
 * Repositorio de CÓDIGOS DE PROVEEDOR: con qué código llama cada proveedor a
 * un artículo (facturas de compra por teléfono, ver docs/PLAN_FACTURAS_TELEFONO.md).
 *
 * Se llena cuando el usuario vincula un renglón de una factura escaneada con
 * un artículo; la próxima factura de ese proveedor sale vinculada sola.
 * Síncrono, como audit.repository.ts.
 */
import { and, asc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { LocalDatabase } from '../local/client';
import { articleSupplierCodes, type ArticleSupplierCode } from '../schema/local';

/** El código se compara tal cual se guarda: sin espacios alrededor. */
function normalizar(code: string): string {
  return String(code ?? '').trim();
}

export class ArticleSupplierCodeRepository {
  constructor(private readonly db: LocalDatabase) {}

  /** Vínculo de ese código para ese proveedor, o null si todavía no se vinculó. */
  buscar(supplierId: string, code: string): ArticleSupplierCode | null {
    const codigo = normalizar(code);
    if (!supplierId || !codigo) return null;
    const row = this.db
      .select()
      .from(articleSupplierCodes)
      .where(and(eq(articleSupplierCodes.supplierId, supplierId), eq(articleSupplierCodes.code, codigo)))
      .get();
    return row ?? null;
  }

  /** Todos los códigos conocidos de un proveedor (para vincular una factura entera de una vez). */
  listarPorProveedor(supplierId: string): ArticleSupplierCode[] {
    return this.db
      .select()
      .from(articleSupplierCodes)
      .where(eq(articleSupplierCodes.supplierId, supplierId))
      .orderBy(asc(articleSupplierCodes.code))
      .all();
  }

  /**
   * Guarda (o corrige) el vínculo. Upsert por el único (proveedor, código): si
   * el código ya apuntaba a otro artículo, pasa a apuntar al nuevo — gana lo
   * último que el usuario vinculó. `unitsPerPack` (unidades por bulto que el
   * usuario confirmó) y `description` (cómo imprimió el proveedor ese código)
   * se pisan sólo si vienen: sin ellos queda lo que había.
   */
  guardar(
    supplierId: string,
    code: string,
    articleId: string,
    unitsPerPack?: number | null,
    description?: string | null,
  ): ArticleSupplierCode {
    const codigo = normalizar(code);
    if (!supplierId || !codigo || !articleId) {
      throw new Error('Faltan datos para guardar el código del proveedor.');
    }
    const uxb =
      typeof unitsPerPack === 'number' && Number.isFinite(unitsPerPack) && unitsPerPack > 0 ? unitsPerPack : undefined;
    const descripcion = typeof description === 'string' && description.trim() ? description.trim().slice(0, 300) : undefined;
    const ahora = Date.now();
    this.db
      .insert(articleSupplierCodes)
      .values({
        id: uuidv7(),
        articleId,
        supplierId,
        code: codigo,
        unitsPerPack: uxb ?? null,
        description: descripcion ?? null,
        createdAt: ahora,
        updatedAt: ahora,
      })
      .onConflictDoUpdate({
        target: [articleSupplierCodes.supplierId, articleSupplierCodes.code],
        set: {
          articleId,
          updatedAt: ahora,
          ...(uxb !== undefined ? { unitsPerPack: uxb } : {}),
          ...(descripcion !== undefined ? { description: descripcion } : {}),
        },
      })
      .run();
    return this.buscar(supplierId, codigo)!;
  }

  borrar(id: string): void {
    this.db.delete(articleSupplierCodes).where(eq(articleSupplierCodes.id, id)).run();
  }
}
