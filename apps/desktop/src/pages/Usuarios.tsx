import { useMemo, useState } from 'react'
import { z } from 'zod'
import { toast } from 'sonner'

import { useUserMutations, useUsers } from '@/lib/hooks'
import { ROLE_LABELS } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import { useCanWrite } from '@/contexts/LicenseContext'
import { Badge } from '@/components/ui/badge'
import type { UserDTO } from '@/types/api'

const ROLE_OPTIONS = [
  { value: 'admin', label: ROLE_LABELS.admin },
  { value: 'manager', label: ROLE_LABELS.manager },
  { value: 'seller', label: ROLE_LABELS.seller },
]

const baseFields = {
  username: z.string().min(1, 'El usuario es obligatorio').max(50),
  fullName: z.string().min(1, 'El nombre completo es obligatorio'),
  role: z.enum(['admin', 'manager', 'seller']),
  active: z.boolean(),
}
const createUserSchema = z.object({ ...baseFields, password: z.string().min(4, 'Mínimo 4 caracteres') })
const editUserSchema = z.object({
  ...baseFields,
  password: z.string().refine((v) => v === '' || v.length >= 4, { message: 'Mínimo 4 caracteres (o dejá vacío para no cambiarla)' }),
})

export function Usuarios() {
  const canWrite = useCanWrite()
  const users = useUsers()
  const m = useUserMutations()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<UserDTO | null>(null)

  const adminCount = useMemo(() => (users.data ?? []).filter((u) => u.role === 'admin').length, [users.data])
  const isLastAdmin = (u: UserDTO): boolean => u.role === 'admin' && adminCount <= 1

  async function toggleActive(u: UserDTO): Promise<void> {
    if (u.active && isLastAdmin(u)) {
      toast.error('No se puede desactivar al único administrador')
      return
    }
    try {
      await m.update.mutateAsync({ id: u.id, data: { active: !u.active } })
      toast.success(u.active ? 'Usuario desactivado' : 'Usuario activado')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo actualizar')
    }
  }

  const columns: Column<UserDTO>[] = [
    { key: 'username', header: 'Usuario' },
    { key: 'fullName', header: 'Nombre completo' },
    {
      key: 'role',
      header: 'Rol',
      render: (r) => (
        <Badge variant={r.role === 'admin' ? 'primary' : r.role === 'manager' ? 'default' : 'outline'}>
          {ROLE_LABELS[r.role]}
        </Badge>
      ),
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
    { name: 'username', label: 'Usuario', type: 'text' },
    {
      name: 'password',
      label: editing ? 'Nueva contraseña' : 'Contraseña',
      type: 'password',
      helpText: editing ? 'Dejar vacío para no cambiarla' : 'Mínimo 4 caracteres',
    },
    { name: 'fullName', label: 'Nombre completo', type: 'text', full: true },
    { name: 'role', label: 'Rol', type: 'select', options: ROLE_OPTIONS },
    { name: 'active', label: 'Usuario activo', type: 'checkbox' },
  ]

  const defaultValues: Record<string, unknown> = editing
    ? { username: editing.username, password: '', fullName: editing.fullName, role: editing.role, active: editing.active }
    : { username: '', password: '', fullName: '', role: 'seller', active: true }

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    const password = typeof values.password === 'string' ? values.password.trim() : ''
    if (editing) {
      const payload: Record<string, unknown> = {
        username: values.username,
        fullName: values.fullName,
        role: values.role,
        active: values.active,
      }
      if (password) payload.password = password
      await m.update.mutateAsync({ id: editing.id, data: payload })
    } else {
      await m.create.mutateAsync({
        username: values.username,
        password,
        fullName: values.fullName,
        role: values.role,
        active: values.active,
      })
    }
    toast.success(editing ? 'Usuario actualizado' : 'Usuario creado')
  }

  async function handleDelete(u: UserDTO): Promise<void> {
    if (isLastAdmin(u)) throw new Error('No se puede borrar al único administrador del sistema')
    await m.remove.mutateAsync(u.id)
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Usuarios</h1>
      <EntityTable
        readOnly={!canWrite}
        columns={columns}
        data={users.data}
        isLoading={users.isLoading}
        searchFields={['username', 'fullName']}
        searchPlaceholder="Buscar por usuario o nombre…"
        newLabel="Nuevo usuario"
        emptyMessage="No hay usuarios cargados"
        canDelete={(u) => !isLastAdmin(u)}
        onNew={() => {
          setEditing(null)
          setFormOpen(true)
        }}
        onEdit={(r) => {
          setEditing(r)
          setFormOpen(true)
        }}
        onDelete={handleDelete}
        deleteTitle={(u) => u.username}
      />
      <EntityFormDialog
        readOnly={!canWrite}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar usuario' : 'Nuevo usuario'}
        fields={fields}
        schema={editing ? editUserSchema : createUserSchema}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
