/**
 * Servicio de impresión multiplataforma — patrón canónico window.print()
 * + CSS @media print. Compatible con cualquier impresora del SO (térmica
 * 58/80mm, A4, red, WiFi). Sin drivers especiales del navegador ni Zadig.
 *
 * Modo normal:
 *   1) Monta el ReactElement en `#print-area`
 *   2) body.classList.add('printing') + classe de ancho (printing-58|80|a4)
 *   3) 2 requestAnimationFrame → window.print()
 *   4) afterprint → unmount + remove classes
 *
 * Modo silencioso (Feature v0.1.13, sólo 58/80mm):
 *   - Renderiza el nodo a HTML con react-dom/server
 *   - Construye un documento completo con el CSS inlineado (subset de index.css)
 *   - Lo manda al main process vía `api.print.silent` → BrowserWindow oculto
 *     + `webContents.print({ silent:true, deviceName })`.
 *
 * Si el modo silencioso falla por cualquier motivo, hacemos fallback al modo
 * normal (window.print con dialog) para que el ticket siempre salga.
 */
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export type PrintWidth = '58' | '80' | 'a4'

export interface PrintOptions {
  width?: PrintWidth
  /** Si está activo + `deviceName` válido, intenta imprimir sin dialog del SO. */
  silent?: boolean
  /** Nombre exacto de la impresora del SO (CUPS / spooler). */
  deviceName?: string
}

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

function normalizeOpts(arg: PrintWidth | PrintOptions | undefined): Required<Pick<PrintOptions, 'width'>> & PrintOptions {
  if (arg == null) return { width: '58' }
  if (typeof arg === 'string') return { width: arg }
  return { width: arg.width ?? '58', silent: arg.silent, deviceName: arg.deviceName }
}

/**
 * Monta `node` en `#print-area`, abre el diálogo de impresión del SO (o lo
 * salta si `silent + deviceName`) y limpia al terminar. Resuelve cuando se
 * cerró el diálogo (o cuando vence el fallback de 10s).
 *
 * Por compatibilidad, el segundo parámetro acepta el string `PrintWidth` o
 * un objeto `PrintOptions`.
 */
export async function printNode(
  node: ReactElement,
  optsOrWidth: PrintWidth | PrintOptions = '58',
): Promise<void> {
  const opts = normalizeOpts(optsOrWidth)
  const { width, deviceName } = opts

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
          // Tickets térmicos (58/80): imprimir la VENTANA ACTUAL en silencio,
          // sin diálogo de vista previa. Misma estructura que window.print()
          // (el ticket ya está montado en #print-area con las clases @media
          // print activas) — sólo que sin el diálogo del SO.
          // A4 / fallback: window.print() con diálogo.
          const printViaDialog = (): void => {
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
          }

          if (width === '58' || width === '80') {
            const widthMm = width === '80' ? 80 : 58
            void (async () => {
              try {
                const { api } = await import('@/lib/api')
                await api.print.current({ deviceName, widthMm })
                cleanup()
                resolve()
              } catch (err) {
                // Si la impresión silenciosa falla, caemos al diálogo del SO
                // para que el ticket igual salga.
                console.warn('[printService] print:current falló, fallback a diálogo:', err)
                printViaDialog()
              }
            })()
          } else {
            printViaDialog()
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
