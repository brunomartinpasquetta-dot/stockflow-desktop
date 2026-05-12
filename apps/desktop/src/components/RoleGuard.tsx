import { Navigate, Outlet } from 'react-router-dom'

import { useAuth } from '@/contexts/AuthContext'
import type { Role } from '@/types/api'

export function RoleGuard({ roles }: { roles: Role[] }) {
  const { currentUser } = useAuth()
  if (!currentUser || !roles.includes(currentUser.role)) return <Navigate to="/" replace />
  return <Outlet />
}
