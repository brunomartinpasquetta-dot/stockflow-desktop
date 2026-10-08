import { addDecimal, subDecimal } from './decimal';

/**
 * Cuánto cobró la caja por medios que NO son efectivo físico.
 *
 * UNA SOLA FÓRMULA PARA TODOS. Antes la pantalla y el servidor la calculaban
 * distinto: la pantalla sumaba el neto de cada medio con piso cero por medio,
 * y el servidor hacía el neto global con piso cero. Con Tarjeta +1000 y
 * Transferencia −400 la pantalla proponía 1000, el servidor aceptaba como
 * máximo 600 y **el cierre no se podía completar** (rechazo
 * DEPOSIT_OVER_ELECTRONIC, ya anotado en la auditoría del 19-sep-2026).
 *
 * Vale la del servidor: una devolución por transferencia es plata que el
 * comercio devolvió, así que baja lo cobrado. El piso cero va al final, una
 * sola vez: un neto negativo no puede llevarse plata del efectivo.
 */
export function netoElectronico(
  medios: ReadonlyArray<{ isPhysicalCash?: boolean | null; net?: string | number | null }>,
): string {
  let total = '0';
  for (const m of medios) {
    if (m.isPhysicalCash) continue;
    total = addDecimal(total, String(m.net ?? '0'), 2);
  }
  return Number(total) > 0 ? total : '0';
}

/**
 * Lo que pasa a Caja General al cerrar: el efectivo contado menos el cambio
 * que queda en el cajón, más lo cobrado por medios electrónicos.
 */
export function totalParaCajaGeneral(
  efectivoContado: string,
  cambioQueQueda: string,
  electronico: string,
): { efectivo: string; electronico: string; total: string } {
  const bruto = subDecimal(efectivoContado, cambioQueQueda, 2);
  const efectivo = Number(bruto) > 0 ? bruto : '0';
  return { efectivo, electronico, total: addDecimal(efectivo, electronico, 2) };
}
