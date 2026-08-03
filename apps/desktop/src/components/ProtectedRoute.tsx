import { Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { Layout } from '@/components/Layout'
import { api } from '@/lib/api'

/**
 * ¿Esta ventana nació como ventana de módulo (`#/embedded/...`)?
 *
 * Se evalúa UNA vez al cargar el bundle, antes de cualquier navegación. Las
 * páginas hacen `<Navigate to="/">` cuando les falta permiso (o mientras los
 * permisos aún no cargaron); si eso ocurre dentro de una ventana de módulo, el
 * wildcard `*` renderizaría el panel principal y el usuario vería el sistema
 * DUPLICADO. Con esta marca, esas ventanas cierran en vez de mutar en panel.
 */
const BORN_EMBEDDED = window.location.hash.startsWith('#/embedded/')

export function ProtectedRoute() {
  const { currentUser, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!currentUser) return <Navigate to="/login" replace />
  if (BORN_EMBEDDED) {
    // Una ventana de módulo nunca debe convertirse en el panel principal.
    void api.desktopWindow.closeSelf().catch(() => undefined)
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return <Layout />
}
