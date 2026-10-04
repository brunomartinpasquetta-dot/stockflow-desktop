import { desc, eq } from 'drizzle-orm';

import { ConstraintError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { cashRegisters } from '../schema/local';

type Tx = Parameters<Parameters<LocalDatabase['transaction']>[0]>[0];

/**
 * La caja tiene que seguir ABIERTA dentro de la transacción que le mete un
 * movimiento (auditoría sep-2026, A4): si otra terminal la cerró en el medio,
 * ni una venta, ni una cobranza, ni una compra, ni un pago a proveedor ni un
 * ingreso manual pueden entrar a un arqueo ya hecho.
 */
export function exigirCajaAbiertaEnTx(tx: Tx, cashRegisterId: string, operacion: string): void {
  const caja = tx
    .select({ status: cashRegisters.status })
    .from(cashRegisters)
    .where(eq(cashRegisters.id, cashRegisterId))
    .get();
  if (caja?.status !== 'open') {
    throw new ConstraintError(
      'CASH_CLOSED',
      `La caja se cerró mientras se registraba ${operacion}. Abra una caja e intente de nuevo.`,
    );
  }
}

/**
 * Caja ABIERTA que recibe el reverso en efectivo de una anulación cuando la
 * caja original ya cerró.
 *
 * - `cajaDeLaTerminal` informado (string o null): el servicio ya resolvió la
 *   caja de la PC que anula (caja por terminal). Se usa sólo si sigue abierta;
 *   si es null o se cerró, no hay caja: el llamador pide abrir una. Antes se
 *   tomaba "cualquier abierta" y, con varias PC en red, el efectivo salía del
 *   cajón de OTRO puesto.
 * - `undefined`: llamador sin terminal (tests, herramientas): comportamiento
 *   previo, la abierta de número más alto.
 */
export function cajaAbiertaParaReverso(tx: Tx, cajaDeLaTerminal: string | null | undefined): string | null {
  if (cajaDeLaTerminal !== undefined) {
    if (!cajaDeLaTerminal) return null;
    const caja = tx
      .select({ status: cashRegisters.status })
      .from(cashRegisters)
      .where(eq(cashRegisters.id, cajaDeLaTerminal))
      .get();
    return caja?.status === 'open' ? cajaDeLaTerminal : null;
  }
  return (
    tx
      .select({ id: cashRegisters.id })
      .from(cashRegisters)
      .where(eq(cashRegisters.status, 'open'))
      .orderBy(desc(cashRegisters.number))
      .limit(1)
      .get()?.id ?? null
  );
}
