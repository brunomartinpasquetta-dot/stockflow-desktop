import { z } from 'zod';

import { idSchema, importeSchema, pctSchema, timestampSchema } from './common';

/**
 * Comisión del medio de pago: un porcentaje entre 0 y 100 (19-oct-2026: un
 * código de barras tipeado como comisión dejaba una comisión de miles de millones
 * por ciento y el neto cobrado en negativo).
 */
const comisionSchema = pctSchema.refine((v) => Number(v) <= 100, {
  message: 'La comisión debe estar entre 0 y 100.',
  params: { sinRuta: true },
});

/** Tipos de medio de pago. Sólo `cash` puede afectar el arqueo físico. */
export const paymentMethodTypeSchema = z.enum([
  'cash',
  'transfer',
  'debit_card',
  'credit_card',
  'mp',
  'check',
  'other',
]);
export type PaymentMethodType = z.infer<typeof paymentMethodTypeSchema>;

/** Shape completo de `payment_methods` (matches DB). */
export const PaymentMethodSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  type: paymentMethodTypeSchema,
  isPhysicalCash: z.boolean(),
  commissionPct: pctSchema,
  active: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const CreatePaymentMethodSchema = z
  .object({
    name: z.string().min(1).max(60),
    type: paymentMethodTypeSchema,
    isPhysicalCash: z.boolean().default(false),
    commissionPct: comisionSchema.default('0.00'),
    active: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
  })
  .superRefine((d, ctx) => {
    if (d.isPhysicalCash && d.type !== 'cash') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['isPhysicalCash'],
        message: 'Sólo un medio de tipo "efectivo" puede afectar el arqueo físico',
      });
    }
  });

export const UpdatePaymentMethodSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    type: paymentMethodTypeSchema.optional(),
    isPhysicalCash: z.boolean().optional(),
    commissionPct: comisionSchema.optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  });

/** Un pago individual: integrante de una venta (sale_payments) o de una cobranza. */
export const PaymentInputSchema = z.object({
  paymentMethodId: idSchema,
  amount: importeSchema.refine((v) => Number(v) > 0, 'debe ser mayor a 0'),
  reference: z.string().max(60).nullish(),
});
export type PaymentInput = z.infer<typeof PaymentInputSchema>;

export type PaymentMethodOutput = z.infer<typeof PaymentMethodSchema>;
export type CreatePaymentMethodInput = z.infer<typeof CreatePaymentMethodSchema>;
export type UpdatePaymentMethodInput = z.infer<typeof UpdatePaymentMethodSchema>;
