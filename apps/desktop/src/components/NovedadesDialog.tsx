/**
 * NOVEDADES POST-ACTUALIZACIÓN — ventana que aparece una sola vez tras el
 * primer inicio de sesión con una versión nueva. Muestra únicamente los
 * cambios visibles (redactados por release en release-notes.json); las
 * correcciones de errores se resumen en una frase genérica al pie.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api } from '@/lib/api'

export function NovedadesDialog() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['novedades', 'pendientes'],
    queryFn: api.novedades.pendientes,
    staleTime: Infinity,
    retry: false,
  })
  const vistas = useMutation({
    mutationFn: api.novedades.vistas,
    onSettled: () => {
      qc.setQueryData(['novedades', 'pendientes'], (prev: unknown) =>
        prev ? { ...(prev as object), hidden: true } : prev,
      )
    },
  })

  const st = q.data
  if (!st || st.hidden) return null

  const variasVersiones = st.items.length > 1

  return (
    <Dialog open onOpenChange={(o) => { if (!o) vistas.mutate() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Novedades de la versión {st.versionActual}
          </DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[55vh] flex-col gap-4 overflow-y-auto">
          {st.items.map((v) => (
            <div key={v.version}>
              {variasVersiones && (
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Versión {v.version}
                </div>
              )}
              <ul className="flex flex-col gap-2">
                {v.novedades.map((n, i) => (
                  <li key={i} className="flex gap-2 text-sm leading-relaxed">
                    <span className="mt-0.5 text-primary">•</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {st.internas && (
            <p className="border-t pt-3 text-xs text-muted-foreground">
              Además, esta actualización incluye mejoras internas de estabilidad y rendimiento.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => vistas.mutate()} disabled={vistas.isPending}>
            Entendido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
