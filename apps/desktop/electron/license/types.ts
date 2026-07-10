/**
 * Tipos compartidos del cliente de licencias.
 */

export type LicensePlan = 'basic' | 'pro';

/**
 * Estado de la licencia:
 *  - 'unlicensed': no hay licencia válida (sin activar / token expirado / inválido).
 *  - 'active': licencia válida y al día → la app opera normalmente.
 *  - 'readOnly': suscripción suspendida → la app abre pero no permite escribir.
 *  - 'revoked': licencia revocada (suscripción cancelada) → no se puede usar la
 *    app; a efectos de ruteo se trata como 'unlicensed' pero con mensaje distinto.
 */
export type LicenseStatus = 'unlicensed' | 'active' | 'readOnly' | 'revoked';

export interface LicenseState {
  status: LicenseStatus;
  plan: LicensePlan | null;
  expiresAt: number | null;
  licenseKey: string | null;
  tenantName: string | null;
  /** Nombre del titular/cliente (full_name del tenant cloud). */
  fullName: string | null;
  /**
   * ID del tenant según el JWT de licencia (`tid`). En master license / dev
   * mode es `'OWNER'`. Se usa, por ejemplo, para armar la URL real del webhook
   * de MercadoPago.
   */
  tenantId: string | null;
  /** true si es una PRUEBA GRATIS (30 días). expiresAt = fin de la prueba. */
  trial?: boolean;
  lastError: string | null;
}

/** Datos que el usuario carga para arrancar la prueba gratis. */
export interface TrialInput {
  fullName: string;
  companyName: string;
  phone: string;
}

/** Payload del JWT de licencia (firmado RS256 por el cloud). */
export interface LicenseJwtPayload {
  sub: string;
  tid: string;
  plan: LicensePlan;
  lk: string;
  /** 'trial' cuando la licencia es una prueba gratis. Ausente = paga. */
  kind?: 'trial';
  /** Fin de la PRUEBA en epoch-segundos (el exp del JWT es corto y renovable). */
  texp?: number;
  iat: number;
  exp: number;
}
