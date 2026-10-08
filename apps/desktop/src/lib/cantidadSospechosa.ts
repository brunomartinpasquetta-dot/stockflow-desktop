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

/** A partir de acá una cantidad en un renglón deja de ser creíble para un comercio. */
export const CANTIDAD_ALTA = 10_000;

export type MotivoSospecha = 'parece-codigo' | 'muy-alta';

/**
 * `esCodigoConocido` permite avisar con certeza cuando lo tipeado es el código
 * de barras de un artículo del padrón: ahí no hay duda de que fue un escaneo.
 */
export function cantidadSospechosa(
  cantidad: string | number,
  esCodigoConocido: (valor: string) => boolean = () => false,
): MotivoSospecha | null {
  const texto = String(cantidad ?? '').trim();
  if (texto === '') return null;
  const n = Number(texto.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const soloDigitos = /^\d+$/.test(texto);
  // Un código de barras del padrón tipeado como cantidad: no hay duda.
  if (soloDigitos && esCodigoConocido(texto)) return 'parece-codigo';
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
