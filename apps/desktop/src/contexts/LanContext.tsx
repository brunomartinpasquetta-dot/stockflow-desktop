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
  /** Estado de la licencia del SERVIDOR (sólo en modo cliente). */
  serverLicense?: string | null
  lastPingAt: number | null
  lastError: string | null
  /**
   * true mientras todavía no se leyó la config de red. Quien decide algo según
   * el modo (p. ej. LicenseGuard) tiene que esperar: con `mode` undefined una
   * terminal parece "1 PC" por un instante.
   */
  configCargando: boolean
}

const LanContext = createContext<LanContextValue | null>(null)

const PING_INTERVAL_MS = 30_000

/**
 * Base del servidor de una terminal: la dirección web si la tiene (terminal de
 * sucursal o navegador entrando por https://), si no `http://ip:puerto`.
 */
export function baseDelServidorDeConfig(cfg: LanConfigDTO | undefined): string | null {
  if (!cfg) return null
  if (cfg.serverUrl) return cfg.serverUrl.replace(/\/$/, '')
  if (!cfg.serverIp || !cfg.serverPort) return null
  return `http://${cfg.serverIp}:${cfg.serverPort}`
}

/** Para mostrar: `comercio.mistockflow.com` o `192.168.1.10:7777`. */
export function destinoDeConfig(cfg: LanConfigDTO | undefined): string {
  if (!cfg) return 'servidor'
  if (cfg.serverUrl) {
    try {
      return new URL(cfg.serverUrl).host
    } catch {
      return cfg.serverUrl
    }
  }
  return `${cfg.serverIp}:${cfg.serverPort}`
}

export function LanProvider({ children }: { children: ReactNode }) {
  const cfgQuery = useQuery<LanConfigDTO>({
    queryKey: ['lan', 'config'],
    queryFn: () => api.lan.getConfig(),
    staleTime: 5 * 60 * 1000,
    retry: 0,
  })

  const cfg = cfgQuery.data
  const isClient = cfg?.mode === 'client'
  const base = baseDelServidorDeConfig(cfg)

  const [online, setOnline] = useState<boolean>(true)
  const [serverLicense, setServerLicense] = useState<string | null>(null)
  const [lastPingAt, setLastPingAt] = useState<number | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)

  useEffect(() => {
    if (!isClient || !base) {
      return
    }
    let cancelled = false
    const doPing = async (): Promise<void> => {
      // Por internet (dirección web) el primer saludo tarda más que en la red.
      const r = await api.lan.pingServer(base, cfg?.serverUrl ? 8000 : 3000)
      if (cancelled) return
      setOnline(r.ok)
      setServerLicense(r.ok ? (r.license ?? 'active') : null)
      setLastPingAt(Date.now())
      setLastError(r.ok ? null : 'Sin conexión con el servidor')
    }
    void doPing()
    const t = setInterval(() => void doPing(), PING_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [isClient, base, cfg?.serverUrl])

  const value = useMemo<LanContextValue>(
    () => ({
      config: cfg,
      mode: cfg?.mode,
      online: isClient ? online : true,
      serverLicense,
      lastPingAt,
      lastError,
      configCargando: cfgQuery.isPending,
    }),
    [cfg, isClient, online, serverLicense, lastPingAt, lastError, cfgQuery.isPending],
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
