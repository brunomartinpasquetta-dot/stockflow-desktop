/**
 * Banner persistente de actualización. Dos estados, por prioridad:
 *
 * 1) AUTO-UPDATE LISTO (`updater:downloaded`): en Windows el auto-updater
 *    (electron-updater, `autoDownload=true`) descarga el `.exe` solo en segundo
 *    plano. Cuando termina, mostramos "Reiniciar e instalar" → `quitAndInstall`
 *    instala el `.exe` con 1 clic, sin navegador ni manejar archivos. Este es el
 *    camino feliz para la PC del cliente (Windows).
 *
 * 2) DESCARGA MANUAL (`updater:outdated`): fallback cuando el auto-update no
 *    puede aplicarse (macOS sin firma, o si el auto-update falla). Abre el asset
 *    correcto según el SO (Windows `.exe`, mac `.dmg`) — ver `electron/updater.ts
 *    → pickAssetForPlatform`. Descartable por sesión.
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Download, RefreshCw, X } from 'lucide-react'

import { api } from '@/lib/api'

interface OutdatedInfo {
  currentVersion: string
  latestVersion: string
  downloadUrl: string
}

const DISMISS_KEY = 'stockflow:outdated:dismissed-for-version'

export function OutdatedBanner() {
  const [info, setInfo] = useState<OutdatedInfo | null>(null)
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null)

  useEffect(() => {
    // El evento puede haber llegado ANTES de que este banner existiera (la
    // descarga arranca a los 5 s de abrir el programa) o perderse si se recarga
    // la ventana: sin esto el aviso no aparecía hasta el chequeo siguiente, 4
    // horas después. Por eso además se PREGUNTA si ya hay algo descargado.
    void api.updater
      .getPending()
      .then((p) => {
        if (p) setDownloadedVersion(p.version)
      })
      .catch(() => {
        /* versión vieja del servidor: sigue andando por eventos */
      })
    // Auto-update real: en Windows baja el .exe solo y dispara este evento.
    const offDownloaded = api.updater.onDownloaded((next) => setDownloadedVersion(next.version))
    // Fallback manual (mac sin firma / si el auto-update falla).
    const offOutdated = api.updater.onOutdated((next) => {
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
    return () => {
      offDownloaded()
      offOutdated()
    }
  }, [])

  // Prioridad: si el auto-update ya descargó el instalador, ofrecemos instalar.
  if (downloadedVersion) {
    return (
      <div
        data-chrome="update-ready-banner"
        className="flex shrink-0 items-center gap-3 border-b border-emerald-500/30 bg-emerald-500/15 px-4 py-1.5 text-xs text-emerald-900 dark:text-emerald-200"
      >
        <RefreshCw className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          Se descargó la actualización (<span className="font-mono">v{downloadedVersion}</span>). Está
          lista para instalarse.
        </span>
        <button
          type="button"
          onClick={() => void api.updater.quitAndInstall()}
          className="inline-flex items-center gap-1 rounded-md border border-emerald-700/40 bg-emerald-500/20 px-2 py-0.5 font-medium hover:bg-emerald-500/30"
        >
          <RefreshCw className="h-3 w-3" /> Reiniciar e instalar
        </button>
      </div>
    )
  }

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
        ). Esta PC sigue en <span className="font-mono">v{info.currentVersion}</span>. Bajá el
        instalador de tu sistema.
      </span>
      <button
        type="button"
        onClick={download}
        className="inline-flex items-center gap-1 rounded-md border border-amber-700/40 bg-amber-500/20 px-2 py-0.5 font-medium hover:bg-amber-500/30"
      >
        <Download className="h-3 w-3" /> Bajar instalador
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
