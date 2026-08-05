import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'

import { ApiError } from '@/lib/api'

/** Evento global: alguien debe redirigir al login. Lo escucha AuthProvider. */
export const UNAUTHENTICATED_EVENT = 'stockflow:unauthenticated'

function handleGlobalError(error: unknown): void {
  if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
    window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT))
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // v0.1.17: cada BrowserWindow nativa es un renderer aislado con su propia
      // cache de React Query. Al enfocar una ventana se refetchean las queries
      // stale → los datos se mantienen sincronizados entre ventanas sin un
      // broadcast IPC de invalidaciones.
      refetchOnWindowFocus: true,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
  queryCache: new QueryCache({ onError: handleGlobalError }),
  mutationCache: new MutationCache({ onError: handleGlobalError }),
})

/**
 * Sincronización entre ventanas.
 *
 * Cada módulo abre su propia BrowserWindow, con una cache de React Query
 * aislada. `refetchOnWindowFocus` no alcanza: una devolución hecha en el
 * Historial no refrescaba el stock que mostraba la ventana de Artículos, y el
 * usuario veía un valor viejo (parecía que el stock no se había revertido).
 *
 * El proceso principal emite `data:changed` tras cada operación de escritura;
 * acá se invalida la cache para que la ventana recargue lo que tenga en
 * pantalla. Se llama una vez al arrancar el renderer.
 */
export function subscribeToDataChanges(): () => void {
  const sf = (window as unknown as { stockflow?: { system?: { onDataChanged?: (cb: () => void) => () => void } } })
    .stockflow
  const off = sf?.system?.onDataChanged?.(() => {
    void queryClient.invalidateQueries()
  })
  return off ?? (() => undefined)
}
