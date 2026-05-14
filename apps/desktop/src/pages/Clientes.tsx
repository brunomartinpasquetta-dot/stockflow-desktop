import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { z } from 'zod'
import { toast } from 'sonner'

import { useCustomerBalances, useCustomerMutations, useCustomers } from '@/lib/hooks'
import { validateCUIT } from '@/lib/cuit'
import { formatCurrency } from '@/lib/format'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import { useCanWrite } from '@/contexts/LicenseContext'
import { Badge } from '@/components/ui/badge'
import type { CustomerDTO } from '@/types/api'

const DOC_OPTIONS = [
  { value: 'DNI', label: 'DNI' },
  { value: 'CUIT', label: 'CUIT' },
  { value: 'CUIL', label: 'CUIL' },
  { value: 'CF', label: 'Consumidor Final' },
]
const CATEGORY_OPTIONS = [
  { value: 'RI', label: 'Responsable Inscripto' },
  { value: 'MT', label: 'Monotributo' },
  { value: 'CF', label: 'Consumidor Final' },
  { value: 'EX', label: 'Exento' },
]
const PRICE_LIST_OPTIONS = [
  { value: '1', label: 'Lista 1' },
  { value: '2', label: 'Lista 2' },
  { value: '3', label: 'Lista 3' },
]
const CATEGORY_LABEL: Record<string, string> = {
  RI: 'Resp. Inscripto',
  MT: 'Monotributo',
  CF: 'Consumidor Final',
  EX: 'Exento',
}

const CONSUMIDOR_FINAL = 'CONSUMIDOR FINAL'

const customerSchema = z
  .object({
    lastName: z.string().min(1, 'El apellido / razón social es obligatorio'),
    firstName: z.string(),
    address: z.string(),
    city: z.string(),
    phone: z.string(),
    mobile: z.string(),
    docType: z.enum(['DNI', 'CUIT', 'CUIL', 'CF']),
    docNumber: z.string(),
    category: z.enum(['RI', 'MT', 'CF', 'EX']),
    priceList: z.enum(['1', '2', '3']),
    creditLimit: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.docType === 'CUIT' || data.docType === 'CUIL') {
      if (!data.docNumber || !validateCUIT(data.docNumber)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['docNumber'], message: 'CUIT/CUIL inválido (revisá el dígito verificador)' })
      }
    } else if (data.docType === 'DNI') {
      if (data.docNumber && !/^\d{7,8}$/.test(data.docNumber)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['docNumber'], message: 'El DNI debe tener 7 u 8 dígitos' })
      }
    }
  })

export function Clientes() {
  const canWrite = useCanWrite()
  const customers = useCustomers()
  const balances = useCustomerBalances()
  const m = useCustomerMutations()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CustomerDTO | null>(null)

  // Deep-link: `?customerId=<id>` abre el dialog de edición.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id = searchParams.get('customerId')
    if (!id) return
    const target = (customers.data ?? []).find((c) => c.id === id)
    if (target) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditing(target)
      setFormOpen(true)
      const next = new URLSearchParams(searchParams)
      next.delete('customerId')
      setSearchParams(next, { replace: true })
    }
  }, [customers.data, searchParams, setSearchParams])

  const debtById = useMemo(() => {
    const map = new Map<string, string>()
    for (const b of balances.data ?? []) map.set(b.customerId, b.totalDebt)
    return map
  }, [balances.data])

  const columns: Column<CustomerDTO>[] = [
    { key: 'lastName', header: 'Apellido / Razón social' },
    { key: 'firstName', header: 'Nombre', render: (r) => r.firstName ?? '—' },
    { key: 'doc', header: 'Documento', render: (r) => (r.docNumber ? `${r.docType ?? ''} ${r.docNumber}`.trim() : '—') },
    { key: 'phone', header: 'Teléfono', render: (r) => r.phone ?? r.mobile ?? '—' },
    {
      key: 'category',
      header: 'Categoría',
      render: (r) => <Badge variant="outline">{CATEGORY_LABEL[r.category] ?? r.category}</Badge>,
    },
    {
      key: 'saldo',
      header: 'Saldo',
      align: 'right',
      sortValue: (r) => Number(debtById.get(r.id) ?? 0),
      render: (r) => {
        const debt = Number(debtById.get(r.id) ?? 0)
        if (debt <= 0) return <span className="text-muted-foreground">—</span>
        const limit = Number(r.creditLimit)
        const variant = limit > 0 && debt > limit ? 'destructive' : 'warning'
        return <Badge variant={variant}>{formatCurrency(debt)}</Badge>
      },
    },
  ]

  const fields: FieldConfig[] = [
    { name: 'lastName', label: 'Apellido / Razón social', type: 'text' },
    { name: 'firstName', label: 'Nombre', type: 'text' },
    { name: 'docType', label: 'Tipo de documento', type: 'select', options: DOC_OPTIONS },
    { name: 'docNumber', label: 'Número de documento', type: 'text' },
    { name: 'category', label: 'Categoría fiscal', type: 'select', options: CATEGORY_OPTIONS },
    { name: 'priceList', label: 'Lista de precios', type: 'select', options: PRICE_LIST_OPTIONS },
    { name: 'address', label: 'Domicilio', type: 'text', full: true },
    { name: 'city', label: 'Localidad', type: 'text' },
    { name: 'phone', label: 'Teléfono', type: 'text' },
    { name: 'mobile', label: 'Celular', type: 'text' },
    { name: 'creditLimit', label: 'Límite de crédito', type: 'currency', helpText: '0 = sin límite', placeholder: '0,00' },
  ]

  const defaultValues: Record<string, unknown> = editing
    ? {
        lastName: editing.lastName,
        firstName: editing.firstName ?? '',
        address: editing.address ?? '',
        city: editing.city ?? '',
        phone: editing.phone ?? '',
        mobile: editing.mobile ?? '',
        docType: editing.docType ?? 'CF',
        docNumber: editing.docNumber ?? '',
        category: editing.category,
        priceList: String(editing.priceList),
        creditLimit: editing.creditLimit,
      }
    : {
        lastName: '',
        firstName: '',
        address: '',
        city: '',
        phone: '',
        mobile: '',
        docType: 'CF',
        docNumber: '',
        category: 'CF',
        priceList: '1',
        creditLimit: '0',
      }

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = {
      lastName: values.lastName,
      firstName: values.firstName || null,
      address: values.address || null,
      city: values.city || null,
      phone: values.phone || null,
      mobile: values.mobile || null,
      docType: values.docType,
      docNumber: values.docNumber || null,
      category: values.category,
      priceList: Number(values.priceList),
      creditLimit: values.creditLimit,
    }
    if (editing) await m.update.mutateAsync({ id: editing.id, data: payload })
    else await m.create.mutateAsync(payload)
    toast.success(editing ? 'Cliente actualizado' : 'Cliente creado')
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Clientes</h1>
      <EntityTable
        readOnly={!canWrite}
        columns={columns}
        data={customers.data}
        isLoading={customers.isLoading}
        searchFields={['lastName', 'firstName', 'docNumber']}
        searchPlaceholder="Buscar por apellido, nombre o documento…"
        newLabel="Nuevo cliente"
        emptyMessage="No hay clientes cargados"
        canDelete={(r) => r.lastName.toUpperCase() !== CONSUMIDOR_FINAL}
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
        deleteTitle={(r) => `${r.lastName}${r.firstName ? `, ${r.firstName}` : ''}`}
      />
      <EntityFormDialog
        readOnly={!canWrite}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar cliente' : 'Nuevo cliente'}
        fields={fields}
        schema={customerSchema}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
