/**
 * Tipos compartidos del cliente de licencias.
 */

export type LicensePlan = 'basic' | 'pro';

/**
 * Edición de StockFlow: 'comun' (todos los comercios de hoy) o
 * 'multisucursal'. Sale del claim `edicion` del JWT; sin claim = común.
 */
export type Edicion = 'comun' | 'multisucursal';

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
  /**
   * Edición vigente. 'comun' salvo que el token traiga edicion='multisucursal'
   * (o el override de desarrollo, sólo sin empaquetar: ver funciones.ts).
   */
  edicion: Edicion;
  lastError: string | null;
}

/**
 * Estado del interruptor "Edición Multisucursal (versión de prueba)"
 * (ver funciones.ts). `disponible` sólo con una versión -alpha/-beta/-rc.
 */
export interface EdicionPruebaEstado {
  disponible: boolean;
  /** El archivo pide multisucursal Y la versión es de prueba. */
  activa: boolean;
  activadaEl: number | null;
  /** La edición sin el interruptor: la de la licencia (o el override de desarrollo). */
  edicionReal: Edicion;
  version: string;
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
  /** 'multisucursal' si el comercio tiene esa edición. Ausente = común. */
  edicion?: string;
  iat: number;
  exp: number;
}
