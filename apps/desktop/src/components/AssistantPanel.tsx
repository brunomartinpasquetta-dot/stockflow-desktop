/**
 * Panel del Asistente virtual "Sofía" — chatbot INTERNO de StockFlow.
 *
 * 100% offline: la lógica vive en el main (`assistant:ask` → engine local, sin IA
 * externa ni costo). Acá va la conversación, los chips de sugerencias y el render.
 *
 * El panel es MOVIBLE (arrastrando el encabezado) y REDIMENSIONABLE (esquina
 * inferior derecha). La posición/tamaño se recuerdan entre sesiones
 * (localStorage) y se re-encuadran si la ventana se achica.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { GripHorizontal, Loader2, Minus, Send, X } from 'lucide-react'

import { BRANDING } from '@/assets/branding'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { shotUrl } from '@/lib/sofiaShots'
import { Button } from '@/components/ui/button'
import { useAssistant } from '@/contexts/AssistantContext'
import type { AssistantMessageDTO } from '@/types/api'

interface ChatMsg extends AssistantMessageDTO {
  suggestions?: string[]
  image?: string | null
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const STORAGE_KEY = 'sofia-panel-rect'
const MIN_W = 320
const MIN_H = 380
const MARGIN = 8

function defaultRect(): Rect {
  const w = 380
  const h = 560
  return {
    x: Math.max(MARGIN, window.innerWidth - w - 16),
    y: Math.max(MARGIN, window.innerHeight - h - 16),
    w,
    h,
  }
}

/** Encuadra el rect dentro de la ventana (por si cambió el tamaño o el monitor). */
function clampRect(r: Rect): Rect {
  const w = Math.min(Math.max(r.w, MIN_W), window.innerWidth - MARGIN * 2)
  const h = Math.min(Math.max(r.h, MIN_H), window.innerHeight - MARGIN * 2)
  const x = Math.min(Math.max(r.x, MARGIN), window.innerWidth - w - MARGIN)
  const y = Math.min(Math.max(r.y, MARGIN), window.innerHeight - h - MARGIN)
  return { x, y, w, h }
}

function loadRect(): Rect {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return clampRect(JSON.parse(raw) as Rect)
  } catch {
    /* rect corrupto → default */
  }
  return clampRect(defaultRect())
}

function saveRect(r: Rect): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r))
  } catch {
    /* sin persistencia, no es crítico */
  }
}

export function AssistantPanel() {
  const { state, pending, hide, minimize, clearPending } = useAssistant()
  const open = state === 'open'
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [greeted, setGreeted] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const [rect, setRect] = useState<Rect>(() => loadRect())
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Ref al último mensaje del bot: al responder, dejamos el foco en su INICIO.
  const lastBotRef = useRef<HTMLDivElement>(null)
  // Id de conversación: mantiene el hilo/contexto en el motor durante esta charla.
  const convIdRef = useRef<string>((globalThis.crypto?.randomUUID?.() ?? String(Math.random())).slice(0, 24))
  // Datos del gesto en curso (drag o resize); null = sin gesto.
  const gestureRef = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; start: Rect } | null>(null)

  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    // Al llegar una respuesta del bot, dejamos su INICIO arriba (no el final),
    // para que el cliente empiece a leer desde la primera línea.
    if (!busy && lastMsg?.role === 'assistant' && lastBotRef.current) {
      lastBotRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } else {
      // Mientras escribe el usuario / "Buscando…": bajamos para mostrarlo.
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, busy])

  // Al abrir: si viene una pregunta desde el buscador, la mandamos directo;
  // si no, saludo inicial (viene del motor, con sugerencias reales).
  useEffect(() => {
    if (!open) return
    if (pending) {
      const q = pending
      clearPending()
      setGreeted(true)
      void send(q)
      return
    }
    if (greeted) return
    setGreeted(true)
    void (async () => {
      try {
        const res = await api.assistant.ask([], convIdRef.current)
        setMessages([{ role: 'assistant', content: res.reply, suggestions: res.suggestions, image: res.image }])
      } catch {
        setMessages([{ role: 'assistant', content: '¡Hola! Soy Sofía, tu asistente de StockFlow. Escribime en qué te puedo ayudar.' }])
      }
      setTimeout(() => inputRef.current?.focus(), 100)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending, greeted])

  // Si el usuario achica la ventana, el panel se re-encuadra solo.
  useEffect(() => {
    if (!open) return
    const onResize = (): void => setRect((r) => clampRect(r))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open])

  const beginGesture = useCallback(
    (kind: 'move' | 'resize') => (e: React.PointerEvent<HTMLElement>) => {
      // No arrancar drag desde botones (cerrar) dentro del header.
      if (kind === 'move' && (e.target as HTMLElement).closest('button')) return
      e.preventDefault()
      gestureRef.current = { kind, startX: e.clientX, startY: e.clientY, start: rect }
      const onMove = (ev: PointerEvent): void => {
        const g = gestureRef.current
        if (!g) return
        const dx = ev.clientX - g.startX
        const dy = ev.clientY - g.startY
        setRect(
          g.kind === 'move'
            ? clampRect({ ...g.start, x: g.start.x + dx, y: g.start.y + dy })
            : clampRect({ ...g.start, w: g.start.w + dx, h: g.start.h + dy }),
        )
      }
      const onUp = (): void => {
        gestureRef.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setRect((r) => {
          saveRect(r)
          return r
        })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [rect],
  )

  async function send(text?: string): Promise<void> {
    const q = (text ?? input).trim()
    if (!q || busy) return
    const next: ChatMsg[] = [...messages, { role: 'user', content: q }]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const payload: AssistantMessageDTO[] = next.map((m) => ({ role: m.role, content: m.content }))
      const res = await api.assistant.ask(payload, convIdRef.current)
      setMessages((prev) => [...prev, { role: 'assistant', content: res.reply, suggestions: res.suggestions, image: res.image }])
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Uy, algo falló. Probá de nuevo.' }])
    } finally {
      setBusy(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  if (!open) return null

  const lastIdx = messages.length - 1

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      {/* Header — arrastrable */}
      <div
        className="flex cursor-move select-none items-center gap-2 border-b bg-primary px-3 py-2.5 text-primary-foreground"
        onPointerDown={beginGesture('move')}
        title="Arrastrá para mover el chat"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-foreground">
          <img src={BRANDING.iconSvg} alt="StockFlow" className="h-6 w-6" draggable={false} />
        </div>
        <div className="flex-1 leading-tight">
          <div className="text-sm font-semibold">Sofía</div>
          <div className="text-[11px] opacity-80">Asistente de StockFlow</div>
        </div>
        <GripHorizontal className="h-4 w-4 opacity-50" />
        <button
          type="button"
          onClick={minimize}
          className="rounded-md p-1 transition-colors hover:bg-primary-foreground/15"
          aria-label="Minimizar asistente"
          title="Minimizar"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={hide}
          className="rounded-md p-1 transition-colors hover:bg-primary-foreground/15"
          aria-label="Cerrar asistente"
          title="Cerrar"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Mensajes */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-muted/30 p-3">
        {messages.map((m, i) => (
          <div key={i} ref={m.role === 'assistant' && i === lastIdx ? lastBotRef : undefined} className="scroll-mt-3">
            <div className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm',
                  m.role === 'user'
                    ? 'rounded-br-sm bg-primary text-primary-foreground'
                    : 'rounded-bl-sm border bg-background',
                )}
              >
                {m.content}
              </div>
            </div>
            {/* Captura de la pantalla (si la hay) — clic para agrandar */}
            {m.role === 'assistant' &&
              m.image &&
              shotUrl(m.image) &&
              (() => {
                const url = shotUrl(m.image)!
                return (
                  <button
                    type="button"
                    onClick={() => setZoom(url)}
                    className="mt-2 block overflow-hidden rounded-lg border transition hover:ring-2 hover:ring-primary"
                    title="Clic para agrandar la imagen"
                  >
                    <img src={url} alt="Pantalla de StockFlow" className="max-h-40 w-full object-cover object-top" draggable={false} />
                  </button>
                )
              })()}
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border bg-background px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Buscando…
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 border-t bg-background p-2">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Escribí tu pregunta…"
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button size="icon" className="h-9 w-9 shrink-0" onClick={() => void send()} disabled={busy || !input.trim()} title="Enviar pregunta">
          <Send className="h-4 w-4" />
        </Button>
      </div>

      {/* Esquina de redimensionado */}
      <div
        className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize"
        onPointerDown={beginGesture('resize')}
        title="Arrastrá para cambiar el tamaño"
      >
        <svg viewBox="0 0 20 20" className="h-full w-full text-muted-foreground/60">
          <path d="M17 9v2h-2v2h-2v2h-2v2h2l6-6V9h-2zM17 3 3 17h2L19 3h-2z" fill="currentColor" opacity="0.35" />
        </svg>
      </div>

      {/* Overlay de imagen a pantalla completa */}
      {zoom && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setZoom(null)}
          role="dialog"
          aria-label="Imagen ampliada"
        >
          <img src={zoom} alt="Pantalla de StockFlow" className="max-h-full max-w-full rounded-lg shadow-2xl" draggable={false} />
        </div>
      )}
    </div>
  )
}
