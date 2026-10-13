/**
 * Importe en pesos para mostrar en un aviso: «$30.569,00» en vez de «30569.00».
 * Para mensajes que arma el servidor (reglas de negocio) y que el usuario lee
 * tal cual (Bruno, 13-oct-2026: «los números del mensaje no están bien escritos,
 * falta el punto»). La pantalla tiene su propio formateador; éste es el mismo
 * formato, sin depender del navegador.
 */
export function formatPesos(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '$0,00';
  const fijo = Math.abs(n).toFixed(2);
  const [entero, dec] = fijo.split('.');
  const conMiles = entero!.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}$${conMiles},${dec}`;
}
