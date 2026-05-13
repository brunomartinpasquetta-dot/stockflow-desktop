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
  lastError: string | null;
}

/** Payload del JWT de licencia (firmado RS256 por el cloud). */
export interface LicenseJwtPayload {
  sub: string;
  tid: string;
  plan: LicensePlan;
  lk: string;
  iat: number;
  exp: number;
}
