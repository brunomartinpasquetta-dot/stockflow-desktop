/**
 * Repositorio de FACTURAS ESCANEADAS: facturas de compra fotografiadas desde
 * el teléfono (ver docs/PLAN_FACTURAS_TELEFONO.md).
 *
 * Una fila NO es una compra: es el borrador que se lee de fondo, se revisa y
 * recién después precarga el formulario de Compras. Las columnas `photos`,
 * `pages_text`, `header` y `lines` son JSON en texto; acá se serializan al
 * escribir y se parsean al leer, así el resto del sistema trabaja con objetos.
 * La forma del encabezado y de los renglones la define el motor
 * (apps/desktop/electron/facturas): esta capa sólo los guarda.
 * Síncrono, como audit.repository.ts.
 */
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { LocalDatabase } from '../local/client';
import { scannedInvoices, type ScannedInvoiceRow, type ScannedInvoiceStatus } from '../schema/local';

export interface FacturaEscaneada<Encabezado = Record<string, unknown>, Renglon = unknown> {
  id: string;
  status: ScannedInvoiceStatus;
  supplierId: string | null;
  /** nombres de archivo de las fotos, en orden de hoja */
  photos: string[];
  /** texto leído por hoja */
  pagesText: string[];
  header: Encabezado | null;
  lines: Renglon[];
  error: string | null;
  pagesDone: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ListarFacturasEscaneadas {
  estados?: ScannedInvoiceStatus[];
  limite?: number;
  /**
   * true = no trae `pages_text` (el texto leído de cada hoja, lo más pesado de
   * la fila): `pagesText` vuelve vacío. Para las listas y los sondeos.
   */
  sinTexto?: boolean;
}

export type ActualizarFacturaEscaneada = Partial<
  Pick<
    FacturaEscaneada,
    'status' | 'supplierId' | 'photos' | 'pagesText' | 'header' | 'lines' | 'error' | 'pagesDone'
  >
>;

/** JSON guardado → valor. Una columna dañada no debe tumbar la pantalla: cae al valor por defecto. */
function leerJson<T>(texto: string | null, porDefecto: T): T {
  if (texto == null || texto === '') return porDefecto;
  try {
    const valor = JSON.parse(texto) as unknown;
    if (Array.isArray(porDefecto)) return (Array.isArray(valor) ? valor : porDefecto) as T;
    return (valor ?? porDefecto) as T;
  } catch {
    return porDefecto;
  }
}

function aFactura(row: ScannedInvoiceRow): FacturaEscaneada {
  return {
    id: row.id,
    status: row.status,
    supplierId: row.supplierId,
    photos: leerJson<string[]>(row.photos, []),
    pagesText: leerJson<string[]>(row.pagesText, []),
    header: leerJson<Record<string, unknown> | null>(row.header, null),
    lines: leerJson<unknown[]>(row.lines, []),
    error: row.error,
    pagesDone: row.pagesDone,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ScannedInvoiceRepository {
  constructor(private readonly db: LocalDatabase) {}

  /** Factura nueva, vacía, en estado `recibiendo` (el teléfono todavía está mandando hojas). */
  crear(input: { createdBy?: string | null } = {}): FacturaEscaneada {
    const ahora = Date.now();
    const id = uuidv7();
    this.db
      .insert(scannedInvoices)
      .values({
        id,
        status: 'recibiendo',
        createdBy: input.createdBy ?? null,
        createdAt: ahora,
        updatedAt: ahora,
      })
      .run();
    return this.obtener(id)!;
  }

  obtener(id: string): FacturaEscaneada | null {
    const row = this.db.select().from(scannedInvoices).where(eq(scannedInvoices.id, id)).get();
    return row ? aFactura(row) : null;
  }

  /** Más nuevas primero. Sin `estados` devuelve todas (incluidas las descartadas). */
  listar(input: ListarFacturasEscaneadas = {}): FacturaEscaneada[] {
    // `estados: []` es "ninguno": no se cae a "todas" por una lista vacía.
    if (input.estados && input.estados.length === 0) return [];
    const limite = Math.min(Math.max(input.limite ?? 200, 1), 1000);
    const donde = input.estados ? inArray(scannedInvoices.status, input.estados) : undefined;
    if (input.sinTexto) {
      return this.db
        .select({
          id: scannedInvoices.id,
          status: scannedInvoices.status,
          supplierId: scannedInvoices.supplierId,
          photos: scannedInvoices.photos,
          header: scannedInvoices.header,
          lines: scannedInvoices.lines,
          error: scannedInvoices.error,
          pagesDone: scannedInvoices.pagesDone,
          createdBy: scannedInvoices.createdBy,
          createdAt: scannedInvoices.createdAt,
          updatedAt: scannedInvoices.updatedAt,
        })
        .from(scannedInvoices)
        .where(donde)
        .orderBy(desc(scannedInvoices.createdAt), desc(scannedInvoices.id))
        .limit(limite)
        .all()
        .map((row) => aFactura({ ...row, pagesText: '[]' }));
    }
    return this.db
      .select()
      .from(scannedInvoices)
      .where(donde)
      .orderBy(desc(scannedInvoices.createdAt), desc(scannedInvoices.id))
      .limit(limite)
      .all()
      .map(aFactura);
  }

  /** Cuántas facturas hay en cada estado, sin traer ninguna fila (contadores y topes). */
  contarPorEstado(): Partial<Record<ScannedInvoiceStatus, number>> {
    const filas = this.db
      .select({ status: scannedInvoices.status, n: sql<number>`count(*)` })
      .from(scannedInvoices)
      .groupBy(scannedInvoices.status)
      .all();
    const salida: Partial<Record<ScannedInvoiceStatus, number>> = {};
    for (const f of filas) salida[f.status] = Number(f.n);
    return salida;
  }

  /**
   * Cambia sólo los campos presentes en `cambios` (serializa los JSON).
   * Devuelve la factura actualizada, o null si no existe.
   */
  actualizar(id: string, cambios: ActualizarFacturaEscaneada): FacturaEscaneada | null {
    const set: Partial<ScannedInvoiceRow> = { updatedAt: Date.now() };
    if (cambios.status !== undefined) set.status = cambios.status;
    if (cambios.supplierId !== undefined) set.supplierId = cambios.supplierId;
    if (cambios.photos !== undefined) set.photos = JSON.stringify(cambios.photos ?? []);
    if (cambios.pagesText !== undefined) set.pagesText = JSON.stringify(cambios.pagesText ?? []);
    if (cambios.header !== undefined) set.header = cambios.header == null ? null : JSON.stringify(cambios.header);
    if (cambios.lines !== undefined) set.lines = JSON.stringify(cambios.lines ?? []);
    if (cambios.error !== undefined) set.error = cambios.error;
    if (cambios.pagesDone !== undefined) set.pagesDone = cambios.pagesDone;
    this.db.update(scannedInvoices).set(set).where(eq(scannedInvoices.id, id)).run();
    return this.obtener(id);
  }

  /** La factura `en_cola` más vieja (se leen de a una, en orden de llegada), o null. */
  siguienteEnCola(): FacturaEscaneada | null {
    const row = this.db
      .select()
      .from(scannedInvoices)
      .where(eq(scannedInvoices.status, 'en_cola'))
      .orderBy(asc(scannedInvoices.createdAt), asc(scannedInvoices.id))
      .limit(1)
      .get();
    return row ? aFactura(row) : null;
  }
}
