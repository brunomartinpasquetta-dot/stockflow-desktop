/**
 * PRIMEROS PASOS (E5) — checklist de onboarding en la pantalla de bienvenida.
 *
 * La lista se computa en el main contra la base real: acá solo se muestra.
 * Cada paso pendiente abre su pantalla; "No mostrar más" la descarta. Cuando
 * todo está hecho (o en modo demo) el main la oculta solo.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, X } from 'lucide-react'

import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useWindowManager } from '@/contexts/WindowManagerContext'

export function OnboardingCard() {
  const qc = useQueryClient()
  const { openWindow } = useWindowManager()
  const q = useQuery({
    queryKey: ['onboarding', 'status'],
    queryFn: api.onboarding.status,
    staleTime: 30_000,
    retry: false,
    // Al volver el foco a la ventana principal se recalcula: si el usuario
    // cargó el artículo en la ventana de Artículos, el tilde aparece solo.
    refetchOnWindowFocus: true,
  })

  const st = q.data
  if (!st || st.hidden) return null

  return (
    <div className="absolute bottom-6 left-6 z-10 w-[340px] rounded-xl border bg-background/95 shadow-xl backdrop-blur">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="text-sm font-bold">
          Primeros pasos
          <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
            {st.steps.length - st.pending}/{st.steps.length}
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            void api.onboarding.dismiss().then(() => qc.invalidateQueries({ queryKey: ['onboarding'] }))
          }}
          className="rounded p-1 text-muted-foreground transition hover:bg-accent"
          aria-label="No mostrar más la lista de primeros pasos"
          title="No mostrar más"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="p-2">
        {st.steps.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              disabled={s.done}
              onClick={() => openWindow({ pageKey: s.screen })}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition',
                s.done ? 'text-muted-foreground line-through' : 'hover:bg-accent',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                  s.done ? 'border-green-600 bg-green-600 text-white' : 'border-muted-foreground/40',
                )}
              >
                {s.done && <Check className="h-3 w-3" />}
              </span>
              <span className="flex-1">{s.label}</span>
              {!s.done && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
            </button>
          </li>
        ))}
      </ul>
      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        ¿Preferís practicar primero? Preguntale a Flowy por los <b>datos de ejemplo</b>.
      </div>
    </div>
  )
}
