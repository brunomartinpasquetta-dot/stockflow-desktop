/**
 * Persistencia simple en localStorage del historial de búsquedas del usuario
 * (últimas N selecciones del CommandPalette). No depende de la sesión: si el
 * sistema multi-usuario lo requiere en el futuro, se puede prefijar la key
 * con el userId.
 */
const KEY = 'stockflow:search:recent'
const CAP = 10

export type RecentKind =
  | 'article'
  | 'customer'
  | 'supplier'
  | 'sale'
  | 'purchase'
  | 'action'

export interface RecentSearch {
  kind: RecentKind
  /** id de la entidad o slug de la acción */
  id: string
  label: string
  meta?: string
  ts: number
}

function safeParse(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((it): it is RecentSearch => {
      if (!it || typeof it !== 'object') return false
      const r = it as Record<string, unknown>
      return typeof r.kind === 'string' && typeof r.id === 'string' && typeof r.label === 'string' && typeof r.ts === 'number'
    })
  } catch {
    return []
  }
}

export function getRecents(): RecentSearch[] {
  return safeParse()
}

export function addRecent(entry: Omit<RecentSearch, 'ts'>): void {
  try {
    const list = safeParse().filter((r) => !(r.kind === entry.kind && r.id === entry.id))
    list.unshift({ ...entry, ts: Date.now() })
    while (list.length > CAP) list.pop()
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore quota errors */
  }
}

export function clearRecents(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
