import { useState } from 'react'
import { z } from 'zod'
import { toast } from 'sonner'

import { useSupplierMutations, useSuppliers } from '@/lib/hooks'
import { validateCUIT } from '@/lib/cuit'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import { useCanWrite } from '@/contexts/LicenseContext'
import type { SupplierDTO } from '@/types/api'

const supplierSchema = z.object({
  code: z.string().min(1, 'El código es obligatorio'),
  name: z.string().min(1, 'La razón social es obligatoria'),
  address: z.string(),
  city: z.string(),
  cuit: z.string().refine((v) => v === '' || validateCUIT(v), { message: 'CUIT inválido' }),
  ingBrutos: z.string(),
  phone: z.string(),
  mobile: z.string(),
})

export function Proveedores() {
  const canWrite = useCanWrite()
  const suppliers = useSuppliers()
  const m = useSupplierMutations()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<SupplierDTO | null>(null)

  const columns: Column<SupplierDTO>[] = [
    { key: 'code', header: 'Código' },
    { key: 'name', header: 'Razón social' },
    { key: 'cuit', header: 'CUIT', render: (r) => r.cuit ?? '—' },
    { key: 'city', header: 'Ciudad', render: (r) => r.city ?? '—' },
    { key: 'phone', header: 'Teléfono', render: (r) => r.phone ?? r.mobile ?? '—' },
  ]

  const fields: FieldConfig[] = [
    { name: 'code', label: 'Código', type: 'text' },
    { name: 'name', label: 'Razón social', type: 'text' },
    { name: 'cuit', label: 'CUIT', type: 'text', placeholder: '30-12345678-9' },
    { name: 'ingBrutos', label: 'Ingresos Brutos', type: 'text' },
    { name: 'address', label: 'Domicilio', type: 'text', full: true },
    { name: 'city', label: 'Ciudad', type: 'text' },
    { name: 'phone', label: 'Teléfono', type: 'text' },
    { name: 'mobile', label: 'Celular', type: 'text' },
  ]

  const defaultValues: Record<string, unknown> = editing
    ? {
        code: editing.code,
        name: editing.name,
        address: editing.address ?? '',
        city: editing.city ?? '',
        cuit: editing.cuit ?? '',
        ingBrutos: editing.ingBrutos ?? '',
        phone: editing.phone ?? '',
        mobile: editing.mobile ?? '',
      }
    : { code: '', name: '', address: '', city: '', cuit: '', ingBrutos: '', phone: '', mobile: '' }

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = {
      code: values.code,
      name: values.name,
      address: values.address || null,
      city: values.city || null,
      cuit: values.cuit || null,
      ingBrutos: values.ingBrutos || null,
      phone: values.phone || null,
      mobile: values.mobile || null,
    }
    if (editing) await m.update.mutateAsync({ id: editing.id, data: payload })
    else await m.create.mutateAsync(payload)
    toast.success(editing ? 'Proveedor actualizado' : 'Proveedor creado')
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Proveedores</h1>
      <EntityTable
        readOnly={!canWrite}
        columns={columns}
        data={suppliers.data}
        isLoading={suppliers.isLoading}
        searchFields={['code', 'name', 'cuit', 'city']}
        searchPlaceholder="Buscar por código, razón social o CUIT…"
        newLabel="Nuevo proveedor"
        emptyMessage="No hay proveedores cargados"
        onNew={() => {
          setEditing(null)
          setFormOpen(true)
        }}
        onEdit={(r) => {
          setEditing(r)
          setFormOpen(true)
        }}
        onDelete={async (r) => {
          await m.remove.mutateAsync(r.id)
        }}
        deleteTitle={(r) => r.name}
      />
      <EntityFormDialog
        readOnly={!canWrite}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar proveedor' : 'Nuevo proveedor'}
        fields={fields}
        schema={supplierSchema}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
