/**
 * Token de sesión local (JWT HS256 hecho a mano con `node:crypto`).
 *
 * Es deliberadamente mínimo: la app de escritorio corre local, no necesitamos
 * una librería de JWT completa. El secreto sale de `STOCKFLOW_SESSION_SECRET`
 * (en producción, el proceso main de Electron debe inyectar uno persistente
 * por instalación).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { UserRole } from '@stockflow/shared';

const SECRET = process.env.STOCKFLOW_SESSION_SECRET ?? 'stockflow-dev-secret-change-in-production';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 horas

export interface SessionPayload {
  /** id del usuario */
  sub: string;
  username: string;
  role: UserRole;
  /** issued-at (segundos unix) */
  iat: number;
  /** expiración (segundos unix) */
  exp: number;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(headerAndBody: string): string {
  return createHmac('sha256', SECRET).update(headerAndBody).digest('base64url');
}

/** Firma un token de sesión para el usuario dado. */
export function signSession(
  data: Pick<SessionPayload, 'sub' | 'username' | 'role'>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { ...data, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

/** Verifica firma + expiración. Devuelve el payload o `null` si el token es inválido. */
export function verifySession(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${body}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
