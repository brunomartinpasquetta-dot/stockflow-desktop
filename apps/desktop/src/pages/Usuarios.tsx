import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { api } from '@/lib/api'
import { useUserMutations, useUsers } from '@/lib/hooks'
import { ROLE_LABELS } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import { useCanWrite } from '@/contexts/LicenseContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ConfigurableRoleDTO, RolesConfigDTO, UserDTO } from '@/types/api'

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

/* ----------------------------- Tab Usuarios ----------------------------- */

function UsuariosTab() {
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
    <>
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
    </>
  )
}

/* ------------------------------- Tab Roles ------------------------------ */

const CONFIGURABLE_ROLES: ConfigurableRoleDTO[] = ['manager', 'seller']

function PermCheckbox({
  checked,
  disabled,
  onChange,
  'aria-label': ariaLabel,
}: {
  checked: boolean
  disabled?: boolean
  onChange?: (next: boolean) => void
  'aria-label': string
}) {
  return (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.checked)}
      className="h-4 w-4 cursor-pointer rounded border-input text-primary accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
    />
  )
}

type RolesDraft = Record<ConfigurableRoleDTO, Set<string>>

function buildDraft(config: RolesConfigDTO): RolesDraft {
  return {
    manager: new Set(config.roles.manager),
    seller: new Set(config.roles.seller),
  }
}

function sameSet(a: Set<string>, b: readonly string[]): boolean {
  if (a.size !== b.length) return false
  for (const k of b) if (!a.has(k)) return false
  return true
}

function RolesTab() {
  const queryClient = useQueryClient()
  const configQuery = useQuery({ queryKey: ['roles-config'], queryFn: api.roles.getConfig })

  // Estado editable derivado de la config del backend. Se reinicia (durante el
  // render, sin efecto) cada vez que cambia la identidad de la config cargada.
  const [draftState, setDraftState] = useState<{ source: RolesConfigDTO | null; draft: RolesDraft | null }>({
    source: null,
    draft: null,
  })
  if (configQuery.data && draftState.source !== configQuery.data) {
    setDraftState({ source: configQuery.data, draft: buildDraft(configQuery.data) })
  }
  const draft = draftState.draft
  const setDraft = (updater: (prev: RolesDraft | null) => RolesDraft | null): void =>
    setDraftState((prev) => ({ ...prev, draft: updater(prev.draft) }))

  const setConfig = useMutation({
    mutationFn: api.roles.setConfig,
    onSuccess: (data) => {
      queryClient.setQueryData(['roles-config'], data)
      void queryClient.invalidateQueries({ queryKey: ['roles-config'] })
    },
  })

  const config = configQuery.data

  const dirtyRoles = useMemo<ConfigurableRoleDTO[]>(() => {
    if (!config || !draft) return []
    return CONFIGURABLE_ROLES.filter((role) => !sameSet(draft[role], config.roles[role]))
  }, [config, draft])

  function toggle(role: ConfigurableRoleDTO, areaKey: string, next: boolean): void {
    setDraft((prev) => {
      if (!prev) return prev
      const updated = new Set(prev[role])
      if (next) updated.add(areaKey)
      else updated.delete(areaKey)
      return { ...prev, [role]: updated }
    })
  }

  async function handleSave(): Promise<void> {
    if (!draft || dirtyRoles.length === 0) return
    try {
      for (const role of dirtyRoles) {
        await setConfig.mutateAsync({ role, areas: [...draft[role]] })
      }
      toast.success('Permisos de roles actualizados')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudieron guardar los cambios')
    }
  }

  if (configQuery.isLoading || !config || !draft) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando configuración de roles…
        </CardContent>
      </Card>
    )
  }

  if (configQuery.isError) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">No se pudo cargar la configuración de roles.</CardContent>
      </Card>
    )
  }

  const saving = setConfig.isPending

  return (
    <Card>
      <CardHeader>
        <CardTitle>Permisos por rol</CardTitle>
        <p className="text-sm text-muted-foreground">
          Habilitá o deshabilitá el acceso de cada rol a las distintas áreas del sistema. El administrador siempre tiene
          acceso total.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Área</TableHead>
                <TableHead className="text-center">{ROLE_LABELS.admin}</TableHead>
                <TableHead className="text-center">{ROLE_LABELS.manager}</TableHead>
                <TableHead className="text-center">{ROLE_LABELS.seller}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {config.areas.map((area) => (
                <TableRow key={area.key}>
                  <TableCell className="font-medium">{area.label}</TableCell>
                  <TableCell className="text-center">
                    <div className="flex flex-col items-center gap-0.5">
                      <PermCheckbox checked disabled aria-label={`${area.label} — ${ROLE_LABELS.admin}`} />
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Acceso total</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <PermCheckbox
                      checked={draft.manager.has(area.key)}
                      disabled={saving}
                      onChange={(next) => toggle('manager', area.key, next)}
                      aria-label={`${area.label} — ${ROLE_LABELS.manager}`}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <PermCheckbox
                      checked={draft.seller.has(area.key)}
                      disabled={saving}
                      onChange={(next) => toggle('seller', area.key, next)}
                      aria-label={`${area.label} — ${ROLE_LABELS.seller}`}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <p className="text-xs text-muted-foreground">
          Los cambios se aplican a cada usuario en su próximo inicio de sesión.
        </p>

        <div className="flex items-center gap-3">
          <Button onClick={() => void handleSave()} disabled={saving || dirtyRoles.length === 0}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Guardar cambios
          </Button>
          {dirtyRoles.length > 0 && !saving ? (
            <span className="text-xs text-muted-foreground">Hay cambios sin guardar.</span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

/* -------------------------------- Página -------------------------------- */

export function Usuarios() {
  const [tab, setTab] = useState<'usuarios' | 'roles'>('usuarios')

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Usuarios</h1>
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'usuarios' | 'roles')} className="flex flex-col gap-3">
        <TabsList>
          <TabsTrigger value="usuarios">Usuarios</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
        </TabsList>
        <TabsContent value="usuarios" className="flex flex-col gap-3">
          <UsuariosTab />
        </TabsContent>
        <TabsContent value="roles">
          <RolesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
