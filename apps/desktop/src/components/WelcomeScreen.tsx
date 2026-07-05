/**
 * WelcomeScreen — pantalla principal del Desktop (siempre visible en la ventana
 * principal; cada módulo abre en ventana nativa aparte).
 *
 * POC WhatsApp: panel embebido (webview de Electron, sesión persistente) que se
 * muestra/oculta con el ícono del toolbar y se minimiza a la DERECHA.
 *
 * Fluidez: el webview tiene ancho FIJO y solo animamos un contenedor que lo
 * recorta (clip). Así la superficie nativa nunca se redimensiona cuadro a cuadro
 * (eso trababa WhatsApp). El webview se crea UNA vez y queda montado para no
 * perder la sesión. SOLO pruebas locales.
 */
import { BRANDING } from "@/assets/branding"
import { useEffect, useRef } from 'react'
import { Minus, RefreshCw, X } from 'lucide-react'

import { api } from '@/lib/api'
import { useWhatsAppPanel } from '@/contexts/WhatsAppPanelContext'
import { WhatsAppGlyph } from '@/components/WhatsAppGlyph'

const WA_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const PANEL_WIDTH = 560
// WhatsApp Web (2 paneles) necesita ~820px CSS; escalamos para que entre justo.
const WA_ZOOM = PANEL_WIDTH / 820
const TRANSITION = 'width 300ms cubic-bezier(0.4,0,0.2,1)'

export function WelcomeScreen() {
  const { state, set } = useWhatsAppPanel()
  const boxRef = useRef<HTMLDivElement>(null)
  const createdRef = useRef(false)
  const pendingUrlRef = useRef<string | null>(null)

  // Navega el panel al chat de un contacto (o lo deja pendiente si aún no se creó
  // el webview; en ese caso se usa como URL inicial al crearse).
  const goToChat = (phone: string) => {
    const url = `https://web.whatsapp.com/send?phone=${phone}`
    const wv = boxRef.current?.querySelector('webview') as unknown as { loadURL?: (u: string) => void } | null
    if (wv?.loadURL) {
      try {
        wv.loadURL(url)
      } catch {
        pendingUrlRef.current = url
      }
    } else {
      pendingUrlRef.current = url
    }
  }

  // Pedido desde otra ventana (botón de WhatsApp en Clientes/Proveedores/CtaCte).
  useEffect(() => {
    return api.whatsapp.onNavigate((phone) => {
      set('normal')
      goToChat(phone)
    })
  }, [set])

  // Crea el <webview> la primera vez que se abre y lo mantiene montado.
  useEffect(() => {
    if (createdRef.current || state !== 'normal') return
    const box = boxRef.current
    if (!box) return
    const wv = document.createElement('webview')
    wv.setAttribute('src', pendingUrlRef.current ?? 'https://web.whatsapp.com')
    pendingUrlRef.current = null
    wv.setAttribute('partition', 'persist:whatsapp')
    wv.setAttribute('useragent', WA_UA)
    wv.setAttribute('allowpopups', 'true')
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = '0'
    wv.addEventListener('dom-ready', () => {
      try {
        ;(wv as unknown as { setZoomFactor?: (z: number) => void }).setZoomFactor?.(WA_ZOOM)
      } catch {
        /* noop */
      }
    })
    box.appendChild(wv)
    createdRef.current = true
  }, [state])

  const reload = () => {
    const wv = boxRef.current?.querySelector('webview') as unknown as { reload?: () => void } | null
    wv?.reload?.()
  }

  const clipWidth = state === 'normal' ? PANEL_WIDTH : 0
  const stripWidth = state === 'min' ? 46 : 0

  return (
    <div className="relative flex h-full overflow-hidden bg-gradient-to-br from-background to-muted/30">
      {/* Logo (se comprime cuando el panel abre) */}
      <div className="flex min-w-0 flex-1 items-center justify-center px-8 py-12">
        <img
          src={BRANDING.logoStacked}
          alt="StockFlow — Sistema de Gestión Comercial"
          className="h-auto w-[260px] select-none"
          draggable={false}
        />
      </div>

      {/* Contenedor que RECORTA (se anima el ancho de éste, no el del webview) */}
      <div className="h-full shrink-0 overflow-hidden" style={{ width: clipWidth, transition: TRANSITION }}>
        {/* Contenido de ancho FIJO: el webview nunca se redimensiona → fluido */}
        <div className="flex h-full flex-col border-l bg-white" style={{ width: PANEL_WIDTH, borderColor: 'rgb(228 234 243)' }}>
          <div className="flex items-center justify-between bg-primary px-2 py-1.5 text-primary-foreground">
            <span className="flex items-center gap-1.5 px-1 text-sm font-semibold">
              <WhatsAppGlyph className="h-4 w-4" strokeWidth={2} /> WhatsApp
            </span>
            <div className="flex items-center gap-0.5">
              <button title="Recargar" className="rounded p-1 transition hover:bg-white/20" onClick={reload}>
                <RefreshCw className="h-4 w-4" />
              </button>
              <button title="Minimizar" className="rounded p-1 transition hover:bg-white/20" onClick={() => set('min')}>
                <Minus className="h-4 w-4" />
              </button>
              <button title="Cerrar" className="rounded p-1 transition hover:bg-white/20" onClick={() => set('hidden')}>
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div ref={boxRef} className="min-h-0 flex-1" />
        </div>
      </div>

      {/* Barra minimizada (costado DERECHO) */}
      <button
        onClick={() => set('normal')}
        title="Abrir WhatsApp"
        tabIndex={state === 'min' ? 0 : -1}
        className="flex h-full shrink-0 flex-col items-center gap-3 overflow-hidden whitespace-nowrap bg-primary text-primary-foreground hover:brightness-110"
        style={{ width: stripWidth, transition: TRANSITION }}
      >
        <span className="pt-4">
          <WhatsAppGlyph className="h-6 w-6" strokeWidth={2} />
        </span>
        <span className="text-xs font-semibold tracking-wide [writing-mode:vertical-rl]">WhatsApp</span>
      </button>
    </div>
  )
}
