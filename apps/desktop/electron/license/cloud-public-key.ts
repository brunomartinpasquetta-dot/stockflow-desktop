/**
 * Clave pública RS256 del StockFlow Cloud (producción, VPS api.stockflow.com.ar).
 *
 * NO es secreta: el desktop la usa para verificar OFFLINE la firma del JWT de
 * licencia (ver LicenseManager.parseAndVerify). Debe coincidir con la clave
 * privada con la que firma el cloud (`apps/cloud/.keys/private.pem` en el VPS).
 * Si se rota el par de claves del cloud, hay que actualizar esta constante y
 * publicar un nuevo build del desktop.
 *
 * Se puede sobreescribir en build/runtime con `CLOUD_JWT_PUBLIC_KEY`.
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

/** URL base del cloud de licencias en producción. Override: `CLOUD_API_URL`. */
export const CLOUD_API_URL_DEFAULT = 'https://api.stockflow.com.ar';
