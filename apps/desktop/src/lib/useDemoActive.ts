/**
 * ¿Está activo el MODO DEMO? (datos de ejemplo cargados, E5).
 * Se consulta al montar cada ventana; mientras esté activo, la UI muestra un
 * distintivo DEMO permanente para que nunca se confunda con datos reales.
 */
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'

export function useDemoActive(): boolean {
  const q = useQuery({
    queryKey: ['demo', 'status'],
    queryFn: api.demo.status,
    staleTime: 60_000,
    retry: false,
  })
  return q.data?.active === true
}
