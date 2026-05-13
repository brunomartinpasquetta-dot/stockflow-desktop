/**
 * Obtención del par de claves RSA usado para firmar/verificar los JWT de licencia.
 *
 * Orden de resolución:
 *  1. Variables de entorno JWT_PRIVATE_KEY / JWT_PUBLIC_KEY (con `\n` escapados).
 *  2. Archivos apps/cloud/.keys/private.pem y public.pem (si existen).
 *  3. Se genera un par RSA-2048 nuevo, se persiste en .keys/ y se devuelve.
 *
 * En producción se recomienda setear las variables de entorno (o montar un
 * volumen persistente para .keys/), para que los tokens emitidos sigan siendo
 * válidos entre redeploys.
 */
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface JwtKeys {
  privateKey: string;
  publicKey: string;
}

function unescapeNewlines(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const keysDir = path.resolve(here, '..', '.keys');
const privatePath = path.join(keysDir, 'private.pem');
const publicPath = path.join(keysDir, 'public.pem');

export function getJwtKeys(): JwtKeys {
  const envPriv = process.env.JWT_PRIVATE_KEY;
  const envPub = process.env.JWT_PUBLIC_KEY;
  if (envPriv && envPub) {
    return { privateKey: unescapeNewlines(envPriv), publicKey: unescapeNewlines(envPub) };
  }

  if (existsSync(privatePath) && existsSync(publicPath)) {
    return {
      privateKey: readFileSync(privatePath, 'utf8'),
      publicKey: readFileSync(publicPath, 'utf8'),
    };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  try {
    mkdirSync(keysDir, { recursive: true });
    writeFileSync(privatePath, privateKey, { mode: 0o600 });
    writeFileSync(publicPath, publicKey);
  } catch {
    // Si el FS es de sólo lectura (algunos PaaS), seguimos en memoria.
  }

  return { privateKey, publicKey };
}
