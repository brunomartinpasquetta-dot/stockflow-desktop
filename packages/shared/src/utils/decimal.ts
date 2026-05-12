/**
 * Aritmética sobre decimales representados como string (la DB guarda decimales
 * como TEXT para precisión exacta). Para el MVP usamos `Number` + `toFixed`,
 * que es suficiente para los rangos de un PDV.
 *
 * TODO: migrar a big.js / decimal.js si hace falta más precisión (montos grandes,
 * acumulación de muchos decimales, etc.).
 */

/** Cantidad de decimales por defecto para montos de dinero. */
export const MONEY_DECIMALS = 4;
/** Cantidad de decimales por defecto para cantidades/stock. */
export const QTY_DECIMALS = 3;

function toNumber(value: string | number): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new RangeError(`Valor decimal inválido: ${JSON.stringify(value)}`);
  }
  return n;
}

/** Valida y normaliza un valor a string con `decimals` decimales fijos. */
export function decimalString(value: string | number, decimals = MONEY_DECIMALS): string {
  return toNumber(value).toFixed(decimals);
}

/** Suma `a + b` y devuelve el resultado normalizado a `decimals` decimales. */
export function addDecimal(a: string | number, b: string | number, decimals = MONEY_DECIMALS): string {
  return (toNumber(a) + toNumber(b)).toFixed(decimals);
}

/** Resta `a - b`. */
export function subDecimal(a: string | number, b: string | number, decimals = MONEY_DECIMALS): string {
  return (toNumber(a) - toNumber(b)).toFixed(decimals);
}

/** Multiplica `a * b`. */
export function mulDecimal(a: string | number, b: string | number, decimals = MONEY_DECIMALS): string {
  return (toNumber(a) * toNumber(b)).toFixed(decimals);
}

/** Compara dos decimales: -1 si a<b, 0 si igual, 1 si a>b. */
export function cmpDecimal(a: string | number, b: string | number): -1 | 0 | 1 {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na < nb) return -1;
  if (na > nb) return 1;
  return 0;
}

/** Indica si `a >= b`. */
export function gteDecimal(a: string | number, b: string | number): boolean {
  return cmpDecimal(a, b) >= 0;
}

/** Suma una lista de decimales. */
export function sumDecimals(values: Array<string | number>, decimals = MONEY_DECIMALS): string {
  return values.reduce<number>((acc, v) => acc + toNumber(v), 0).toFixed(decimals);
}
