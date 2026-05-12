/**
 * Validación de CUIT/CUIL argentino (11 dígitos con dígito verificador módulo 11).
 */

const WEIGHTS: readonly number[] = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Quita guiones/espacios y deja sólo dígitos. */
export function normalizeCUIT(cuit: string): string {
  return cuit.replace(/[^0-9]/g, '');
}

/**
 * Devuelve `true` si `cuit` es un CUIT/CUIL válido (formato + dígito verificador).
 * Acepta el valor con o sin guiones (ej. "20-12345678-3" o "20123456783").
 */
export function validateCUIT(cuit: string): boolean {
  const clean = normalizeCUIT(cuit);
  if (clean.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(clean)) return false; // todos los dígitos iguales

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Number(clean.charAt(i)) * (WEIGHTS[i] ?? 0);
  }
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9; // caso borde de AFIP

  return check === Number(clean.charAt(10));
}

/** Formatea un CUIT a "XX-XXXXXXXX-X". Devuelve el input original si no tiene 11 dígitos. */
export function formatCUIT(cuit: string): string {
  const clean = normalizeCUIT(cuit);
  if (clean.length !== 11) return cuit;
  return `${clean.slice(0, 2)}-${clean.slice(2, 10)}-${clean.slice(10)}`;
}
