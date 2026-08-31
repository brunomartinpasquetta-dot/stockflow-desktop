/**
 * Contexto de PANTALLA para Flowy (E1).
 *
 * El renderer manda con cada pregunta el `pageKey` de la ventana donde está
 * parado el usuario (exacto en las ventanas de módulo; 'principal' en la
 * ventana principal). Acá se traduce a un ÁREA de la base de conocimiento para
 * que el motor priorice ese tema: "¿cómo agrego productos?" parado en Ventas
 * responde Ventas, sin que el usuario explique dónde está.
 *
 * Mapa conservador: si un pageKey no tiene un área clara (p.ej. auditoría),
 * queda afuera y la pregunta se responde sin sesgo.
 */

const PAGE_TO_AREA: Record<string, string> = {
  principal: 'intro',

  ventas: 'ventas',
  'historial-ventas': 'ventas',
  'ventas-vendedor': 'ventas',
  'facturacion-electronica': 'facturacion-arca',

  articulos: 'articulos',
  familias: 'articulos',
  promociones: 'articulos',
  'importar-stock': 'articulos',
  'inventario-articulos': 'articulos',

  caja: 'caja',
  'caja-general': 'caja',

  compras: 'compras',
  'historial-compras': 'compras',
  'generador-compras': 'compras',

  presupuestos: 'presupuestos',

  'cuentas-corrientes': 'cuentas-corrientes',
  'cuentas-corrientes-proveedores': 'cuentas-corrientes',

  clientes: 'clientes-proveedores',
  proveedores: 'clientes-proveedores',

  configuracion: 'configuracion',
  'configuracion-mp': 'configuracion',
  empresa: 'configuracion',
  usuarios: 'configuracion',
  'medios-de-pago': 'configuracion',

  contabilidad: 'precios-conta-estad',
  'libro-iva-ventas': 'precios-conta-estad',
  'libro-iva-compras': 'precios-conta-estad',
  estadisticas: 'precios-conta-estad',
  'precios-actualizar': 'precios-conta-estad',
  'precios-historial': 'precios-conta-estad',

  'acerca-de': 'licencia',
};

/** Área de KB para un pageKey del registry, o null si no hay mapeo claro. */
export function resolveScreenArea(pageKey?: string | null): string | null {
  if (!pageKey || typeof pageKey !== 'string') return null;
  return PAGE_TO_AREA[pageKey] ?? null;
}
