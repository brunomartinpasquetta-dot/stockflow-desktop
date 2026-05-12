import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from './common';

/** Shape completo de `cash_registers` (matches DB). */
export const CashRegisterSchema = z.object({
  id: idSchema,
  number: z.number().int().nonnegative(),
  openDate: timestampSchema,
  closeDate: timestampSchema.nullable(),
  openingAmount: moneySchema,
  closingAmount: moneySchema.nullable(),
  status: z.enum(['open', 'closed']),
  userId: idSchema,
  notes: z.string().optional(), // diferencia de arqueo, se guarda como texto
  createdAt: timestampSchema,
});

/** Abrir caja. */
export const OpenCashRegisterSchema = z.object({
  openingAmount: moneySchema.default('0.0000'),
  userId: idSchema,
});

/** Cerrar caja. */
export const CloseCashRegisterSchema = z.object({
  closingAmount: moneySchema,
  /** Observaciones del cierre (se anteponen a la línea de arqueo automática). */
  notes: z.string().max(500).nullish(),
});

export type CashRegisterOutput = z.infer<typeof CashRegisterSchema>;
export type OpenCashRegisterInput = z.infer<typeof OpenCashRegisterSchema>;
export type CloseCashRegisterInput = z.infer<typeof CloseCashRegisterSchema>;
