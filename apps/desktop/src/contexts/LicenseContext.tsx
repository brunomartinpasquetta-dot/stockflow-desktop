import { createContext, useContext, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
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

/** true sólo cuando la licencia está activa (al día). En 'readOnly' devuelve false. */
export function useCanWrite(): boolean {
  const { state } = useLicense()
  return state?.status === 'active'
}

export type LicenseStatusValue = 'unlicensed' | 'active' | 'readOnly' | 'revoked' | 'loading'

export function useLicenseStatus(): LicenseStatusValue {
  const { state, isLoading } = useLicense()
  if (isLoading || !state) return 'loading'
  return state.status
}
