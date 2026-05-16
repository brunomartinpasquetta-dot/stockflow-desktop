/**
 * Servicio de impresión multiplataforma — patrón canónico window.print()
 * + CSS @media print. Compatible con cualquier impresora del SO (térmica
 * 58/80mm, A4, red, WiFi). Sin drivers especiales del navegador ni Zadig.
 *
 * Flujo:
 *   1) Monta el ReactElement en `#print-area`
 *   2) body.classList.add('printing') + classe de ancho (printing-58|80|a4)
 *   3) 2 requestAnimationFrame → window.print()
 *   4) afterprint → unmount + remove classes
 *
 * Si `afterprint` no se dispara (algunos drivers/SO), un timeout de 10s
 * limpia igual para no dejar la UI bloqueada.
 *
 * Portado de SINATRA (apps/web/src/lib/printService.jsx) — probado en prod
 * en Mac+Windows con impresoras térmicas, A4 y de red.
 */
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export type PrintWidth = '58' | '80' | 'a4'

let activeRoot: Root | null = null
let cleanupTimer: number | null = null

function getPrintArea(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  let area = document.getElementById('print-area')
  if (!area) {
    area = document.createElement('div')
    area.id = 'print-area'
    area.setAttribute('aria-hidden', 'true')
    document.body.appendChild(area)
  }
  return area
}

function cleanup(): void {
  if (cleanupTimer !== null) {
    window.clearTimeout(cleanupTimer)
    cleanupTimer = null
  }
  if (activeRoot) {
    try {
      activeRoot.unmount()
    } catch {
      /* noop */
    }
    activeRoot = null
  }
  if (typeof document !== 'undefined') {
    document.body.classList.remove('printing')
    document.body.classList.remove('printing-58')
    document.body.classList.remove('printing-80')
    document.body.classList.remove('printing-a4')
  }
}

/**
 * Monta `node` en `#print-area`, abre el diálogo de impresión del SO y
 * limpia al terminar. Resuelve cuando se cerró el diálogo (o cuando vence
 * el fallback de 10s).
 */
export function printNode(node: ReactElement, width: PrintWidth = '58'): Promise<void> {
  const area = getPrintArea()
  if (!area) return Promise.reject(new Error('No se pudo encontrar el área de impresión'))

  cleanup()

  return new Promise<void>((resolve, reject) => {
    try {
      const root = createRoot(area)
      activeRoot = root
      root.render(node)

      document.body.classList.add('printing')
      const widthClass =
        width === '80' ? 'printing-80' : width === 'a4' ? 'printing-a4' : 'printing-58'
      document.body.classList.add(widthClass)

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const finish = (): void => {
            window.setTimeout(() => {
              cleanup()
              resolve()
            }, 0)
          }

          const onAfter = (): void => {
            window.removeEventListener('afterprint', onAfter)
            finish()
          }
          window.addEventListener('afterprint', onAfter, { once: true })

          cleanupTimer = window.setTimeout(() => {
            window.removeEventListener('afterprint', onAfter)
            finish()
          }, 10_000)

          try {
            window.print()
          } catch (err) {
            cleanup()
            reject(err)
          }
        })
      })
    } catch (err) {
      cleanup()
      reject(err)
    }
  })
}

/**
 * Mapea el `paperFormat` persistido en la config de impresora al ancho
 * lógico que entiende `printNode`. Por defecto 58mm.
 */
export function widthFromPaperFormat(fmt: '58mm' | '80mm' | 'A4' | undefined | null): PrintWidth {
  if (fmt === '80mm') return '80'
  if (fmt === 'A4') return 'a4'
  return '58'
}
