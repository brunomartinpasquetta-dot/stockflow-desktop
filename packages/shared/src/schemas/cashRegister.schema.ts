import { z } from 'zod';

import { idSchema, moneySchema, signedMoneySchema, timestampSchema } from './common';

/** Shape completo de `cash_registers` (matches DB). */
export const CashRegisterSchema = z.object({
  id: idSchema,
  number: z.number().int().nonnegative(),
  openDate: timestampSchema,
  closeDate: timestampSchema.nullable(),
  openingAmount: moneySchema,
  closingAmount: signedMoneySchema.nullable(),
  status: z.enum(['open', 'closed']),
  userId: idSchema,
  notes: z.string().optional(), // diferencia de arqueo, se guarda como texto
  createdAt: timestampSchema,
});

/** Abrir caja. */
export const OpenCashRegisterSchema = z.object({
  openingAmount: moneySchema.default('0.0000'),
  userId: idSchema,
  /** Terminal que abre la caja. Null = instalación de una sola PC. */
  terminalId: z.string().max(120).nullish(),
  /** Nombre del puesto para el arqueo, ej. "Caja 1 — Mostrador". */
  terminalName: z.string().max(80).nullish(),
});

/** Cerrar caja. */
export const CloseCashRegisterSchema = z.object({
  // El arqueo declara lo que HAY, y puede ser negativo si se pagó de más.
  closingAmount: signedMoneySchema,
  /** Observaciones del cierre (se anteponen a la línea de arqueo automática). */
  notes: z.string().max(500).nullish(),
});

export type CashRegisterOutput = z.infer<typeof CashRegisterSchema>;
export type OpenCashRegisterInput = z.infer<typeof OpenCashRegisterSchema>;
export type CloseCashRegisterInput = z.infer<typeof CloseCashRegisterSchema>;
