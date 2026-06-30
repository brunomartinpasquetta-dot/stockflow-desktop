import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from './common';
import { PaymentInputSchema } from './paymentMethod.schema';

/** Shape completo de `payments` (matches DB). Una cobranza puede generar N filas. */
export const PaymentSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  amount: moneySchema,
  date: timestampSchema,
  paymentMethodId: idSchema,
  notes: z.string().nullable(),
  createdAt: timestampSchema,
});

/** Input para registrar una cobranza (posiblemente mixta) contra una cuenta corriente. */
export const CreatePaymentSchema = z.object({
  accountId: idSchema,
  /** Una o más líneas de pago; la suma es el total cobrado. */
  payments: z.array(PaymentInputSchema).min(1, 'Debe registrarse al menos un pago'),
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
  /** Caja donde impacta el ingreso (necesario para el cashMovement de la parte en efectivo). */
  cashRegisterId: idSchema,
  /** Usuario que registra la cobranza. */
  userId: idSchema,
});

/**
 * Input para registrar una cobranza a NIVEL CUENTA: un monto (posiblemente mixto)
 * que se aplica al saldo total del cliente distribuyéndose entre sus comprobantes
 * abiertos (FIFO, del más viejo al más nuevo).
 */
export const CreateAccountPaymentSchema = z.object({
  customerId: idSchema,
  /** Una o más líneas de pago; la suma es el total cobrado. */
  payments: z.array(PaymentInputSchema).min(1, 'Debe registrarse al menos un pago'),
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
  /** Caja donde impacta el ingreso. */
  cashRegisterId: idSchema,
  /** Usuario que registra la cobranza. */
  userId: idSchema,
});

export type PaymentOutput = z.infer<typeof PaymentSchema>;
export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type CreateAccountPaymentInput = z.infer<typeof CreateAccountPaymentSchema>;
