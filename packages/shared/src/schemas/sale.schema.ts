import { z } from 'zod';

import { CreateSaleLineInputSchema } from './saleLine.schema';
import {
  idSchema,
  moneySchema,
  timestampSchema,
  voucherTypeSchema,
} from './common';

const paymentTypeSchema = z.enum(['cash', 'card', 'mixed', 'account']);
const saleStatusSchema = z.enum(['completed', 'voided', 'pending']);

/** Shape completo de `sales` (matches DB). */
export const SaleSchema = z.object({
  id: idSchema,
  number: z.number().int().nonnegative(),
  type: voucherTypeSchema,
  date: timestampSchema,
  customerId: idSchema,
  sellerId: idSchema,
  cashRegisterId: idSchema,
  paymentType: paymentTypeSchema,
  cardId: idSchema.nullable(),
  cardAmount: moneySchema.nullable(),
  subtotal: moneySchema,
  discount: moneySchema,
  vatAmount: moneySchema,
  total: moneySchema,
  status: saleStatusSchema,
  afipCAE: z.string().nullable(),
  afipExpiry: timestampSchema.nullable(),
  afipObservations: z.string().nullable(),
  afipQrUrl: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * Cabecera de venta tal como llega del front. `number`, importes calculados,
 * `status` y `date` los completa el repositorio.
 */
export const CreateSaleSchema = z.object({
  type: voucherTypeSchema,
  customerId: idSchema,
  sellerId: idSchema,
  cashRegisterId: idSchema,
  paymentType: paymentTypeSchema,
  cardId: idSchema.nullish(),
  cardAmount: moneySchema.nullish(),
  discount: moneySchema.default('0.0000'),
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
});

/** Venta + líneas (mínimo 1 línea). */
export const CreateSaleWithLinesSchema = CreateSaleSchema.extend({
  lines: z.array(CreateSaleLineInputSchema).min(1, 'La venta debe tener al menos una línea'),
}).superRefine((data, ctx) => {
  if (data.paymentType === 'card' || data.paymentType === 'mixed') {
    if (!data.cardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cardId'],
        message: 'cardId es obligatorio cuando el pago incluye tarjeta',
      });
    }
  }
});

export const UpdateSaleSchema = CreateSaleSchema.partial();

export type SaleOutput = z.infer<typeof SaleSchema>;
export type CreateSaleInput = z.infer<typeof CreateSaleSchema>;
export type CreateSaleWithLinesInput = z.infer<typeof CreateSaleWithLinesSchema>;
export type UpdateSaleInput = z.infer<typeof UpdateSaleSchema>;
