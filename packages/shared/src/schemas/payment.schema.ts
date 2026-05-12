import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from './common';

const paymentMethodSchema = z.enum(['cash', 'transfer', 'card']);

/** Shape completo de `payments` (matches DB). */
export const PaymentSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  amount: moneySchema,
  date: timestampSchema,
  method: paymentMethodSchema,
  notes: z.string().nullable(),
  createdAt: timestampSchema,
});

/** Input para registrar una cobranza contra una cuenta corriente. */
export const CreatePaymentSchema = z.object({
  accountId: idSchema,
  amount: moneySchema,
  method: paymentMethodSchema,
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
  /** Caja donde impacta el ingreso (necesario para generar el cashMovement). */
  cashRegisterId: idSchema,
  /** Usuario que registra la cobranza. */
  userId: idSchema,
});

export type PaymentOutput = z.infer<typeof PaymentSchema>;
export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
