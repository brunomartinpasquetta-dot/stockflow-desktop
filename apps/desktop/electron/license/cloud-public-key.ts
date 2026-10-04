/**
 * Clave pública RS256 del StockFlow Cloud (producción, VPS api.stockflow.com.ar).
 *
 * NO es secreta: el desktop la usa para verificar OFFLINE la firma del JWT de
 * licencia (ver LicenseManager.parseAndVerify). Debe coincidir con la clave
 * privada con la que firma el cloud (`apps/cloud/.keys/private.pem` en el VPS).
 * Si se rota el par de claves del cloud, hay que actualizar esta constante y
 * publicar un nuevo build del desktop.
 *
 * Se puede sobreescribir con `CLOUD_JWT_PUBLIC_KEY` SÓLO con la app sin
 * empaquetar (desarrollo, sandbox desde el código): ver `configCloud`.
 */
export const CLOUD_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnnFnmCAxk46aqv0vR8a+
aUYldlPBFyHUq4t1F9ziXgIZ6N7w6ZQlUP1EVufe8VOayXwWqrpOSEkY8Q6IV/PJ
l1iMjR4+u/X8clFoyNCq9FuPXVEn4Rl6GZcQvAfn691XzTicuUaN/w+pj5LCt6TT
d8ACC1+fqtrYdGBbExYzxt/lVDbZF9ifj6WZ3cg8GimbwzvPSHXKkNwVhv6smIH7
f3jJ0HQn6lEIGSXPxwwyYYdySttiK2oJdVbqvEqbF6GNO1U7G6rvDh9SG+TXaHkj
+gZagFpggJgmIfle6XZpvf/P7nIR1zSlQUkb8kn+GNn6e6vIwAq14xlbVJNY2G/i
+wIDAQAB
-----END PUBLIC KEY-----`;

/** URL base del cloud de licencias en producción. Override: `CLOUD_API_URL` (ver `configCloud`). */
export const CLOUD_API_URL_DEFAULT = 'https://stockflow.bpsgsistemas.com';

/** ¿La dirección apunta a esta misma PC? */
function esDireccionLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Clave pública y dirección del cloud de licencias que usa la app.
 *
 * En una app EMPAQUETADA (la de los clientes) la clave pública es SIEMPRE la
 * embebida: si se pudiera cambiar por variable de entorno, cualquiera podría
 * firmarse una licencia propia (con `edicion: 'multisucursal'` y plan pro) y
 * saltear el cloud. La dirección del cloud tampoco se puede cambiar, salvo a
 * esta misma PC (127.0.0.1/localhost): con la clave embebida un servidor
 * falso no puede firmar nada, y así el sandbox empaquetado no sale a
 * internet. Sin empaquetar (desarrollo), las dos variables valen.
 *
 * Recibe `empaquetada` posicional a propósito (license.smoke.ts revisa que
 * main.ts pase `empaquetada: app.isPackaged` una sola vez, al LicenseManager).
 */
export function configCloud(
  esAppEmpaquetada: boolean,
  env: Record<string, string | undefined>,
): { apiUrl: string; publicKeyPem: string } {
  const pem = !esAppEmpaquetada && env.CLOUD_JWT_PUBLIC_KEY ? env.CLOUD_JWT_PUBLIC_KEY : CLOUD_PUBLIC_KEY_PEM;
  const url = env.CLOUD_API_URL;
  const apiUrl = url && (!esAppEmpaquetada || esDireccionLocal(url)) ? url : CLOUD_API_URL_DEFAULT;
  return { apiUrl, publicKeyPem: pem };
}
