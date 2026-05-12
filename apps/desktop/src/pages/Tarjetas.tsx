import { useState } from 'react'
import { z } from 'zod'
import { toast } from 'sonner'

import { api, ApiError } from '@/lib/api'
import { useCardMutations, useCards } from '@/lib/hooks'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import { Button } from '@/components/ui/button'
import type { CardDTO } from '@/types/api'

const cardSchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio').max(60, 'Máximo 60 caracteres'),
  commissionPct: z.string().refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) <= 100, { message: 'Porcentaje entre 0 y 100' }),
  discountPct: z.string().refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) <= 100, { message: 'Porcentaje entre 0 y 100' }),
  active: z.boolean(),
})

const COMMON_CARDS = [
  { name: 'Visa', commissionPct: '0.00', discountPct: '0.00', active: true },
  { name: 'Mastercard', commissionPct: '0.00', discountPct: '0.00', active: true },
  { name: 'American Express', commissionPct: '0.00', discountPct: '0.00', active: true },
]

export function Tarjetas() {
  const cards = useCards()
  const m = useCardMutations()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CardDTO | null>(null)
  const [seeding, setSeeding] = useState(false)

  async function toggleActive(c: CardDTO): Promise<void> {
    try {
      await m.update.mutateAsync({ id: c.id, data: { active: !c.active } })
      toast.success(c.active ? 'Tarjeta desactivada' : 'Tarjeta activada')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar')
    }
  }

  async function crearComunes(): Promise<void> {
    setSeeding(true)
    const existing = new Set((cards.data ?? []).map((c) => c.name.toLowerCase()))
    let created = 0
    try {
      for (const c of COMMON_CARDS) {
        if (existing.has(c.name.toLowerCase())) continue
        await api.cards.create(c)
        created++
      }
      void cards.refetch()
      toast.success(created > 0 ? `Se crearon ${created} tarjeta(s)` : 'Las tarjetas comunes ya existían')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudieron crear las tarjetas')
    } finally {
      setSeeding(false)
    }
  }

  const columns: Column<CardDTO>[] = [
    { key: 'name', header: 'Nombre' },
    { key: 'commissionPct', header: 'Comisión %', align: 'right', sortValue: (r) => Number(r.commissionPct), render: (r) => `${formatNumber(r.commissionPct, 2)} %` },
    { key: 'discountPct', header: 'Descuento %', align: 'right', sortValue: (r) => Number(r.discountPct), render: (r) => `${formatNumber(r.discountPct, 2)} %` },
    {
      key: 'active',
      header: 'Estado',
      render: (r) => (
        <button
          type="button"
          onClick={() => void toggleActive(r)}
          className={cn(
            'rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
            r.active ? 'bg-success/15 text-success hover:bg-success/25' : 'bg-muted text-muted-foreground hover:bg-muted/70',
          )}
        >
          {r.active ? 'Activa' : 'Inactiva'}
        </button>
      ),
    },
  ]

  const fields: FieldConfig[] = [
    { name: 'name', label: 'Nombre', type: 'text', full: true },
    { name: 'commissionPct', label: 'Comisión %', type: 'currency', placeholder: '0,00' },
    { name: 'discountPct', label: 'Descuento %', type: 'currency', placeholder: '0,00' },
    { name: 'active', label: 'Tarjeta activa', type: 'checkbox' },
  ]

  const defaultValues: Record<string, unknown> = editing
    ? { name: editing.name, commissionPct: editing.commissionPct, discountPct: editing.discountPct, active: editing.active }
    : { name: '', commissionPct: '0', discountPct: '0', active: true }

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    if (editing) await m.update.mutateAsync({ id: editing.id, data: values })
    else await m.create.mutateAsync(values)
    toast.success(editing ? 'Tarjeta actualizada' : 'Tarjeta creada')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Tarjetas</h1>
        <Button variant="outline" size="sm" onClick={() => void crearComunes()} disabled={seeding}>
          Crear tarjetas comunes
        </Button>
      </div>
      <EntityTable
        columns={columns}
        data={cards.data}
        isLoading={cards.isLoading}
        searchFields={['name']}
        searchPlaceholder="Buscar tarjeta…"
        newLabel="Nueva tarjeta"
        emptyMessage="No hay tarjetas configuradas"
        onNew={() => {
          setEditing(null)
          setFormOpen(true)
        }}
        onEdit={(r) => {
          setEditing(r)
          setFormOpen(true)
        }}
        onDelete={async (r) => {
          try {
            await m.remove.mutateAsync(r.id)
          } catch (err) {
            if (err instanceof ApiError && err.code === 'CONSTRAINT') {
              throw new Error('No se puede borrar: la tarjeta está vinculada a ventas registradas. Desactivala en su lugar.', { cause: err })
            }
            throw err
          }
        }}
        deleteTitle={(r) => r.name}
      />
      <EntityFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar tarjeta' : 'Nueva tarjeta'}
        fields={fields}
        schema={cardSchema}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
