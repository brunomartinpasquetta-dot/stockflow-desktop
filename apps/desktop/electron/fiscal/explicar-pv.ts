/**
 * Mensaje claro cuando ARCA rechaza el PUNTO DE VENTA (errores 11002 y 10005).
 *
 * ARCA dice "El punto de venta no se encuentra habilitado a usar en el presente
 * WS" y no aclara cuál recibió ni cuáles tiene: en el mostrador no hay forma de
 * saber si es un número mal cargado, el punto equivocado elegido en Ventas o
 * uno dado de alta con otro sistema (el de StockFácil, Factura en línea…). Se
 * arma el texto con el número que mandó StockFlow y los que ARCA habilitó.
 */

export interface PuntoHabilitado {
  number: number;
  blocked?: boolean;
}

const CODIGOS = /(?:^|[\s|])(11002|10005):/;

/** 11002 / 10005 si el texto de ARCA habla del punto de venta; si no, null. */
export function codigoDePuntoDeVenta(mensaje: string): string | null {
  return CODIGOS.exec(mensaje)?.[1] ?? null;
}

const COMO_DARLO_DE_ALTA =
  'En ARCA: Administración de Puntos de Venta y Domicilios → A/B/M de Puntos de Venta → Agregar, con el sistema «RECE para aplicativo y web services».';

/** `habilitados` es null si no se pudo consultar a ARCA. */
export function explicarPuntoDeVenta(
  puntoVenta: number,
  habilitados: PuntoHabilitado[] | null,
  codigo: string,
): string {
  const cola = ` (ARCA ${codigo})`;
  if (habilitados === null) {
    return `ARCA no aceptó el punto de venta ${puntoVenta}: tiene que estar dado de alta con el sistema «RECE para aplicativo y web services». En Contabilidad → Facturación Electrónica, el botón «Consultar en ARCA» muestra cuáles tiene habilitados.${cola}`;
  }
  const propio = habilitados.find((p) => p.number === puntoVenta);
  if (propio?.blocked) {
    return `El punto de venta ${puntoVenta} figura en ARCA pero está BLOQUEADO. Hay que desbloquearlo en ARCA o usar otro punto de venta.${cola}`;
  }
  if (propio) {
    return `ARCA rechazó el punto de venta ${puntoVenta} aunque figura habilitado para este CUIT. Revise en ARCA que no esté dado de baja y que su domicilio y su actividad estén vigentes.${cola}`;
  }
  const otros = habilitados
    .filter((p) => !p.blocked)
    .map((p) => p.number)
    .sort((a, b) => a - b);
  if (otros.length === 0) {
    return `ARCA no tiene ningún punto de venta habilitado para facturar desde un programa a nombre de este CUIT, y el ${puntoVenta} no sirve. ${COMO_DARLO_DE_ALTA} Después se carga el número en Contabilidad → Facturación Electrónica → Puntos de venta.${cola}`;
  }
  return `El punto de venta ${puntoVenta} no está habilitado en ARCA para facturar desde un programa. Los habilitados para este CUIT son: ${otros.join(', ')}. Cargue uno de esos en Contabilidad → Facturación Electrónica → Puntos de venta (y borre el ${puntoVenta}) o elíjalo en Ventas.${cola}`;
}
