/**
 * Router (P-MDI-LAYOUT)
 *
 * Las rutas internas (compras, ventas, etc.) son "absorbidas" por el
 * WindowManager vía `useDeepLinkRouter`. Aquí dejamos las rutas full-screen
 * (login/activación/bienvenida) y un wildcard que renderiza ProtectedRoute →
 * Layout. El DeepLinkRouter detecta el pathname y abre la ventana correspondiente.
 */
import { Suspense, lazy } from 'react'
import { createHashRouter } from 'react-router-dom'

import { AuthShell } from '@/components/AuthShell'
import { LicenseGuard } from '@/components/LicenseGuard'
import { PageSpinner } from '@/components/PageSpinner'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Login } from '@/pages/Login'

const Activacion = lazy(() => import('@/pages/Activacion').then((m) => ({ default: m.Activacion })))
const Bienvenida = lazy(() => import('@/pages/Bienvenida').then((m) => ({ default: m.Bienvenida })))

export const router = createHashRouter([
  {
    element: <AuthShell />,
    children: [
      { path: '/bienvenida', element: <Suspense fallback={<PageSpinner />}><Bienvenida /></Suspense> },
      { path: '/login', element: <Login /> },
      { path: '/activacion', element: <Suspense fallback={<PageSpinner />}><Activacion /></Suspense> },
      {
        element: <LicenseGuard />,
        children: [
          { path: '*', element: <ProtectedRoute /> },
        ],
      },
    ],
  },
])
