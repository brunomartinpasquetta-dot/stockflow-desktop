/**
 * Matcher de artículos para TODOS los buscadores del sistema.
 *
 * Filtra "automáticamente por cualquier propiedad": código de barras,
 * descripción, marca, familia y proveedor — sin abrir el panel de filtros.
 * La consulta se parte en palabras y CADA palabra debe matchear alguna
 * propiedad (así "bebidas bosch" = familia Bebidas + marca Bosch), ignorando
 * mayúsculas y acentos ("lacteos" encuentra "Lácteos").
 */
import type { ArticleDTO } from '@/types/api'

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

export interface ArticleSearchContext {
  /** Resuelve el nombre de la familia por id (opcional). */
  familyName?: (id: string | null) => string
  /** Resuelve el nombre del proveedor por id (opcional). */
  supplierName?: (id: string | null) => string
}

/** true si el artículo matchea TODAS las palabras de `query` en alguna propiedad. */
export function articleMatches(a: ArticleDTO, query: string, ctx?: ArticleSearchContext): boolean {
  const q = norm(query.trim())
  if (!q) return true
  const haystack = norm(
    [
      a.barcode,
      a.description,
      a.brand ?? '',
      ctx?.familyName?.(a.familyId) ?? '',
      ctx?.supplierName?.(a.supplierId) ?? '',
    ].join(' '),
  )
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

/** Arma un ArticleSearchContext desde listas de familias/proveedores. */
export function buildSearchContext(
  families?: { id: string; name: string }[] | null,
  suppliers?: { id: string; name: string; code?: string }[] | null,
): ArticleSearchContext {
  const fam = new Map((families ?? []).map((f) => [f.id, f.name]))
  const sup = new Map((suppliers ?? []).map((s) => [s.id, s.name]))
  return {
    familyName: (id) => (id ? (fam.get(id) ?? '') : ''),
    supplierName: (id) => (id ? (sup.get(id) ?? '') : ''),
  }
}
