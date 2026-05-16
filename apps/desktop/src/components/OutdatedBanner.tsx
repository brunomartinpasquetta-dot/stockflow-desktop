/**
 * Banner persistente que avisa al usuario cuando la versión instalada quedó
 * atrás respecto al último Release publicado en GitHub. En macOS sin firma,
 * el auto-update via Squirrel.Mac no puede reemplazar el `.app` y falla
 * silencioso — este banner es el camino manual para que el usuario actualice.
 *
 * Escucha el evento `updater:outdated` emitido por el main process (ver
 * `electron/updater.ts → checkForOutdatedVersion`). Permite descartar por
 * sesión (sessionStorage) para no molestar la misma sesión.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Download, X } from 'lucide-react'

import { api } from '@/lib/api'

interface OutdatedInfo {
  currentVersion: string
  latestVersion: string
  downloadUrl: string
}

const DISMISS_KEY = 'stockflow:outdated:dismissed-for-version'

export function OutdatedBanner() {
  const [info, setInfo] = useState<OutdatedInfo | null>(null)

  useEffect(() => {
    const off = api.updater.onOutdated((next) => {
      // Si el usuario descartó este mismo número de versión, no lo molestamos.
      const dismissed = (() => {
        try {
          return sessionStorage.getItem(DISMISS_KEY)
        } catch {
          return null
        }
      })()
      if (dismissed && dismissed === next.latestVersion) return
      setInfo(next)
    })
    return () => off()
  }, [])

  if (!info) return null

  function dismiss(): void {
    try {
      if (info) sessionStorage.setItem(DISMISS_KEY, info.latestVersion)
    } catch {
      /* noop */
    }
    setInfo(null)
  }

  function download(): void {
    if (!info?.downloadUrl) return
    void api.system.openExternal(info.downloadUrl).catch(() => {
      // Fallback: abrir con window.open si el bridge falla (no debería).
      window.open(info.downloadUrl, '_blank', 'noopener')
    })
  }

  return (
    <div
      data-chrome="outdated-banner"
      className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-900 dark:text-amber-200"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        Hay una versión más nueva disponible (<span className="font-mono">v{info.latestVersion}</span>
        ). Esta PC sigue en <span className="font-mono">v{info.currentVersion}</span>. El
        auto-update no pudo aplicarse (paquete sin firmar) — bajala manualmente.
      </span>
      <button
        type="button"
        onClick={download}
        className="inline-flex items-center gap-1 rounded-md border border-amber-700/40 bg-amber-500/20 px-2 py-0.5 font-medium hover:bg-amber-500/30"
      >
        <Download className="h-3 w-3" /> Bajar manualmente
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Descartar aviso"
        className="rounded-md p-1 hover:bg-amber-500/30"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
