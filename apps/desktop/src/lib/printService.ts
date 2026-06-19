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
import { flushSync } from 'react-dom'
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

  const area = getPrintArea()
  if (!area) return Promise.reject(new Error('No se pudo encontrar el área de impresión'))

  cleanup()

  return new Promise<void>((resolve, reject) => {
    try {
      const root = createRoot(area)
      activeRoot = root
      // flushSync: forzar el render SÍNCRONO del ticket en #print-area. En React 19
      // `render()` es asíncrono y, bajo la tormenta de re-render de la venta
      // (clearSale + refetch), el commit no llegaba antes de imprimir → salía en
      // BLANCO. flushSync garantiza que el contenido esté en el DOM antes del print.
      flushSync(() => {
        root.render(node)
      })

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
          // DIÁLOGO: window.print() — el SO muestra el diálogo y el driver
          // renderiza el ticket. Funciona en cualquier impresora del SO.
          const printViaDialog = (): void => {
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
          // SILENCIOSO: `webContents.print({ silent:true })` sobre ESTA ventana
          // (la visible, con el ticket ya montado en #print-area + @media print).
          // Es EXACTAMENTE el render del diálogo, pero sin diálogo. SIN pageSize
          // custom (cerebro: pageSize custom = "basura infinita"). En Electron
          // `--kiosk-printing` NO suprime el diálogo de window.print(); este es el
          // camino real. Si falla, caemos al diálogo para no perder el ticket.
          if (silent) {
            void (async () => {
              try {
                const { api } = await import('@/lib/api')
                await api.print.current({
                  ...(deviceName ? { deviceName } : {}),
                  widthMm: width === '80' ? 80 : 58,
                })
                finish()
              } catch (err) {
                console.warn('Impresión silenciosa falló, uso diálogo del SO:', err)
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

/**
 * Construye un documento HTML standalone del ticket, con TODO el CSS de las
 * clases `ticket-*` inlineado. Los valores px/mm son los mismos que el bloque
 * `@media print` de `index.css` (sección tickets térmicos), adaptados a 58/80mm.
 *
 * Se usa para la impresión automática (`autoPrintTicket`): el main process lo
 * renderiza a PDF con `printToPDF()` y lo manda a la impresora vía `lp`.
 */
export function buildStandaloneTicketHtml(body: string, width: '58' | '80'): string {
  const is80 = width === '80'
  // Tamaños espejados de index.css (#print-area .ticket-* y body.printing-80 …).
  const small = is80 ? 14 : 11
  const sep = is80 ? 14 : 11
  const dbl = is80 ? 30 : 22
  const total = is80 ? 30 : 22
  const dblMargin = is80 ? '2mm 0 1mm' : '1mm 0 0.5mm'
  const sepMargin = is80 ? '2mm 0' : '1.5mm 0'
  const totalMargin = is80 ? '2mm 0' : '1mm 0'
  const spacer = is80 ? 12 : 18

  // El papel físico es 58/80mm, pero el área IMPRIMIBLE de un rollo térmico es
  // menor (un rollo de 58mm imprime ~48mm; uno de 80mm, ~72mm). El PDF se
  // genera al ancho del papel físico (pageSize), pero el contenido del ticket
  // se acota al área imprimible con un margen de seguridad → nunca se corta a
  // la derecha.
  const contentWidth = is80 ? 72 : 48

  const css = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: ${width}mm;
      color: #000;
      background: #fff;
      font-family: 'Courier New', Courier, monospace;
      font-size: 13px;
      line-height: 1.3;
    }
    body { padding: 0; }
    .ticket-root {
      width: ${contentWidth}mm;
      max-width: ${contentWidth}mm;
      margin: 0 auto;
      box-sizing: border-box;
    }
    .ticket-root * { max-width: 100%; box-sizing: border-box; }
    .ticket-bold { font-weight: 700; }
    .ticket-center { text-align: center; }
    .ticket-small { font-size: ${small}px; line-height: 1.25; }
    .ticket-double {
      font-size: ${dbl}px;
      font-weight: 900;
      text-align: center;
      line-height: 1.15;
      margin: ${dblMargin};
      text-transform: uppercase;
      word-break: break-word;
    }
    .ticket-sep {
      font-family: 'Courier New', Courier, monospace;
      font-size: ${sep}px;
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
      width: 100%;
      font-variant-numeric: tabular-nums;
    }
    .ticket-item { margin: 0.5mm 0; }
    .ticket-indent { padding-left: 6mm; }
    .ticket-total {
      font-size: ${total}px;
      font-weight: 900;
      line-height: 1.2;
      margin: ${totalMargin};
    }
    .ticket-spacer { height: ${spacer}mm; }
    @page { size: auto; margin: 0; }
  `

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<style>${css}</style>
</head>
<body>${body}</body>
</html>`
}

/**
 * Imprime el ticket automáticamente (sin diálogo). Renderiza el nodo a un
 * documento HTML standalone, lo manda al main process que genera el PDF y lo
 * imprime vía CUPS (lp). Si no hay impresora, el PDF se guarda en el Escritorio.
 *
 * Devuelve `{ printed, pdfPath }`:
 *  - `printed:true`  → salió por la impresora.
 *  - `printed:false` → no había NINGUNA impresora → PDF en `pdfPath` (Escritorio).
 * Si hay impresora pero el PDF o `lp` fallan, LANZA — el caller debe caer al
 * diálogo del SO para que el ticket salga igual.
 *
 * `deviceName` (opcional): impresora configurada en StockFlow; tiene prioridad
 * sobre la impresora por defecto del SO.
 */
export async function autoPrintTicket(
  node: ReactElement,
  width: '58' | '80',
  fileName: string,
  deviceName?: string,
): Promise<{ printed: boolean; pdfPath: string | null }> {
  const { renderToString } = await import('react-dom/server')
  const body = renderToString(node)
  const html = buildStandaloneTicketHtml(body, width)
  const { api } = await import('@/lib/api')
  return api.print.ticketAuto({
    html,
    widthMm: width === '80' ? 80 : 58,
    fileName,
    ...(deviceName ? { deviceName } : {}),
  })
}
