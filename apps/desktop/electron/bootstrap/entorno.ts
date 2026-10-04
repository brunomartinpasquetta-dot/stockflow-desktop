/**
 * Puertos y opciones que se pueden cambiar por variable de entorno.
 *
 * Para qué: correr DOS StockFlow en la misma PC sin que choquen con el del
 * comercio (el sandbox de dos locales, `scripts/sandbox-dos-locales.mjs`). Sin
 * las variables todo queda exactamente como siempre: 7788 para la puerta del
 * acceso remoto, 7790 para el teléfono y anuncio por mDNS en modo servidor.
 *
 *   STOCKFLOW_PUERTO_TUNEL=17788   puerta local del acceso remoto (127.0.0.1)
 *   STOCKFLOW_PUERTO_FOTOS=17790   escucha del teléfono (facturas por foto)
 *   STOCKFLOW_SIN_MDNS=1           el servidor no se anuncia en la red local
 *
 * Sólo mueven puertos o apagan un anuncio: no habilitan ninguna función ni
 * relajan ningún control, así que valen también empaquetada.
 */

type Entorno = Record<string, string | undefined>;

/**
 * Puerto pedido por variable de entorno, o el de siempre. Un valor que no sea
 * un entero entre 1024 y 65535 se ignora (un typo no deja la app sin puerto).
 */
export function puertoDeEntorno(nombre: string, porDefecto: number, env: Entorno = process.env): number {
  const crudo = env[nombre];
  if (crudo === undefined || crudo.trim() === '') return porDefecto;
  if (!/^\d+$/.test(crudo.trim())) return porDefecto;
  const n = Number(crudo.trim());
  return n >= 1024 && n <= 65535 ? n : porDefecto;
}

/** ¿Hay que apagar el anuncio mDNS del servidor? Sólo con un valor afirmativo explícito. */
export function sinMdns(env: Entorno = process.env): boolean {
  return /^(1|si|sí|true)$/i.test((env.STOCKFLOW_SIN_MDNS ?? '').trim());
}
