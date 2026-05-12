import { Navigate, createHashRouter } from 'react-router-dom'

import { AuthShell } from '@/components/AuthShell'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { RoleGuard } from '@/components/RoleGuard'
import { Login } from '@/pages/Login'
import { Home } from '@/pages/Home'
import { Articulos } from '@/pages/Articulos'
import { Proveedores } from '@/pages/Proveedores'
import { Clientes } from '@/pages/Clientes'
import { CuentasCorrientes } from '@/pages/CuentasCorrientes'
import { Familias } from '@/pages/Familias'
import { MediosDePago } from '@/pages/MediosDePago'
import { Usuarios } from '@/pages/Usuarios'
import { Caja } from '@/pages/Caja'
import { Ventas } from '@/pages/Ventas'

export const router = createHashRouter([
  {
    element: <AuthShell />,
    children: [
      { path: '/login', element: <Login /> },
      {
        element: <ProtectedRoute />,
        children: [
          { index: true, element: <Home /> },
          { path: '/ventas', element: <Ventas /> },
          { path: '/caja', element: <Caja /> },
          { path: '/articulos', element: <Articulos /> },
          { path: '/proveedores', element: <Proveedores /> },
          { path: '/clientes', element: <Clientes /> },
          { path: '/cuentas-corrientes', element: <CuentasCorrientes /> },
          { path: '/familias', element: <Familias /> },
          {
            element: <RoleGuard roles={['admin', 'manager']} />,
            children: [{ path: '/medios-de-pago', element: <MediosDePago /> }],
          },
          {
            element: <RoleGuard roles={['admin']} />,
            children: [{ path: '/usuarios', element: <Usuarios /> }],
          },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
