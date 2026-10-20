/**
 * Freno a la cantidad escaneada por error.
 *
 * Pasó en un comercio (8-oct-2026): el cajero escaneó un código de barras con
 * el cursor dentro del casillero de CANTIDAD. Quedó una compra de 215.841
 * unidades por $485.627.141 — y si se confirma, entra ese stock y ese importe
 * a la caja. La compra se veía normal salvo por el número.
 *
 * No se bloquea: una compra grande de verdad tiene que poder cargarse. Se
 * marca el renglón y se pide confirmar una vez antes de guardar.
 */

import { parseCurrencyInput } from './format';

/** A partir de acá una cantidad en un renglón deja de ser creíble para un comercio. */
export const CANTIDAD_ALTA = 10_000;

export type MotivoSospecha = 'parece-codigo' | 'muy-alta';

/**
 * Sólo es «código de barras» lo que tiene la forma de uno: ocho dígitos o más
 * (EAN-8 para arriba), o un código pegado a una cantidad con decimales. NUNCA
 * se lo compara con los códigos del padrón: los comercios migrados tienen
 * artículos con código interno corto («1», «5», «10») y una cantidad tipeada
 * igual a uno de ellos se descartaba y se agregaba ese artículo a la venta
 * (20-oct-2026).
 */
export function cantidadSospechosa(cantidad: string | number): MotivoSospecha | null {
  const texto = String(cantidad ?? '').trim();
  if (texto === '') return null;
  // Se convierte como lo hace el campo al guardar (puntos de miles, coma decimal): con
  // `Number('1.000.001')` daba NaN, no se consideraba sospechosa y el renglón se guardaba
  // con 1.000.001 unidades (19-oct-2026).
  const n = Number(parseCurrencyInput(texto));
  if (!Number.isFinite(n) || n <= 0) return null;
  // Un código pegado a una cantidad con decimales («10.000» + «7791234567890»): ningún
  // campo admite ocho decimales, así que esa cola es un código leído (19-oct-2026).
  if (/[.,]\d{8,}$/.test(texto)) return 'parece-codigo';
  const soloDigitos = /^\d+$/.test(texto);
  // 8 dígitos o más es, directamente, un código de barras (EAN-8 para arriba).
  if (soloDigitos && texto.length >= 8) return 'parece-codigo';
  if (n >= CANTIDAD_ALTA) return 'muy-alta';
  return null;
}

export function textoSospecha(motivo: MotivoSospecha): string {
  return motivo === 'parece-codigo'
    ? 'Esa cantidad parece un código de barras escaneado por error.'
    : 'Cantidad inusualmente alta.';
}
