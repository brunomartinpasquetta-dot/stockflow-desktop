/**
 * Secreto de sesión persistente (firma de los tokens de AuthService).
 *
 * Se guarda cifrado con `safeStorage` (clave gestionada por el OS) cuando está
 * disponible; si no, se cae a texto plano en el JSON store (dev / plataformas
 * sin keychain). El secreto se publica en `process.env.STOCKFLOW_SESSION_SECRET`
 * para que `@stockflow/core` lo lea.
 */
import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';

import { JsonStore } from './json-store';

interface SecretsSchema extends Record<string, unknown> {
  /** secreto cifrado con safeStorage, en base64 */
  sessionSecretEnc?: string;
  /** secreto en texto plano (sólo si safeStorage no está disponible) */
  sessionSecret?: string;
}

function newSecret(): string {
  return randomBytes(64).toString('hex');
}

/** Lee o genera+persiste el secreto de sesión. */
export function getOrCreateSessionSecret(): string {
  const store = new JsonStore<SecretsSchema>('stockflow');
  const canEncrypt = safeStorage.isEncryptionAvailable();

  if (canEncrypt) {
    const enc = store.get('sessionSecretEnc');
    if (enc) {
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch {
        // blob corrupto o cambió la clave del OS: se regenera abajo.
      }
    }
  } else {
    const plain = store.get('sessionSecret');
    if (plain) return plain;
  }

  const fresh = newSecret();
  if (canEncrypt) {
    store.set('sessionSecretEnc', safeStorage.encryptString(fresh).toString('base64'));
    store.delete('sessionSecret');
  } else {
    store.set('sessionSecret', fresh);
  }
  return fresh;
}

/** Resuelve el secreto y lo publica en el entorno para @stockflow/core. */
export function applySessionSecret(): string {
  const secret = getOrCreateSessionSecret();
  process.env.STOCKFLOW_SESSION_SECRET = secret;
  return secret;
}
