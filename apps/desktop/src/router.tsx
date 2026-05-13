import { Navigate, createHashRouter } from 'react-router-dom'

import { AuthShell } from '@/components/AuthShell'
import { LicenseGuard } from '@/components/LicenseGuard'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { RoleGuard } from '@/components/RoleGuard'
import { Activacion } from '@/pages/Activacion'
import { Configuracion } from '@/pages/Configuracion'
import { ImportarStock } from '@/pages/ImportarStock'
import { Login } from '@/pages/Login'
import { Home } from '@/pages/Home'
import { Articulos } from '@/pages/Articulos'
import { Proveedores } from '@/pages/Proveedores'
import { Clientes } from '@/pages/Clientes'
import { Compras } from '@/pages/Compras'
import { CuentasCorrientes } from '@/pages/CuentasCorrientes'
import { CuentasCorrientesProveedores } from '@/pages/CuentasCorrientesProveedores'
import { Empresa } from '@/pages/Empresa'
import { Familias } from '@/pages/Familias'
import { HistorialCompras } from '@/pages/HistorialCompras'
import { HistorialVentas } from '@/pages/HistorialVentas'
import { MediosDePago } from '@/pages/MediosDePago'
import { Usuarios } from '@/pages/Usuarios'
import { Caja } from '@/pages/Caja'
import { Ventas } from '@/pages/Ventas'

export const router = createHashRouter([
  {
    element: <AuthShell />,
    children: [
      { path: '/login', element: <Login /> },
      { path: '/activacion', element: <Activacion /> },
      {
        element: <LicenseGuard />,
        children: [
          {
            element: <ProtectedRoute />,
            children: [
              { index: true, element: <Home /> },
              { path: '/ventas', element: <Ventas /> },
              { path: '/ventas/historial', element: <HistorialVentas /> },
              { path: '/compras', element: <Compras /> },
              { path: '/compras/historial', element: <HistorialCompras /> },
              { path: '/caja', element: <Caja /> },
              { path: '/articulos', element: <Articulos /> },
              { path: '/proveedores', element: <Proveedores /> },
              { path: '/clientes', element: <Clientes /> },
              { path: '/cuentas-corrientes', element: <CuentasCorrientes /> },
              { path: '/cuentas-corrientes-proveedores', element: <CuentasCorrientesProveedores /> },
              { path: '/familias', element: <Familias /> },
              {
                element: <RoleGuard roles={['admin', 'manager']} />,
                children: [{ path: '/medios-de-pago', element: <MediosDePago /> }],
              },
              {
                element: <RoleGuard roles={['admin']} />,
                children: [
                  { path: '/usuarios', element: <Usuarios /> },
                  { path: '/empresa', element: <Empresa /> },
                  { path: '/configuracion', element: <Configuracion /> },
                  { path: '/importar-stock', element: <ImportarStock /> },
                ],
              },
            ],
          },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
