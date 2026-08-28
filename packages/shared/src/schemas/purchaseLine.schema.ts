import { z } from 'zod';

import { idSchema, moneySchema, qtySchema, timestampSchema, vatRateSchema } from './common';

/** Shape completo de `purchase_lines` (matches DB). */
export const PurchaseLineSchema = z.object({
  id: idSchema,
  purchaseId: idSchema,
  articleId: idSchema,
  lineNumber: z.number().int().positive(),
  quantity: qtySchema,
  costPrice: moneySchema,
  salePrice: moneySchema,
  vatRate: z.string(),
  lineTotal: moneySchema,
  createdAt: timestampSchema,
});

/**
 * Línea de compra tal como llega del front: artículo, cantidad, costo unitario
 * y precio de venta sugerido. `purchaseId`, `lineNumber` y `lineTotal` los
 * completa el repositorio dentro de la transacción.
 */
export const CreatePurchaseLineInputSchema = z.object({
  articleId: idSchema,
  quantity: qtySchema.refine((v) => Number(v) > 0, 'debe ser mayor a 0'),
  costPrice: moneySchema.refine((v) => Number(v) > 0, 'debe ser mayor a 0'),
  salePrice: moneySchema,
  vatRate: vatRateSchema.default('21.00'),
  /**
   * Precios nuevos POR LISTA, ya calculados por el servicio (modo "por
   * utilidad": costo nuevo × margen del artículo, redondeado a peso entero).
   * Sólo se aplican si la compra actualiza precios; ausente = esa lista no se
   * toca. En modo manual el servicio manda sólo `newListPrice1` (= salePrice).
   */
  newListPrice1: moneySchema.optional(),
  newListPrice2: moneySchema.optional(),
  newListPrice3: moneySchema.optional(),
});

export type PurchaseLineOutput = z.infer<typeof PurchaseLineSchema>;
export type CreatePurchaseLineInput = z.infer<typeof CreatePurchaseLineInputSchema>;
