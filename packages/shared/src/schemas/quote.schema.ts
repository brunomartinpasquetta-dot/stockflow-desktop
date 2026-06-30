import { z } from 'zod';

import { PaymentInputSchema } from './paymentMethod.schema';
import {
  idSchema,
  moneySchema,
  qtySchema,
  timestampSchema,
  vatRateSchema,
  voucherTypeSchema,
} from './common';

const quoteStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'converted']);

/** Shape completo de `quote_lines` (matches DB). */
export const QuoteLineSchema = z.object({
  id: idSchema,
  quoteId: idSchema,
  articleId: idSchema,
  lineNumber: z.number().int().positive(),
  quantity: qtySchema,
  unitPrice: moneySchema,
  discount: moneySchema,
  vatRate: z.string(),
  lineTotal: moneySchema,
  createdAt: timestampSchema,
});

/** Shape completo de `quotes` (matches DB). */
export const QuoteSchema = z.object({
  id: idSchema,
  number: z.number().int().nonnegative(),
  type: voucherTypeSchema,
  date: timestampSchema,
  customerId: idSchema,
  sellerId: idSchema,
  validityDays: z.number().int().positive(),
  subtotal: moneySchema,
  discount: moneySchema,
  vatAmount: moneySchema,
  total: moneySchema,
  status: quoteStatusSchema,
  saleId: idSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * Línea tal como la envía el front al crear un presupuesto. El precio unitario
 * queda CONGELADO (lo que se cotizó). `lineTotal` lo calcula el repositorio.
 */
export const CreateQuoteLineInputSchema = z.object({
  articleId: idSchema,
  quantity: qtySchema.refine((v) => Number(v) > 0, 'debe ser mayor a 0'),
  unitPrice: moneySchema.refine((v) => Number(v) > 0, 'debe ser mayor a 0'),
  discount: moneySchema.default('0.0000'),
  vatRate: vatRateSchema.default('21.00'),
});

/**
 * Cabecera de presupuesto. `sellerId` lo completa el servicio desde la sesión;
 * `number`, importes y `status` los completa el repositorio. NO toca stock ni caja.
 */
export const CreateQuoteWithLinesSchema = z.object({
  type: voucherTypeSchema.default('B'),
  customerId: idSchema,
  sellerId: idSchema,
  validityDays: z.number().int().positive().default(30),
  discount: moneySchema.default('0.0000'),
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
  lines: z
    .array(CreateQuoteLineInputSchema)
    .min(1, 'El presupuesto debe tener al menos una línea'),
});

/** Input del front al crear/editar (sin sellerId; lo pone el servicio). */
export const CreateQuoteInputSchema = CreateQuoteWithLinesSchema.omit({ sellerId: true });

/** Conversión de un presupuesto en venta. La caja la resuelve el SalesService. */
export const ConvertQuoteToSaleSchema = z.object({
  quoteId: idSchema,
  isAccountSale: z.boolean().default(false),
  /** true = re-resolver precios actuales del artículo; false = usar los congelados. */
  refreshPrices: z.boolean().default(false),
  payments: z.array(PaymentInputSchema).default([]),
});

export type QuoteLineOutput = z.infer<typeof QuoteLineSchema>;
export type QuoteOutput = z.infer<typeof QuoteSchema>;
export type CreateQuoteLineInput = z.infer<typeof CreateQuoteLineInputSchema>;
export type CreateQuoteWithLinesInput = z.infer<typeof CreateQuoteWithLinesSchema>;
export type CreateQuoteInput = z.infer<typeof CreateQuoteInputSchema>;
export type ConvertQuoteToSaleInput = z.infer<typeof ConvertQuoteToSaleSchema>;
