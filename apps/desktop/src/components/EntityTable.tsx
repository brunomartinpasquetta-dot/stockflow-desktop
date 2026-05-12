import { useMemo, useState, type ReactNode } from 'react'
import { ArrowUpDown, Inbox, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export interface Column<T> {
  key: string
  header: string
  render?: (row: T) => ReactNode
  sortValue?: (row: T) => string | number
  className?: string
  align?: 'left' | 'right' | 'center'
}

interface EntityTableProps<T extends { id: string }> {
  columns: Column<T>[]
  data: T[] | undefined
  isLoading?: boolean
  onNew?: () => void
  onEdit?: (row: T) => void
  onDelete?: (row: T) => void | Promise<void>
  canDelete?: (row: T) => boolean
  deleteTitle?: (row: T) => string
  newLabel?: string
  searchPlaceholder?: string
  searchFields?: (keyof T)[]
  emptyMessage?: string
}

const PAGE_SIZE = 50

function alignClass(a: Column<unknown>['align']): string {
  return a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left'
}

export function EntityTable<T extends { id: string }>({
  columns,
  data,
  isLoading = false,
  onNew,
  onEdit,
  onDelete,
  canDelete,
  deleteTitle,
  newLabel = 'Nuevo',
  searchPlaceholder = 'Buscar…',
  searchFields,
  emptyMessage = 'No hay registros aún',
}: EntityTableProps<T>) {
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortAsc, setSortAsc] = useState(true)
  const [page, setPage] = useState(0)
  const [pendingDelete, setPendingDelete] = useState<T | null>(null)
  const [deleting, setDeleting] = useState(false)

  const rows = useMemo(() => data ?? [], [data])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    const fields = searchFields ?? (columns.map((c) => c.key) as (keyof T)[])
    return rows.filter((r) =>
      fields.some((f) => {
        const v = (r as Record<string, unknown>)[f as string]
        return v != null && String(v).toLowerCase().includes(q)
      }),
    )
  }, [rows, search, searchFields, columns])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const col = columns.find((c) => c.key === sortKey)
    const get = (r: T): string | number => {
      if (col?.sortValue) return col.sortValue(r)
      const v = (r as Record<string, unknown>)[sortKey]
      return typeof v === 'number' ? v : String(v ?? '')
    }
    const out = [...filtered].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      if (av < bv) return sortAsc ? -1 : 1
      if (av > bv) return sortAsc ? 1 : -1
      return 0
    })
    return out
  }, [filtered, sortKey, sortAsc, columns])

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  function toggleSort(key: string): void {
    if (sortKey === key) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete || !onDelete) return
    setDeleting(true)
    try {
      await onDelete(pendingDelete)
      toast.success('Registro borrado')
      setPendingDelete(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo borrar el registro')
    } finally {
      setDeleting(false)
    }
  }

  const hasActions = Boolean(onEdit || onDelete)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
          />
        </div>
        {onNew && (
          <Button variant="success" onClick={onNew}>
            <Plus className="h-4 w-4" />
            {newLabel}
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.key} className={cn(alignClass(c.align), c.className)}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.header}
                    <ArrowUpDown className={cn('h-3 w-3', sortKey === c.key ? 'opacity-100' : 'opacity-30')} />
                  </button>
                </TableHead>
              ))}
              {hasActions && <TableHead className="w-px text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {columns.map((c) => (
                    <TableCell key={c.key}>
                      <div className="h-4 w-full max-w-[10rem] animate-pulse rounded bg-muted" />
                    </TableCell>
                  ))}
                  {hasActions && <TableCell />}
                </TableRow>
              ))
            ) : pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length + (hasActions ? 1 : 0)}>
                  <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                    <Inbox className="h-8 w-8 opacity-50" />
                    <span className="text-sm">{search ? 'Sin resultados' : emptyMessage}</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((row) => {
                const deletable = onDelete && (!canDelete || canDelete(row))
                return (
                  <TableRow
                    key={row.id}
                    className={onEdit ? 'cursor-pointer' : undefined}
                    onDoubleClick={() => onEdit?.(row)}
                  >
                    {columns.map((c) => (
                      <TableCell key={c.key} className={cn(alignClass(c.align), c.className)}>
                        {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '')}
                      </TableCell>
                    ))}
                    {hasActions && (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {onEdit && (
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(row)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {onDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:bg-destructive/10"
                              disabled={!deletable}
                              onClick={() => deletable && setPendingDelete(row)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {!isLoading && sorted.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{sorted.length} registro(s)</span>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <span>
                Página {safePage + 1} de {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Siguiente
              </Button>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={pendingDelete != null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Borrar registro?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && deleteTitle
                ? `Vas a borrar “${deleteTitle(pendingDelete)}”. Esta acción no se puede deshacer.`
                : 'Esta acción no se puede deshacer.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault()
                void confirmDelete()
              }}
            >
              {deleting ? 'Borrando…' : 'Borrar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
