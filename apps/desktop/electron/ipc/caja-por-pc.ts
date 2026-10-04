/**
 * ¿CADA PC TIENE SU CAJA, O EL LOCAL COMPARTE UNA?
 *
 * Hasta la 1.12 todas las PC de una instalación en red abrían la caja con el
 * id del SERVIDOR: en los hechos, una caja compartida por todo el local. Para
 * un comercio con un solo cajón y varias PC (Leo Citzia, 3 PC) eso es
 * exactamente lo que quieren: un arqueo, un ingreso a Caja General.
 *
 * Con la caja por PC, cada puesto abre, vende y arquea la suya. Es necesario
 * en multisucursal (San Carlos no puede vender en el cajón de Coronda) y le
 * sirve a quien tiene un cajón por puesto, pero cambia la operatoria de quien
 * tiene uno solo: al otro día cada cajero tendría que abrir su caja.
 *
 * Regla (revisión de la etapa 1): la caja por PC es una OPCIÓN DEL COMERCIO,
 * APAGADA por defecto, y siempre prendida con la edición Multisucursal.
 *  - Apagada: todo como en la 1.12. `cash:open`/`cash:getCurrent` usan el id
 *    del servidor y el contexto de servicio no lleva terminal (la venta, la
 *    cobranza o el egreso caen en la caja abierta del local).
 *  - Prendida: cada PC usa la suya (`obtenerTerminalActual`).
 *
 * Se guarda en el lan.json del SERVIDOR (`LanManager.getCajaPorPc`): es la
 * configuración de la red del local, como el PIN. Se lee en cada pedido
 * (archivo chico): el cambio rige sin reiniciar.
 */
import { LanManager } from '../lan/LanManager';
import { tieneMultisucursal, type DepsConLicencia } from '../license/funciones';
import { obtenerTerminalActual } from './terminal-actual';

export interface DepsCajaPorPc {
  machineId: string;
  userDataDir: string;
  licenseManager?: DepsConLicencia['licenseManager'] | null;
}

/** ¿Rige la caja por PC? Multisucursal la fuerza; si no, la opción del comercio. */
export function cajaPorPcActiva(deps: DepsCajaPorPc): boolean {
  if (deps.licenseManager && tieneMultisucursal({ licenseManager: deps.licenseManager })) return true;
  try {
    return new LanManager(deps.userDataDir).getCajaPorPc();
  } catch {
    return false;
  }
}

/** La caja por PC está forzada por la edición (la opción no se puede apagar). */
export function cajaPorPcForzada(deps: Pick<DepsCajaPorPc, 'licenseManager'>): boolean {
  return !!deps.licenseManager && tieneMultisucursal({ licenseManager: deps.licenseManager });
}

/** La opción del comercio sola (lan.json), sin mirar la edición. */
export function cajaPorPcDelComercio(deps: Pick<DepsCajaPorPc, 'userDataDir'>): boolean {
  try {
    return new LanManager(deps.userDataDir).getCajaPorPc();
  } catch {
    return false;
  }
}

interface SqliteCajas {
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown };
}

/**
 * Al PRENDER la caja por PC a mitad de turno (opción del comercio o edición
 * Multisucursal): la caja abierta con el id del servidor —la del local— pasa
 * a caja compartida heredada (terminal_id NULL, igual que la migración 0042).
 * Todos los puestos siguen vendiendo en ella hasta que alguien la cierre, y
 * desde ahí cada PC abre la suya. Nadie queda sin caja. Devuelve cuántas pasó.
 */
export function compartirCajaDelServidor(deps: { db: { $client: unknown }; machineId: string }): number {
  const r = (deps.db.$client as SqliteCajas)
    .prepare(`UPDATE cash_registers SET terminal_id = NULL WHERE status = 'open' AND terminal_id = ?`)
    .run(deps.machineId) as { changes?: number } | undefined;
  return r?.changes ?? 0;
}

/**
 * ¿Hay cajas abiertas de OTRAS PC? Sin caja por PC quedarían sin pantalla que
 * las muestre: antes de apagarla se cierran desde el Historial de cajas.
 */
export function hayCajasAbiertasDeOtrasPc(deps: { db: { $client: unknown }; machineId: string }): boolean {
  const otras = (deps.db.$client as SqliteCajas)
    .prepare(`SELECT COUNT(*) AS n FROM cash_registers WHERE status = 'open' AND terminal_id IS NOT NULL AND terminal_id <> ?`)
    .get(deps.machineId) as { n: number } | undefined;
  return (otras?.n ?? 0) > 0;
}

/**
 * Id con que se abre o se busca la caja de este pedido (`cash:open`,
 * `cash:getCurrent`). Apagada: el del servidor, como siempre.
 */
export function idDeCajaDelPedido(deps: DepsCajaPorPc): string {
  return cajaPorPcActiva(deps) ? obtenerTerminalActual(deps).id : deps.machineId;
}

/**
 * Terminal que va en el `ServiceContext` (elige la caja de ventas, cobranzas,
 * egresos, devoluciones y anulaciones). Apagada: null = la caja abierta del
 * local, como en la 1.12.
 */
export function terminalDelContexto(deps: DepsCajaPorPc): string | null {
  return cajaPorPcActiva(deps) ? obtenerTerminalActual(deps).id : null;
}
