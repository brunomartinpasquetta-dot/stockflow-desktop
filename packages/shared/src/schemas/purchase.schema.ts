import { z } from 'zod';

import { CreatePurchaseLineInputSchema } from './purchaseLine.schema';
import { PaymentInputSchema } from './paymentMethod.schema';
import { idSchema, moneySchema, timestampSchema, voucherTypeSchema } from './common';

const purchasePaymentTypeSchema = z.enum(['cash', 'credit']);
const purchaseStatusSchema = z.enum(['completed', 'voided', 'pending']);

/** Shape completo de `purchases` (matches DB). */
export const PurchaseSchema = z.object({
  id: idSchema,
  number: z.number().int().nonnegative(),
  type: voucherTypeSchema,
  supplierInvoiceNumber: z.string().nullable(),
  date: timestampSchema,
  supplierId: idSchema,
  paymentType: purchasePaymentTypeSchema,
  subtotal: moneySchema,
  discount: moneySchema,
  vatAmount: moneySchema,
  total: moneySchema,
  status: purchaseStatusSchema,
  updatedPricesOnSave: z.boolean(),
  notes: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** Cabecera de compra tal como llega del front. */
export const CreatePurchaseSchema = z.object({
  type: voucherTypeSchema,
  supplierInvoiceNumber: z.string().nullish(),
  supplierId: idSchema,
  paymentType: purchasePaymentTypeSchema,
  discount: moneySchema.default('0.0000'),
  updatedPricesOnSave: z.boolean().default(false),
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
});

/** Compra + líneas (mínimo 1 línea) + pagos (N; sólo si es contado). */
export const CreatePurchaseWithLinesSchema = CreatePurchaseSchema.extend({
  lines: z
    .array(CreatePurchaseLineInputSchema)
    .min(1, 'La compra debe tener al menos una línea'),
  /** Pagos de la compra (cuando es contado). Vacío si es a cuenta del proveedor. */
  payments: z.array(PaymentInputSchema).default([]),
  /** Si se paga en efectivo, caja donde impacta el egreso (opcional). */
  cashRegisterId: idSchema.nullish(),
  /** Usuario que registra la compra (necesario si se genera el movimiento de caja). */
  userId: idSchema.nullish(),
});

export const UpdatePurchaseSchema = CreatePurchaseSchema.partial();

export type PurchaseOutput = z.infer<typeof PurchaseSchema>;
export type CreatePurchaseInput = z.infer<typeof CreatePurchaseSchema>;
export type CreatePurchaseWithLinesInput = z.infer<typeof CreatePurchaseWithLinesSchema>;
export type UpdatePurchaseInput = z.infer<typeof UpdatePurchaseSchema>;
