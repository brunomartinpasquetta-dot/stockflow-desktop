import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { useLanContext } from '@/contexts/LanContext'
import type { LicenseStateDTO } from '@/types/api'

interface LicenseContextValue {
  state: LicenseStateDTO | undefined
  isLoading: boolean
  refresh: () => void
}

const LicenseContext = createContext<LicenseContextValue | null>(null)

export function LicenseProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ['license'],
    queryFn: api.license.getState,
    staleTime: 60_000,
    retry: 0,
  })

  const value: LicenseContextValue = {
    state: query.data,
    isLoading: query.isLoading,
    refresh: () => void query.refetch(),
  }

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>
}

export function useLicense(): LicenseContextValue {
  const ctx = useContext(LicenseContext)
  if (!ctx) throw new Error('useLicense debe usarse dentro de <LicenseProvider>')
  return ctx
}

/**
 * true sólo cuando la licencia está activa Y, en modo cliente LAN, la conexión
 * con el servidor está online. En 'readOnly' o sin conexión devuelve false.
 */
export function useCanWrite(): boolean {
  const { state } = useLicense()
  const { mode, online } = useLanContext()
  if (state?.status !== 'active') return false
  if (mode === 'client' && !online) return false
  return true
}

export type LicenseStatusValue = 'unlicensed' | 'active' | 'readOnly' | 'revoked' | 'loading'

export function useLicenseStatus(): LicenseStatusValue {
  const { state, isLoading } = useLicense()
  if (isLoading || !state) return 'loading'
  return state.status
}
