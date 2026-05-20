/**
 * Router (v0.1.17 — ventanas nativas del SO)
 *
 * - Rutas full-screen: login / activación / bienvenida (ventana principal).
 * - `/embedded/:pageKey`: una pantalla aislada, sin chrome — el contenido de
 *   cada `BrowserWindow` nativa. Vive bajo `AuthShell` para heredar `AuthProvider`.
 * - Wildcard `*`: la ventana principal (ProtectedRoute → Layout).
 *
 * Las rutas internas (compras, ventas, etc.) siguen siendo "absorbidas" por el
 * WindowManager vía `useDeepLinkRouter`, que ahora abre ventanas nativas.
 */
import { Suspense, lazy } from 'react'
import { createHashRouter } from 'react-router-dom'

import { AuthShell } from '@/components/AuthShell'
import { EmbeddedWindow } from '@/components/EmbeddedWindow'
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
      { path: '/embedded/:pageKey', element: <EmbeddedWindow /> },
      {
        element: <LicenseGuard />,
        children: [
          { path: '*', element: <ProtectedRoute /> },
        ],
      },
    ],
  },
])
