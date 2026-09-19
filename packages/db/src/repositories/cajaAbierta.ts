import { eq } from 'drizzle-orm';

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
