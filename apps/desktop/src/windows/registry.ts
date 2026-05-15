/**
 * Registry de ventanas internas (P-MDI-LAYOUT).
 *
 * Cada entrada define el pageKey + componente lazy + permisos + atajos.
 * `iconName` se resuelve en runtime via `<WindowIcon name="...">` (ver `./WindowIcon`).
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

import type { PermissionAction } from '@/lib/permissions'
import type { Role } from '@/types/api'

export interface WindowDef {
  pageKey: string
  title: string
  iconName?: string
  component: LazyExoticComponent<ComponentType>
  requires?: PermissionAction
  roles?: Role[]
  fKey?: number
  defaultSize?: { width: number; height: number }
  /** Mínimo absoluto de ancho/alto que respeta el WindowManager al hacer resize. */
  minWidth?: number
  minHeight?: number
}

export const WINDOWS: Record<string, WindowDef> = {
  articulos: {
    pageKey: 'articulos',
    title: 'Artículos',
    iconName: 'Package',
    component: lazy(() => import('@/pages/Articulos').then((m) => ({ default: m.Articulos }))),
    fKey: 1,
    requires: 'view_articles',
    defaultSize: { width: 1200, height: 760 },
    minWidth: 1000,
    minHeight: 600,
  },
  proveedores: {
    pageKey: 'proveedores',
    title: 'Proveedores',
    iconName: 'Truck',
    component: lazy(() => import('@/pages/Proveedores').then((m) => ({ default: m.Proveedores }))),
    fKey: 2,
    requires: 'manage_suppliers',
  },
  clientes: {
    pageKey: 'clientes',
    title: 'Clientes',
    iconName: 'Users',
    component: lazy(() => import('@/pages/Clientes').then((m) => ({ default: m.Clientes }))),
    fKey: 3,
  },
  usuarios: {
    pageKey: 'usuarios',
    title: 'Usuarios',
    iconName: 'ShieldCheck',
    component: lazy(() => import('@/pages/Usuarios').then((m) => ({ default: m.Usuarios }))),
    fKey: 4,
    roles: ['admin'],
    requires: 'manage_users',
  },
  compras: {
    pageKey: 'compras',
    title: 'Compras',
    iconName: 'ShoppingCart',
    component: lazy(() => import('@/pages/Compras').then((m) => ({ default: m.Compras }))),
    fKey: 5,
    requires: 'manage_purchases',
    minWidth: 1100,
    minHeight: 700,
  },
  ventas: {
    pageKey: 'ventas',
    title: 'Ventas',
    iconName: 'Receipt',
    component: lazy(() => import('@/pages/Ventas').then((m) => ({ default: m.Ventas }))),
    fKey: 6,
    requires: 'create_sale',
    minWidth: 1100,
    minHeight: 700,
  },
  caja: {
    pageKey: 'caja',
    title: 'Caja',
    iconName: 'Wallet',
    component: lazy(() => import('@/pages/Caja').then((m) => ({ default: m.Caja }))),
    fKey: 7,
    minWidth: 800,
    minHeight: 500,
  },
  'historial-ventas': {
    pageKey: 'historial-ventas',
    title: 'Historial de Ventas',
    iconName: 'BarChart3',
    component: lazy(() => import('@/pages/HistorialVentas').then((m) => ({ default: m.HistorialVentas }))),
    fKey: 8,
    minWidth: 1000,
    minHeight: 600,
  },
  'historial-compras': {
    pageKey: 'historial-compras',
    title: 'Historial de Compras',
    iconName: 'History',
    component: lazy(() => import('@/pages/HistorialCompras').then((m) => ({ default: m.HistorialCompras }))),
    minWidth: 1000,
    minHeight: 600,
  },
  'historial-cajas': {
    pageKey: 'historial-cajas',
    title: 'Historial de Cajas',
    iconName: 'History',
    component: lazy(() => import('@/pages/HistorialCajas').then((m) => ({ default: m.HistorialCajas }))),
    fKey: 9,
    requires: 'view_reports',
    minWidth: 1000,
    minHeight: 600,
  },
  contabilidad: {
    pageKey: 'contabilidad',
    title: 'Contabilidad',
    iconName: 'Calculator',
    component: lazy(() => import('@/pages/Contabilidad').then((m) => ({ default: m.Contabilidad }))),
    fKey: 10,
    requires: 'view_accounting',
    minWidth: 1100,
    minHeight: 600,
  },
  'libro-iva-ventas': {
    pageKey: 'libro-iva-ventas',
    title: 'Libro IVA Ventas',
    iconName: 'Calculator',
    component: lazy(() => import('@/pages/LibroIvaVentas').then((m) => ({ default: m.LibroIvaVentas }))),
    requires: 'view_accounting',
    minWidth: 1100,
    minHeight: 600,
  },
  'libro-iva-compras': {
    pageKey: 'libro-iva-compras',
    title: 'Libro IVA Compras',
    iconName: 'Calculator',
    component: lazy(() => import('@/pages/LibroIvaCompras').then((m) => ({ default: m.LibroIvaCompras }))),
    requires: 'view_accounting',
    minWidth: 1100,
    minHeight: 600,
  },
  familias: {
    pageKey: 'familias',
    title: 'Familias',
    iconName: 'Tags',
    component: lazy(() => import('@/pages/Familias').then((m) => ({ default: m.Familias }))),
  },
  'medios-de-pago': {
    pageKey: 'medios-de-pago',
    title: 'Medios de Pago',
    iconName: 'CreditCard',
    component: lazy(() => import('@/pages/MediosDePago').then((m) => ({ default: m.MediosDePago }))),
    roles: ['admin', 'manager'],
    requires: 'manage_payment_methods',
  },
  'cuentas-corrientes': {
    pageKey: 'cuentas-corrientes',
    title: 'Cuentas Corrientes (Clientes)',
    iconName: 'Landmark',
    component: lazy(() => import('@/pages/CuentasCorrientes').then((m) => ({ default: m.CuentasCorrientes }))),
  },
  'cuentas-corrientes-proveedores': {
    pageKey: 'cuentas-corrientes-proveedores',
    title: 'Cuentas Corrientes (Proveedores)',
    iconName: 'Landmark',
    component: lazy(() => import('@/pages/CuentasCorrientesProveedores').then((m) => ({ default: m.CuentasCorrientesProveedores }))),
  },
  empresa: {
    pageKey: 'empresa',
    title: 'Mi Empresa',
    iconName: 'Building2',
    component: lazy(() => import('@/pages/Empresa').then((m) => ({ default: m.Empresa }))),
    roles: ['admin'],
    requires: 'manage_company',
  },
  configuracion: {
    pageKey: 'configuracion',
    title: 'Configuración',
    iconName: 'Settings',
    component: lazy(() => import('@/pages/Configuracion').then((m) => ({ default: m.Configuracion }))),
    roles: ['admin'],
    minWidth: 900,
    minHeight: 550,
  },
  'configuracion-mp': {
    pageKey: 'configuracion-mp',
    title: 'MercadoPago QR',
    iconName: 'CreditCard',
    component: lazy(() => import('@/pages/ConfiguracionMercadoPago').then((m) => ({ default: m.ConfiguracionMercadoPago }))),
    roles: ['admin'],
    requires: 'manage_mp_qr',
  },
  'importar-stock': {
    pageKey: 'importar-stock',
    title: 'Importar Stock',
    iconName: 'FileSpreadsheet',
    component: lazy(() => import('@/pages/ImportarStock').then((m) => ({ default: m.ImportarStock }))),
    roles: ['admin'],
    requires: 'import_data',
  },
  'precios-actualizar': {
    pageKey: 'precios-actualizar',
    title: 'Actualizar Precios',
    iconName: 'Tag',
    component: lazy(() => import('@/pages/ActualizacionPrecios').then((m) => ({ default: m.ActualizacionPrecios }))),
    requires: 'manage_prices',
  },
  'precios-historial': {
    pageKey: 'precios-historial',
    title: 'Historial de Precios',
    iconName: 'Tags',
    component: lazy(() => import('@/pages/HistorialPrecios').then((m) => ({ default: m.HistorialPrecios }))),
    requires: 'manage_prices',
  },
  'generador-compras': {
    pageKey: 'generador-compras',
    title: 'Generador de Compras',
    iconName: 'PackagePlus',
    component: lazy(() => import('@/pages/GeneradorCompras').then((m) => ({ default: m.GeneradorCompras }))),
    requires: 'view_reports',
  },
  'inventario-articulos': {
    pageKey: 'inventario-articulos',
    title: 'Inventario de Artículos',
    iconName: 'Boxes',
    component: lazy(() => import('@/pages/InventarioArticulos').then((m) => ({ default: m.InventarioArticulos }))),
    requires: 'view_reports',
  },
  'ventas-vendedor': {
    pageKey: 'ventas-vendedor',
    title: 'Ventas por Vendedor',
    iconName: 'BarChart3',
    component: lazy(() => import('@/pages/VentasPorVendedor').then((m) => ({ default: m.VentasPorVendedor }))),
    requires: 'view_reports',
  },
  estadisticas: {
    pageKey: 'estadisticas',
    title: 'Estadísticas',
    iconName: 'BarChart3',
    component: lazy(() => import('@/pages/Estadisticas').then((m) => ({ default: m.Estadisticas }))),
    requires: 'view_reports',
    minWidth: 1200,
    minHeight: 700,
  },
  'acerca-de': {
    pageKey: 'acerca-de',
    title: 'Acerca de StockFlow',
    iconName: 'Info',
    component: lazy(() => import('@/pages/AcercaDe').then((m) => ({ default: m.AcercaDe }))),
  },
}

/** Mapa de URLs → pageKey, usado por `useDeepLinkRouter`. */
export const ROUTE_TO_PAGEKEY: Record<string, string> = {
  '/articulos': 'articulos',
  '/proveedores': 'proveedores',
  '/clientes': 'clientes',
  '/usuarios': 'usuarios',
  '/compras': 'compras',
  '/compras/historial': 'historial-compras',
  '/ventas': 'ventas',
  '/ventas/historial': 'historial-ventas',
  '/caja': 'caja',
  '/consultas/caja': 'historial-cajas',
  '/consultas/generador-compras': 'generador-compras',
  '/consultas/inventario': 'inventario-articulos',
  '/consultas/ventas-vendedor': 'ventas-vendedor',
  '/consultas/estadisticas': 'estadisticas',
  '/precios/actualizar': 'precios-actualizar',
  '/precios/historial': 'precios-historial',
  '/contabilidad': 'contabilidad',
  '/contabilidad/libro-iva-ventas': 'libro-iva-ventas',
  '/contabilidad/libro-iva-compras': 'libro-iva-compras',
  '/familias': 'familias',
  '/medios-de-pago': 'medios-de-pago',
  '/cuentas-corrientes': 'cuentas-corrientes',
  '/cuentas-corrientes-proveedores': 'cuentas-corrientes-proveedores',
  '/empresa': 'empresa',
  '/configuracion': 'configuracion',
  '/configuracion/mercadopago': 'configuracion-mp',
  '/importar-stock': 'importar-stock',
  '/acerca-de': 'acerca-de',
}
