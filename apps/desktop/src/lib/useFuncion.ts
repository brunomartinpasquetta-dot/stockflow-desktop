/**
 * ¿El comercio tiene tal función de su licencia? Fuente ÚNICA de la interfaz
 * para todo lo que depende de la edición (común / multisucursal).
 *
 *   const multisucursal = useFuncion('multisucursal')
 *   {multisucursal && <TabsTrigger value="sucursales">Sucursales</TabsTrigger>}
 *
 * Pregunta al canal `funciones:estado`, que en una terminal va al SERVIDOR
 * (la terminal trabaja con la licencia del comercio, no tiene una propia).
 * Mientras carga, sin sesión o ante cualquier error devuelve `false`: con la
 * licencia común no aparece nada nuevo, y ante la duda tampoco.
 *
 * Se refresca sola cuando el main avisa que cambió la licencia (LicenseContext
 * invalida todo lo que cuelga de ['license']).
 */
import { useQuery } from '@tanstack/react-query'

import { useAuth } from '@/contexts/AuthContext'
import { useLanContext } from '@/contexts/LanContext'
import { api } from '@/lib/api'
import type { EdicionDTO, EdicionPruebaDTO } from '@/types/api'

export type FuncionLicencia = 'multisucursal'

function useFuncionesQuery() {
  const { currentUser } = useAuth()
  return useQuery({
    queryKey: ['license', 'funciones', currentUser?.id ?? null],
    queryFn: api.funciones.estado,
    enabled: !!currentUser,
    staleTime: 60_000,
    retry: 0,
  })
}

/** Edición vigente del comercio ('comun' mientras carga o si algo falla). */
export function useEdicion(): EdicionDTO {
  const { data } = useFuncionesQuery()
  return data?.edicion === 'multisucursal' ? 'multisucursal' : 'comun'
}

/**
 * ¿Cada PC tiene su caja? (opción del comercio o Multisucursal; ver
 * electron/ipc/caja-por-pc.ts). false mientras carga o ante un error: con
 * false la pantalla queda como siempre.
 */
export function useCajaPorPc(): boolean {
  const { data } = useFuncionesQuery()
  return data?.cajaPorPc === true
}

/** ¿La licencia del comercio incluye esta función? */
export function useFuncion(funcion: FuncionLicencia): boolean {
  const edicion = useEdicion()
  if (funcion === 'multisucursal') return edicion === 'multisucursal'
  return false
}

/**
 * Interruptor "Edición Multisucursal (versión de prueba)" de ESTA PC. Sólo
 * tiene sentido en la PC que tiene la base y en una versión de prueba
 * (-alpha/-beta/-rc): en una terminal de red, en el navegador, en una versión
 * final, mientras carga o ante un error devuelve `null` y la pantalla no
 * muestra nada. Cuelga de ['license'] para refrescarse con `license:changed`.
 */
export function useEdicionPrueba(): EdicionPruebaDTO | null {
  const { currentUser } = useAuth()
  const { mode } = useLanContext()
  const esWeb = Boolean((window as { __stockflowWeb?: boolean }).__stockflowWeb)
  const { data } = useQuery({
    queryKey: ['license', 'edicionPrueba', currentUser?.id ?? null],
    queryFn: api.funciones.edicionPrueba,
    enabled: !!currentUser && mode !== undefined && mode !== 'client' && !esWeb,
    staleTime: 60_000,
    retry: 0,
  })
  return data && data.disponible ? data : null
}
