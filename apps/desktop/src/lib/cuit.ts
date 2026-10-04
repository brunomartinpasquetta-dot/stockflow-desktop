/**
 * Validación de CUIT/CUIL (réplica de la de @stockflow/shared; se reimplementa
 * acá para no arrastrar el grafo de @stockflow/db/core al programa del renderer).
 */
const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]

function normalizeCUIT(cuit: string): string {
  return cuit.replace(/[^0-9]/g, '')
}

export function validateCUIT(cuit: string): boolean {
  const clean = normalizeCUIT(cuit)
  if (clean.length !== 11) return false
  if (/^(\d)\1{10}$/.test(clean)) return false
  let sum = 0
  for (let i = 0; i < 10; i++) {
    sum += Number(clean.charAt(i)) * (WEIGHTS[i] ?? 0)
  }
  let check = 11 - (sum % 11)
  if (check === 11) check = 0
  if (check === 10) check = 9
  return check === Number(clean.charAt(10))
}
