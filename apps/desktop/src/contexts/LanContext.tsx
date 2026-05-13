/**
 * LanContext — modo LAN actual + ping periódico al servidor cuando somos cliente.
 *
 * Expone:
 *  - `useLanMode()`: 'single' | 'server' | 'client' | undefined (mientras carga).
 *  - `useLanOnline()`: true si NO somos cliente, o si último ping fue ok.
 *  - `useLanConfig()`: la config completa (incluye serverIp/port para mostrarla).
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type { LanConfigDTO, LanModeDTO } from '@/types/api'

interface LanContextValue {
  config: LanConfigDTO | undefined
  mode: LanModeDTO | undefined
  online: boolean
  lastPingAt: number | null
  lastError: string | null
}

const LanContext = createContext<LanContextValue | null>(null)

const PING_INTERVAL_MS = 30_000

export function LanProvider({ children }: { children: ReactNode }) {
  const cfgQuery = useQuery<LanConfigDTO>({
    queryKey: ['lan', 'config'],
    queryFn: () => api.lan.getConfig(),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  })

  const cfg = cfgQuery.data
  const isClient = cfg?.mode === 'client'

  const [online, setOnline] = useState<boolean>(true)
  const [lastPingAt, setLastPingAt] = useState<number | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    if (!isClient || !cfg?.serverIp || !cfg?.serverPort) {
      return
    }
    let cancelled = false
    const doPing = async (): Promise<void> => {
      const r = await api.lan.pingServer(cfg.serverIp!, cfg.serverPort!)
      if (cancelled) return
      setOnline(r.ok)
      setLastPingAt(Date.now())
      setLastError(r.ok ? null : 'Sin conexión con el servidor')
    }
    void doPing()
    const t = setInterval(() => void doPing(), PING_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [isClient, cfg?.serverIp, cfg?.serverPort])

  const value = useMemo<LanContextValue>(
    () => ({
      config: cfg,
      mode: cfg?.mode,
      online: isClient ? online : true,
      lastPingAt,
      lastError,
    }),
    [cfg, isClient, online, lastPingAt, lastError],
  )

  return <LanContext.Provider value={value}>{children}</LanContext.Provider>
}

export function useLanContext(): LanContextValue {
  const ctx = useContext(LanContext)
  if (!ctx) throw new Error('useLanContext debe usarse dentro de <LanProvider>')
  return ctx
}

export function useLanMode(): LanModeDTO | undefined {
  return useLanContext().mode
}

export function useLanOnline(): boolean {
  return useLanContext().online
}

export function useLanConfig(): LanConfigDTO | undefined {
  return useLanContext().config
}
