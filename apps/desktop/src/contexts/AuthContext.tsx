import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { api } from '@/lib/api'
import { UNAUTHENTICATED_EVENT, queryClient } from '@/lib/queryClient'
import { hasPermission, type PermissionAction } from '@/lib/permissions'
import type { UserDTO } from '@/types/api'

interface AuthContextValue {
  currentUser: UserDTO | null
  /** true mientras se intenta restaurar la sesión al arrancar */
  loading: boolean
  login: (username: string, password: string) => Promise<UserDTO>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const [currentUser, setCurrentUser] = useState<UserDTO | null>(null)
  const [loading, setLoading] = useState(true)

  // Restaurar sesión (el proceso main puede mantener una activa).
  useEffect(() => {
    let cancelled = false
    api.auth
      .getCurrentUser()
      .then((u) => {
        if (!cancelled) setCurrentUser(u)
      })
      .catch(() => {
        if (!cancelled) setCurrentUser(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Escuchar el evento global de "no autenticado" (lo dispara el queryClient).
  useEffect(() => {
    const onUnauth = () => {
      setCurrentUser(null)
      queryClient.clear()
      navigate('/login', { replace: true })
    }
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauth)
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauth)
  }, [navigate])

  const login = useCallback(async (username: string, password: string): Promise<UserDTO> => {
    const result = await api.auth.login(username, password)
    setCurrentUser(result.user)
    return result.user
  }, [])

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.auth.logout()
    } finally {
      setCurrentUser(null)
      queryClient.clear()
      navigate('/login', { replace: true })
    }
  }, [navigate])

  return <AuthContext.Provider value={{ currentUser, loading, login, logout }}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth debe usarse dentro de <AuthProvider>')
  return ctx
}

export function usePermission(action: PermissionAction): boolean {
  const { currentUser } = useAuth()
  return hasPermission(currentUser?.role, action)
}
