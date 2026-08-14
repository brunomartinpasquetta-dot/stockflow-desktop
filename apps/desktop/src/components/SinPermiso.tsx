/**
 * PANTALLA DE "NO TENÉS PERMISO".
 *
 * Antes, una pantalla sin permiso hacía `<Navigate to="/">` y listo: el usuario
 * hacía clic, volvía al inicio y no pasaba nada. Desde afuera eso no se lee
 * como "no tenés permiso", se lee como **el sistema está roto**. Le pasó a Leo
 * Citzia con Contabilidad y antes con Hardware, y en los dos casos se fue a
 * buscar el problema al lugar equivocado.
 *
 * Acá se dice las tres cosas que hacen falta para resolverlo solo: con qué
 * usuario está entrando, qué rol tiene ese usuario, y quién puede cambiarlo.
 */
import { ShieldAlert } from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { ROLE_LABELS } from '@/lib/permissions'
import { Card, CardContent } from '@/components/ui/card'

export function SinPermiso({ area }: { area: string }) {
  const { currentUser } = useAuth()
  const rol = currentUser ? (ROLE_LABELS[currentUser.role] ?? currentUser.role) : null

  return (
    <div className="flex flex-col gap-3 p-4">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            <h1 className="text-lg font-semibold">{area} no está habilitado para tu usuario</h1>
          </div>

          {currentUser && (
            <p className="text-sm">
              Estás entrando como <strong>{currentUser.fullName || currentUser.username}</strong>,
              con rol <strong>{rol}</strong>. Ese rol no tiene acceso a {area}.
            </p>
          )}

          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <strong>Cómo se soluciona:</strong> un usuario Administrador entra a{' '}
            <strong>Configuración → Usuarios</strong>, abre esta cuenta y le cambia el rol; o en{' '}
            <strong>Configuración → Roles</strong> habilita el área para el rol actual.
            <br />
            <span className="text-muted-foreground">
              Si migraste desde otro sistema, revisá los roles: los usuarios que no se pudieron
              reconocer quedaron como Vendedor.
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
