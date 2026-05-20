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
