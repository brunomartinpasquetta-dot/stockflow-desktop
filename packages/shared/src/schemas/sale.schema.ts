import { z } from 'zod';

import { CreateSaleLineInputSchema } from './saleLine.schema';
import { PaymentInputSchema } from './paymentMethod.schema';
import {
  idSchema,
  idempotencyKeySchema,
  moneySchema,
  timestampSchema,
  voucherTypeSchema,
} from './common';

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
  isAccountSale: z.boolean(),
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
  /** true = venta a cuenta corriente (no lleva pagos). */
  isAccountSale: z.boolean().default(false),
  discount: moneySchema.default('0.0000'),
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
  /**
   * Límite de crédito del cliente al momento de la venta (BUG-S-RACE): se
   * revalida DENTRO de la transacción de `createWithLines` para evitar que dos
   * ventas a cuenta concurrentes superen el límite. '0.0000' (o ausente) = sin
   * límite.
   */
  creditLimit: moneySchema.optional(),
  /** Clave del intento de cobro (ver `idempotencyKeySchema`). */
  idempotencyKey: idempotencyKeySchema.nullish(),
});

/** Venta + líneas (mínimo 1) + pagos (N; vacío sólo si es a cuenta corriente). */
export const CreateSaleWithLinesSchema = CreateSaleSchema.extend({
  lines: z
    .array(CreateSaleLineInputSchema)
    .min(1, 'La venta debe tener al menos una línea'),
  payments: z.array(PaymentInputSchema).default([]),
}).superRefine((data, ctx) => {
  if (data.isAccountSale) {
    if (data.payments.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payments'],
        message: 'Una venta a cuenta corriente no lleva pagos',
      });
    }
  } else {
    if (data.payments.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payments'],
        message: 'La venta debe registrar al menos un pago',
      });
    }
    // El monto>0 de cada pago YA lo valida PaymentInputSchema (línea 62): para
    // cuando este superRefine corre, data.payments ya pasó ese refine ítem por
    // ítem. Repetirlo acá era inalcanzable.
  }
});

export type SaleOutput = z.infer<typeof SaleSchema>;
export type CreateSaleInput = z.infer<typeof CreateSaleSchema>;
export type CreateSaleWithLinesInput = z.infer<typeof CreateSaleWithLinesSchema>;
