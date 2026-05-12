import { z } from 'zod';

import { idSchema, moneySchema, qtySchema, timestampSchema, vatRateSchema } from './common';

/** Shape completo de `sale_lines` (matches DB). */
export const SaleLineSchema = z.object({
  id: idSchema,
  saleId: idSchema,
  articleId: idSchema,
  lineNumber: z.number().int().positive(),
  quantity: qtySchema,
  unitPrice: moneySchema,
  discount: moneySchema,
  vatRate: z.string(),
  lineTotal: moneySchema,
  createdAt: timestampSchema,
});

/**
 * Línea tal como la envía el front al crear una venta: sólo articleId, cantidad,
 * precio unitario y (opcional) descuento / IVA. `saleId`, `lineNumber` y `lineTotal`
 * los completa el repositorio dentro de la transacción.
 */
export const CreateSaleLineInputSchema = z.object({
  articleId: idSchema,
  quantity: qtySchema,
  unitPrice: moneySchema,
  discount: moneySchema.default('0.0000'),
  vatRate: vatRateSchema.default('21.00'),
});

export type SaleLineOutput = z.infer<typeof SaleLineSchema>;
export type CreateSaleLineInput = z.infer<typeof CreateSaleLineInputSchema>;
