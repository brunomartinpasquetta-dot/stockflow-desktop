/**
 * Token store para credenciales MercadoPago.
 *
 * Estrategia:
 *  - Por defecto usa `safeStorage` de Electron (Keychain en macOS, DPAPI en
 *    Windows, libsecret en Linux con keyring).
 *  - Si safeStorage no está disponible (Linux sin keyring), cae a AES-256-GCM
 *    con clave derivada del `machineId` (menos seguro pero funcional).
 *  - En entornos de test (Node puro, sin Electron), usa un passthrough
 *    "plain:" que NUNCA debe verse en producción.
 *
 * Formato del valor devuelto por `encrypt`:
 *   - `electron:<base64>` cuando viene de safeStorage.
 *   - `aes:<iv:b64>.<tag:b64>.<ciphertext:b64>` cuando es fallback AES.
 *   - `plain:<token>` en tests (sólo si no hay Electron disponible).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

function loadElectronSafeStorage(): SafeStorageLike | null {
  try {
    // createRequire para que el bundler no resuelva 'electron' en entornos donde no existe.
    const req = createRequire(import.meta.url);
    const mod = req('electron') as { safeStorage?: SafeStorageLike };
    if (mod && mod.safeStorage && typeof mod.safeStorage.encryptString === 'function') {
      return mod.safeStorage;
    }
    return null;
  } catch {
    return null;
  }
}

export class MpTokenStore {
  private readonly safeStorage: SafeStorageLike | null;
  private readonly aesKey: Buffer | null;

  constructor(private readonly machineId: string) {
    this.safeStorage = loadElectronSafeStorage();
    // Clave AES derivada del machineId — fallback determinístico.
    this.aesKey = createHash('sha256').update(`stockflow:mp:${machineId}`).digest();
  }

  isAvailable(): boolean {
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) return true;
    return !!this.aesKey;
  }

  encrypt(plain: string): string {
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      const buf = this.safeStorage.encryptString(plain);
      return `electron:${buf.toString('base64')}`;
    }
    if (this.aesKey) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.aesKey, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      console.warn('[MpTokenStore] safeStorage no disponible — usando AES-GCM derivado del machineId');
      return `aes:${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
    }
    // No debería ocurrir.
    return `plain:${plain}`;
  }

  decrypt(encrypted: string): string {
    if (encrypted.startsWith('electron:')) {
      if (!this.safeStorage) {
        throw new Error('MpTokenStore: token cifrado con safeStorage pero Electron no está disponible');
      }
      const buf = Buffer.from(encrypted.slice('electron:'.length), 'base64');
      return this.safeStorage.decryptString(buf);
    }
    if (encrypted.startsWith('aes:')) {
      if (!this.aesKey) throw new Error('MpTokenStore: clave AES no disponible');
      const parts = encrypted.slice('aes:'.length).split('.');
      if (parts.length !== 3) throw new Error('MpTokenStore: formato AES inválido');
      const [ivB64, tagB64, ctB64] = parts;
      const iv = Buffer.from(ivB64!, 'base64');
      const tag = Buffer.from(tagB64!, 'base64');
      const ct = Buffer.from(ctB64!, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.aesKey, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf8');
    }
    if (encrypted.startsWith('plain:')) {
      return encrypted.slice('plain:'.length);
    }
    throw new Error('MpTokenStore: formato de token desconocido');
  }
}
