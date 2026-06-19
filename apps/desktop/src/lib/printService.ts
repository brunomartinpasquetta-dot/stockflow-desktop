/**
 * Servicio de impresión por DIÁLOGO del SO — patrón `window.print()` + CSS
 * `@media print` sobre `#print-area`. Es el FALLBACK universal (cualquier
 * impresora del SO: térmica, A4, red) y el camino para A4.
 *
 * La impresión SILENCIOSA de tickets térmicos NO pasa por acá: va por ESC/POS
 * crudo al spooler (`api.hardware.printer.printSaleTicket` → PrinterService).
 * El motor de impresión de Electron (`webContents.print` silent) daba hoja en
 * blanco en térmicas, por eso se descartó (ver cerebro [[thermal-print]]).
 *
 * Flujo:
 *   1) Monta el ReactElement en `#print-area`
 *   2) body.classList.add('printing') + clase de ancho (printing-58|80|a4)
 *   3) 2 requestAnimationFrame → window.print()
 *   4) afterprint (o fallback 10s) → unmount + remove classes
 */
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

export type PrintWidth = '58' | '80' | 'a4'

export interface PrintOptions {
  width?: PrintWidth
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

function normalizeWidth(arg: PrintWidth | PrintOptions | undefined): PrintWidth {
  if (arg == null) return '58'
  if (typeof arg === 'string') return arg
  return arg.width ?? '58'
}

/**
 * Monta `node` en `#print-area`, abre el diálogo de impresión del SO y limpia al
 * terminar. Resuelve cuando se cerró el diálogo (o cuando vence el fallback de 10s).
 *
 * Por compatibilidad, el segundo parámetro acepta el string `PrintWidth` o un
 * objeto `PrintOptions`.
 */
export async function printNode(
  node: ReactElement,
  optsOrWidth: PrintWidth | PrintOptions = '58',
): Promise<void> {
  const width = normalizeWidth(optsOrWidth)

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
 * Mapea el `paperFormat` persistido en la config de impresora al ancho lógico
 * que entiende `printNode`. Por defecto 58mm.
 */
export function widthFromPaperFormat(fmt: '58mm' | '80mm' | 'A4' | undefined | null): PrintWidth {
  if (fmt === '80mm') return '80'
  if (fmt === 'A4') return 'a4'
  return '58'
}
