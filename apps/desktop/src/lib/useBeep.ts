import { useCallback, useEffect, useRef } from 'react'

/**
 * Hook para reproducir un beep corto al aprobarse un cobro.
 * Carga `/sounds/beep.mp3` desde el bundle de Vite (apps/desktop/public/sounds/beep.mp3).
 * Si el archivo no existe o el navegador bloquea autoplay: fail silent.
 */
export function useBeep(): () => void {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    try {
      audioRef.current = new Audio('/sounds/beep.mp3')
    } catch {
      audioRef.current = null
    }
  }, [])
  return useCallback(() => {
    try {
      const a = audioRef.current
      if (!a) return
      a.currentTime = 0
      void a.play().catch(() => {})
    } catch {
      // ignore
    }
  }, [])
}
