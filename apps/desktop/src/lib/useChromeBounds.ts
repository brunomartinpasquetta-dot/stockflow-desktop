/**
 * Hook que mide la altura real de la chrome de la app (MenuBar + Toolbar +
 * StatusBar arriba; Taskbar abajo) para que los clamps del MDI sean correctos
 * incluso si en el futuro cambian los `h-*` o aparece el banner de readOnly.
 *
 * Se basa en atributos `data-chrome="menubar|toolbar|statusbar|taskbar"`
 * presentes en los componentes correspondientes. Si alguno no está en el DOM
 * (porque está oculto en SSR/tests) usa un default sensato.
 *
 * Importante: `top` SOLO se usa para layout absoluto contra el viewport (modo
 * `maximized`). Los clamps de drag/resize ya trabajan en coords del Desktop,
 * que arranca a `top`, por lo que dentro de Desktop el origen es `0`.
 */
import { useEffect, useState } from 'react'

export interface ChromeBounds {
  /** Altura combinada arriba (banner + menubar + toolbar + statusbar). */
  top: number
  /** Altura abajo (taskbar). */
  bottom: number
}

const DEFAULT_BOUNDS: ChromeBounds = { top: 156, bottom: 40 }

function measure(): ChromeBounds {
  if (typeof document === 'undefined') return DEFAULT_BOUNDS
  const banner = (document.querySelector('[data-chrome="readonly-banner"]') as HTMLElement | null)?.offsetHeight ?? 0
  const menu = (document.querySelector('[data-chrome="menubar"]') as HTMLElement | null)?.offsetHeight ?? 36
  const toolbar = (document.querySelector('[data-chrome="toolbar"]') as HTMLElement | null)?.offsetHeight ?? 80
  const status = (document.querySelector('[data-chrome="statusbar"]') as HTMLElement | null)?.offsetHeight ?? 40
  const taskbar = (document.querySelector('[data-chrome="taskbar"]') as HTMLElement | null)?.offsetHeight ?? 40
  return { top: banner + menu + toolbar + status, bottom: taskbar }
}

export function useChromeBounds(): ChromeBounds {
  const [bounds, setBounds] = useState<ChromeBounds>(DEFAULT_BOUNDS)
  useEffect(() => {
    const update = () => setBounds(measure())
    update()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update)
      document.querySelectorAll('[data-chrome]').forEach((el) => ro!.observe(el))
    }
    window.addEventListener('resize', update)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])
  return bounds
}
