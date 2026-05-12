/**
 * Identificador de máquina: hash SHA-256 estable por PC, cacheado en el JSON store.
 * (Servirá para vincular licencias a una instalación en prompts posteriores.)
 */
import { createHash } from 'node:crypto';
import os from 'node:os';

import { JsonStore } from './json-store';

interface MachineSchema extends Record<string, unknown> {
  machineId?: string;
}

function firstExternalMac(): string {
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    if (!list) continue;
    for (const info of list) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return info.mac;
      }
    }
  }
  return '';
}

export function computeMachineId(): string {
  let username = 'unknown';
  try {
    username = os.userInfo().username;
  } catch {
    // entornos sin información de usuario (algunos sandboxes)
  }
  return createHash('sha256')
    .update(`${os.hostname()}|${username}|${firstExternalMac()}`)
    .digest('hex');
}

/** Devuelve el machineId, generándolo y cacheándolo si no existía. */
export function getMachineId(): string {
  const store = new JsonStore<MachineSchema>('stockflow');
  const cached = store.get('machineId');
  if (typeof cached === 'string' && cached.length === 64) return cached;
  const id = computeMachineId();
  store.set('machineId', id);
  return id;
}
