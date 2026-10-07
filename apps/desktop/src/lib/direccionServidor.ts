/**
 * Dirección del servidor de StockFlow vista desde una terminal.
 *
 * En la red local la terminal la arma como `http://<ip>:<puerto>`. Por el
 * ACCESO REMOTO se entra con `https://…` y sin puerto: armarla a mano daba
 * `http://<host>:7777`, que el navegador bloquea por contenido mixto. Por eso,
 * cuando la página la sirvió el propio servidor, manda esa dirección.
 */
export function direccionDelServidor(ip: string, puerto: number, servida?: string | null): string {
  const base = servida && /^https?:\/\//i.test(servida) ? servida : `http://${ip}:${puerto}`;
  return base.replace(/\/+$/, '');
}

/** Dirección del chequeo de conexión (de ahí sale también la licencia). */
export function urlDePing(ip: string, puerto: number, servida?: string | null): string {
  return `${direccionDelServidor(ip, puerto, servida)}/lan/ping`;
}
