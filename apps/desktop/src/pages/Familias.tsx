import { useMemo, useState } from 'react'
import { z } from 'zod'
import { toast } from 'sonner'

import { useArticles, useFamilies, useFamilyMutations } from '@/lib/hooks'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import type { FamilyDTO } from '@/types/api'

const familySchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio').max(100, 'Máximo 100 caracteres'),
  parentId: z.string(),
})

interface OrderedNode {
  row: FamilyDTO
  depth: number
}

function treeOrder(list: FamilyDTO[]): OrderedNode[] {
  const byParent = new Map<string | null, FamilyDTO[]>()
  for (const f of list) {
    const k = f.parentId ?? null
    const arr = byParent.get(k) ?? []
    arr.push(f)
    byParent.set(k, arr)
  }
  const out: OrderedNode[] = []
  const visit = (parent: string | null, depth: number): void => {
    for (const f of byParent.get(parent) ?? []) {
      out.push({ row: f, depth })
      visit(f.id, depth + 1)
    }
  }
  visit(null, 0)
  const seen = new Set(out.map((o) => o.row.id))
  for (const f of list) if (!seen.has(f.id)) out.push({ row: f, depth: 0 })
  return out
}

export function Familias() {
  const families = useFamilies()
  const articles = useArticles()
  const m = useFamilyMutations()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<FamilyDTO | null>(null)

  const ordered = useMemo(() => treeOrder(families.data ?? []), [families.data])
  const depthById = useMemo(() => new Map(ordered.map((o) => [o.row.id, o.depth])), [ordered])
  const nameById = useMemo(() => new Map((families.data ?? []).map((f) => [f.id, f.name])), [families.data])
  const articleCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const a of articles.data ?? []) if (a.familyId) map.set(a.familyId, (map.get(a.familyId) ?? 0) + 1)
    return map
  }, [articles.data])
  const subCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const f of families.data ?? []) if (f.parentId) map.set(f.parentId, (map.get(f.parentId) ?? 0) + 1)
    return map
  }, [families.data])

  const columns: Column<FamilyDTO>[] = [
    {
      key: 'name',
      header: 'Nombre',
      render: (r) => {
        const d = depthById.get(r.id) ?? 0
        return (
          <span style={{ paddingLeft: d * 18 }} className={d > 0 ? 'text-muted-foreground' : ''}>
            {d > 0 ? '↳ ' : ''}
            {r.name}
          </span>
        )
      },
    },
    { key: 'parentId', header: 'Familia padre', render: (r) => (r.parentId ? (nameById.get(r.parentId) ?? '—') : '— (raíz)') },
    { key: 'articles', header: 'Artículos', align: 'right', render: (r) => String(articleCount.get(r.id) ?? 0) },
  ]

  const parentOptions = (families.data ?? [])
    .filter((f) => !editing || f.id !== editing.id)
    .map((f) => ({ value: f.id, label: f.name }))

  const fields: FieldConfig[] = [
    { name: 'name', label: 'Nombre', type: 'text', full: true },
    { name: 'parentId', label: 'Familia padre', type: 'select', allowEmpty: true, options: parentOptions, helpText: 'Dejar vacío para una familia raíz' },
  ]

  const defaultValues: Record<string, unknown> = editing
    ? { name: editing.name, parentId: editing.parentId ?? '' }
    : { name: '', parentId: '' }

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = { name: values.name, parentId: values.parentId || null }
    if (editing) await m.update.mutateAsync({ id: editing.id, data: payload })
    else await m.create.mutateAsync(payload)
    toast.success(editing ? 'Familia actualizada' : 'Familia creada')
  }

  async function handleDelete(r: FamilyDTO): Promise<void> {
    const arts = articleCount.get(r.id) ?? 0
    if (arts > 0) throw new Error(`Hay ${arts} artículo(s) vinculado(s) a esta familia. Reasignalos antes de borrarla.`)
    const subs = subCount.get(r.id) ?? 0
    if (subs > 0) throw new Error(`Esta familia tiene ${subs} subfamilia(s). Borralas o movelas primero.`)
    await m.remove.mutateAsync(r.id)
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Familias</h1>
      <EntityTable
        columns={columns}
        data={ordered.map((o) => o.row)}
        isLoading={families.isLoading}
        searchFields={['name']}
        searchPlaceholder="Buscar familia…"
        newLabel="Nueva familia"
        emptyMessage="No hay familias cargadas"
        onNew={() => {
          setEditing(null)
          setFormOpen(true)
        }}
        onEdit={(r) => {
          setEditing(r)
          setFormOpen(true)
        }}
        onDelete={handleDelete}
        deleteTitle={(r) => r.name}
      />
      <EntityFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar familia' : 'Nueva familia'}
        fields={fields}
        schema={familySchema}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
