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
  const { width, silent, deviceName } = opts

  // Modo silencioso: sólo soportado en tickets térmicos (58/80) y cuando el
  // bridge IPC está disponible (Electron). Si falla, hacemos fallback al
  // window.print() con dialog.
  if (silent && deviceName && (width === '58' || width === '80')) {
    try {
      const html = await renderNodeToTicketHtml(node, width)
      const widthMm: 58 | 80 = width === '80' ? 80 : 58
      const { api } = await import('@/lib/api')
      await api.print.silent({ html, deviceName, widthMm })
      return
    } catch (err) {
      console.warn('[printService] silent print falló, fallback a dialog:', err)
      // sigue al flujo normal
    }
  }

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

/* -------------------------------------------------------------------------- */
/* Render a HTML para impresión silenciosa                                    */
/* -------------------------------------------------------------------------- */

/**
 * Subset del CSS de `index.css` necesario para que el ticket impreso por la
 * BrowserWindow oculta tenga el mismo aspecto que en el flujo normal. Se
 * inlinea en el `<style>` del documento data:text/html para no depender de
 * recursos externos en la ventana invisible.
 */
function buildTicketCss(width: '58' | '80'): string {
  const widthMm = width === '80' ? 80 : 58
  const paddingMm = width === '80' ? '4mm 3mm' : '3mm 2mm'
  const fontPx = width === '80' ? 18 : 14
  const doubleHeightPx = width === '80' ? 26 : 20
  const doublePx = width === '80' ? 34 : 26
  const sepPx = width === '80' ? 14 : 11
  const sepMargin = width === '80' ? '2mm 0' : '1.5mm 0'
  const doubleHeightMargin = width === '80' ? '2mm 0 1mm' : '1.5mm 0 0.5mm'
  const doubleMargin = width === '80' ? '3mm 0' : '2mm 0'
  const spacerMm = width === '80' ? 12 : 18

  return `
    @page { size: ${widthMm}mm auto; margin: 0; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: ${fontPx}px;
      font-weight: 600;
      line-height: 1.3;
      color: #000;
      background: #fff;
    }
    .print-area {
      width: ${widthMm}mm;
      padding: ${paddingMm};
      color: #000;
      background: #fff;
    }
    .print-area * { color: #000; background: transparent; }
    .ticket-bold { font-weight: 700; }
    .ticket-center { text-align: center; }
    .ticket-double-height {
      font-size: ${doubleHeightPx}px;
      font-weight: 700;
      line-height: 1.2;
      margin: ${doubleHeightMargin};
    }
    .ticket-double {
      font-size: ${doublePx}px;
      font-weight: 900;
      text-align: center;
      line-height: 1.1;
      margin: ${doubleMargin};
    }
    .ticket-sep {
      font-family: 'Courier New', Courier, monospace;
      font-size: ${sepPx}px;
      letter-spacing: -0.5px;
      overflow: hidden;
      white-space: nowrap;
      line-height: 1;
      margin: ${sepMargin};
      font-weight: 700;
    }
    .ticket-row {
      display: flex;
      justify-content: space-between;
      gap: 4px;
      font-variant-numeric: tabular-nums;
    }
    .ticket-spacer { height: ${spacerMm}mm; }
  `
}

async function renderNodeToTicketHtml(node: ReactElement, width: '58' | '80'): Promise<string> {
  const { renderToString } = await import('react-dom/server')
  const body = renderToString(node)
  const css = buildTicketCss(width)
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="print-area">${body}</div></body></html>`
}
