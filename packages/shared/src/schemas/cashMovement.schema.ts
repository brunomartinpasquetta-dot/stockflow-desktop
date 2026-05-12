import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from './common';

/** Shape completo de `cash_movements` (matches DB). */
export const CashMovementSchema = z.object({
  id: idSchema,
  cashRegisterId: idSchema,
  type: z.enum(['income', 'expense']),
  description: z.string().min(1),
  amount: moneySchema,
  date: timestampSchema,
  userId: idSchema,
  relatedSaleId: idSchema.nullable(),
  relatedPurchaseId: idSchema.nullable(),
  createdAt: timestampSchema,
});

/** Input para registrar un movimiento manual de caja. */
export const CreateCashMovementSchema = z.object({
  cashRegisterId: idSchema,
  type: z.enum(['income', 'expense']),
  description: z.string().min(1).max(200),
  amount: moneySchema,
  userId: idSchema,
  date: timestampSchema.optional(),
  relatedSaleId: idSchema.nullish(),
  relatedPurchaseId: idSchema.nullish(),
});

export const UpdateCashMovementSchema = CreateCashMovementSchema.partial();

export type CashMovementOutput = z.infer<typeof CashMovementSchema>;
export type CreateCashMovementInput = z.infer<typeof CreateCashMovementSchema>;
export type UpdateCashMovementInput = z.infer<typeof UpdateCashMovementSchema>;
