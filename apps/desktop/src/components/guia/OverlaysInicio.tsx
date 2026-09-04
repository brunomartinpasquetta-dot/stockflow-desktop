/**
 * Overlays post-login, UNO a la vez: la Guía de primeros pasos tiene prioridad
 * sobre la ventana de Novedades (si la guía está en pantalla, las novedades
 * esperan a la próxima sesión — nunca dos ventanas encimadas).
 *
 * Auto-apertura de la guía: primer inicio de sesión de una licencia de PRUEBA
 * con usuario administrador, una sola vez por máquina. Reapertura manual:
 * evento 'sf:abrir-guia' (menú Ayuda), disponible siempre.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { AsistenteInicial } from '@/components/guia/AsistenteInicial'
import { NovedadesDialog } from '@/components/NovedadesDialog'
import { useAuth } from '@/contexts/AuthContext'
import { useLicense } from '@/contexts/LicenseContext'
import { api } from '@/lib/api'

export function OverlaysInicio() {
  const { currentUser } = useAuth()
  const { state: license } = useLicense()
  const guiaQuery = useQuery({ queryKey: ['guia', 'estado'], queryFn: api.guia.estado, staleTime: Infinity, retry: false })

  const [guiaVisible, setGuiaVisible] = useState(false)
  const [autoEvaluada, setAutoEvaluada] = useState(false)

  // Auto-apertura (una vez por sesión de UI, y una vez por máquina de por vida).
  useEffect(() => {
    if (autoEvaluada || !guiaQuery.data || !currentUser) return
    setAutoEvaluada(true)
    if (license?.trial === true && !guiaQuery.data.vista && currentUser.role === 'admin') {
      setGuiaVisible(true)
    }
  }, [autoEvaluada, guiaQuery.data, currentUser, license])

  // Reapertura manual desde Ayuda → Guía de primeros pasos.
  useEffect(() => {
    const abrir = (): void => setGuiaVisible(true)
    window.addEventListener('sf:abrir-guia', abrir)
    return () => window.removeEventListener('sf:abrir-guia', abrir)
  }, [])

  return (
    <>
      <AsistenteInicial visible={guiaVisible} onClose={() => setGuiaVisible(false)} />
      {!guiaVisible && <NovedadesDialog />}
    </>
  )
}
