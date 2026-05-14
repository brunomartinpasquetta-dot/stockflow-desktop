import { Suspense, lazy } from 'react'
import { Navigate, Outlet, createHashRouter } from 'react-router-dom'

import { AuthShell } from '@/components/AuthShell'
import { LicenseGuard } from '@/components/LicenseGuard'
import { PageSpinner } from '@/components/PageSpinner'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { RoleGuard } from '@/components/RoleGuard'
import { Login } from '@/pages/Login'
import { Home } from '@/pages/Home'

// Lazy-loaded por ruta: cada página queda en su propio chunk.
const Activacion = lazy(() => import('@/pages/Activacion').then((m) => ({ default: m.Activacion })))
const Configuracion = lazy(() => import('@/pages/Configuracion').then((m) => ({ default: m.Configuracion })))
const ImportarStock = lazy(() => import('@/pages/ImportarStock').then((m) => ({ default: m.ImportarStock })))
const Articulos = lazy(() => import('@/pages/Articulos').then((m) => ({ default: m.Articulos })))
const Proveedores = lazy(() => import('@/pages/Proveedores').then((m) => ({ default: m.Proveedores })))
const Clientes = lazy(() => import('@/pages/Clientes').then((m) => ({ default: m.Clientes })))
const Compras = lazy(() => import('@/pages/Compras').then((m) => ({ default: m.Compras })))
const CuentasCorrientes = lazy(() => import('@/pages/CuentasCorrientes').then((m) => ({ default: m.CuentasCorrientes })))
const CuentasCorrientesProveedores = lazy(() => import('@/pages/CuentasCorrientesProveedores').then((m) => ({ default: m.CuentasCorrientesProveedores })))
const Empresa = lazy(() => import('@/pages/Empresa').then((m) => ({ default: m.Empresa })))
const Familias = lazy(() => import('@/pages/Familias').then((m) => ({ default: m.Familias })))
const HistorialCompras = lazy(() => import('@/pages/HistorialCompras').then((m) => ({ default: m.HistorialCompras })))
const HistorialVentas = lazy(() => import('@/pages/HistorialVentas').then((m) => ({ default: m.HistorialVentas })))
const MediosDePago = lazy(() => import('@/pages/MediosDePago').then((m) => ({ default: m.MediosDePago })))
const Usuarios = lazy(() => import('@/pages/Usuarios').then((m) => ({ default: m.Usuarios })))
const Caja = lazy(() => import('@/pages/Caja').then((m) => ({ default: m.Caja })))
const HistorialCajas = lazy(() => import('@/pages/HistorialCajas').then((m) => ({ default: m.HistorialCajas })))
const Ventas = lazy(() => import('@/pages/Ventas').then((m) => ({ default: m.Ventas })))
const AcercaDe = lazy(() => import('@/pages/AcercaDe').then((m) => ({ default: m.AcercaDe })))
const Bienvenida = lazy(() => import('@/pages/Bienvenida').then((m) => ({ default: m.Bienvenida })))
const ActualizacionPrecios = lazy(() => import('@/pages/ActualizacionPrecios').then((m) => ({ default: m.ActualizacionPrecios })))
const HistorialPrecios = lazy(() => import('@/pages/HistorialPrecios').then((m) => ({ default: m.HistorialPrecios })))
const ConfiguracionMercadoPago = lazy(() => import('@/pages/ConfiguracionMercadoPago').then((m) => ({ default: m.ConfiguracionMercadoPago })))
const GeneradorCompras = lazy(() => import('@/pages/GeneradorCompras').then((m) => ({ default: m.GeneradorCompras })))
const InventarioArticulos = lazy(() => import('@/pages/InventarioArticulos').then((m) => ({ default: m.InventarioArticulos })))
const VentasPorVendedor = lazy(() => import('@/pages/VentasPorVendedor').then((m) => ({ default: m.VentasPorVendedor })))
const Contabilidad = lazy(() => import('@/pages/Contabilidad').then((m) => ({ default: m.Contabilidad })))
const LibroIvaVentas = lazy(() => import('@/pages/LibroIvaVentas').then((m) => ({ default: m.LibroIvaVentas })))
const LibroIvaCompras = lazy(() => import('@/pages/LibroIvaCompras').then((m) => ({ default: m.LibroIvaCompras })))

function SuspenseOutlet() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Outlet />
    </Suspense>
  )
}

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
          {
            element: <ProtectedRoute />,
            children: [
              {
                element: <SuspenseOutlet />,
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
                  { path: '/acerca-de', element: <AcercaDe /> },
                  {
                    element: <RoleGuard roles={['admin', 'manager']} />,
                    children: [
                      { path: '/medios-de-pago', element: <MediosDePago /> },
                      { path: '/consultas/caja', element: <HistorialCajas /> },
                      { path: '/consultas/generador-compras', element: <GeneradorCompras /> },
                      { path: '/consultas/inventario', element: <InventarioArticulos /> },
                      { path: '/consultas/ventas-vendedor', element: <VentasPorVendedor /> },
                      { path: '/precios/actualizar', element: <ActualizacionPrecios /> },
                      { path: '/precios/historial', element: <HistorialPrecios /> },
                      { path: '/contabilidad', element: <Contabilidad /> },
                      { path: '/contabilidad/libro-iva-ventas', element: <LibroIvaVentas /> },
                      { path: '/contabilidad/libro-iva-compras', element: <LibroIvaCompras /> },
                    ],
                  },
                  {
                    element: <RoleGuard roles={['admin']} />,
                    children: [
                      { path: '/usuarios', element: <Usuarios /> },
                      { path: '/empresa', element: <Empresa /> },
                      { path: '/configuracion', element: <Configuracion /> },
                      { path: '/configuracion/mercadopago', element: <ConfiguracionMercadoPago /> },
                      { path: '/importar-stock', element: <ImportarStock /> },
                    ],
                  },
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
