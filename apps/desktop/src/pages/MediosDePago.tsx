import { useState } from 'react'
import { z } from 'zod'
import { toast } from 'sonner'

import { ApiError } from '@/lib/api'
import { usePaymentMethodMutations, usePaymentMethods } from '@/lib/hooks'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import { useCanWrite } from '@/contexts/LicenseContext'
import { Badge } from '@/components/ui/badge'
import type { PaymentMethodDTO } from '@/types/api'

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'debit_card', label: 'Tarjeta de débito' },
  { value: 'credit_card', label: 'Tarjeta de crédito' },
  { value: 'mp', label: 'Mercado Pago' },
  { value: 'check', label: 'Cheque' },
  { value: 'other', label: 'Otro' },
]
const TYPE_LABELS = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label])) as Record<string, string>

/** IDs de los medios pre-cargados (no se pueden borrar). */
const DEFAULT_IDS = new Set(['pm-efectivo', 'pm-transferencia', 'pm-tarjeta-credito', 'pm-tarjeta-debito'])

const pmSchema = z
  .object({
    name: z.string().min(1, 'El nombre es obligatorio').max(60, 'Máximo 60 caracteres'),
    type: z.enum(['cash', 'transfer', 'debit_card', 'credit_card', 'mp', 'check', 'other']),
    commissionPct: z
      .string()
      .refine((v) => /^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) <= 100, { message: 'Porcentaje entre 0 y 100' }),
    sortOrder: z.coerce.number().int('Debe ser un número entero').min(0, 'Debe ser ≥ 0'),
    isPhysicalCash: z.boolean(),
    active: z.boolean(),
  })
  .superRefine((d, ctx) => {
    if (d.isPhysicalCash && d.type !== 'cash') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isPhysicalCash'],
        message: 'Sólo un medio de tipo "Efectivo" puede afectar el arqueo físico',
      })
    }
  })

export function MediosDePago() {
  const canWrite = useCanWrite()
  const methods = usePaymentMethods()
  const m = usePaymentMethodMutations()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PaymentMethodDTO | null>(null)

  async function toggleActive(pm: PaymentMethodDTO): Promise<void> {
    try {
      await m.update.mutateAsync({ id: pm.id, data: { active: !pm.active } })
      toast.success(pm.active ? 'Medio desactivado' : 'Medio activado')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar')
    }
  }

  const columns: Column<PaymentMethodDTO>[] = [
    { key: 'sortOrder', header: 'Orden', align: 'right', sortValue: (r) => r.sortOrder, className: 'w-16' },
    { key: 'name', header: 'Nombre' },
    { key: 'type', header: 'Tipo', render: (r) => <Badge variant="outline">{TYPE_LABELS[r.type] ?? r.type}</Badge> },
    {
      key: 'commissionPct',
      header: 'Comisión %',
      align: 'right',
      sortValue: (r) => Number(r.commissionPct),
      render: (r) => `${formatNumber(r.commissionPct, 2)} %`,
    },
    {
      key: 'isPhysicalCash',
      header: 'Efectivo físico',
      align: 'center',
      render: (r) => (r.isPhysicalCash ? <span className="text-success">✓</span> : <span className="text-muted-foreground">✗</span>),
    },
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
          {r.active ? 'Activo' : 'Inactivo'}
        </button>
      ),
    },
  ]

  const fields: FieldConfig[] = [
    { name: 'name', label: 'Nombre', type: 'text', full: true },
    { name: 'type', label: 'Tipo', type: 'select', options: TYPE_OPTIONS },
    { name: 'sortOrder', label: 'Orden', type: 'number', placeholder: '0' },
    { name: 'commissionPct', label: 'Comisión %', type: 'currency', placeholder: '0,00' },
    { name: 'isPhysicalCash', label: 'Afecta el arqueo de efectivo físico (sólo para "Efectivo")', type: 'checkbox' },
    { name: 'active', label: 'Medio activo', type: 'checkbox' },
  ]

  const defaultValues: Record<string, unknown> = editing
    ? {
        name: editing.name,
        type: editing.type,
        sortOrder: editing.sortOrder,
        commissionPct: editing.commissionPct,
        isPhysicalCash: editing.isPhysicalCash,
        active: editing.active,
      }
    : {
        name: '',
        type: 'other',
        sortOrder: (methods.data?.length ?? 0) + 1,
        commissionPct: '0',
        isPhysicalCash: false,
        active: true,
      }

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    if (editing) await m.update.mutateAsync({ id: editing.id, data: values })
    else await m.create.mutateAsync(values)
    toast.success(editing ? 'Medio de pago actualizado' : 'Medio de pago creado')
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Medios de pago</h1>
      <EntityTable
        readOnly={!canWrite}
        columns={columns}
        data={methods.data}
        isLoading={methods.isLoading}
        searchFields={['name']}
        searchPlaceholder="Buscar medio de pago…"
        newLabel="Nuevo medio"
        emptyMessage="No hay medios de pago configurados"
        onNew={() => {
          setEditing(null)
          setFormOpen(true)
        }}
        onEdit={(r) => {
          setEditing(r)
          setFormOpen(true)
        }}
        canDelete={(r) => !DEFAULT_IDS.has(r.id)}
        onDelete={async (r) => {
          if (DEFAULT_IDS.has(r.id)) {
            throw new Error('No se puede borrar un medio de pago predeterminado. Desactivalo en su lugar.')
          }
          try {
            await m.remove.mutateAsync(r.id)
          } catch (err) {
            if (err instanceof ApiError && (err.code === 'CONSTRAINT' || err.code === 'BUSINESS_RULE')) {
              throw new Error(err.message, { cause: err })
            }
            throw err
          }
        }}
        deleteTitle={(r) => r.name}
      />
      <EntityFormDialog
        readOnly={!canWrite}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar medio de pago' : 'Nuevo medio de pago'}
        fields={fields}
        schema={pmSchema}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
