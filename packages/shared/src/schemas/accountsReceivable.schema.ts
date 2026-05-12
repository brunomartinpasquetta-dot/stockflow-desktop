import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from './common';

/** Shape completo de `accounts_receivable` (matches DB). */
export const AccountReceivableSchema = z.object({
  id: idSchema,
  customerId: idSchema,
  saleId: idSchema,
  total: moneySchema,
  balance: moneySchema,
  status: z.enum(['open', 'paid', 'partial']),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** Input para abrir una cuenta corriente a partir de una venta. */
export const CreateAccountReceivableSchema = z.object({
  customerId: idSchema,
  saleId: idSchema,
  total: moneySchema,
});

export const UpdateAccountReceivableSchema = z.object({
  balance: moneySchema.optional(),
  status: z.enum(['open', 'paid', 'partial']).optional(),
});

export type AccountReceivableOutput = z.infer<typeof AccountReceivableSchema>;
export type CreateAccountReceivableInput = z.infer<typeof CreateAccountReceivableSchema>;
export type UpdateAccountReceivableInput = z.infer<typeof UpdateAccountReceivableSchema>;
