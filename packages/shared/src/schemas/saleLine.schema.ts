import { z } from 'zod';

import { idSchema, moneySchema, qtySchema, timestampSchema, vatRateSchema } from './common';

/** Shape completo de `sale_lines` (matches DB). */
export const SaleLineSchema = z.object({
  id: idSchema,
  saleId: idSchema,
  /** null = artículo rápido: se vendió algo que no está en el catálogo. */
  articleId: idSchema.nullable(),
  /** Descripción escrita a mano. Sólo se usa cuando no hay artículo. */
  description: z.string().nullable(),
  lineNumber: z.number().int().positive(),
  quantity: qtySchema,
  unitPrice: moneySchema,
  discount: moneySchema,
  vatRate: z.string(),
  lineTotal: moneySchema,
  createdAt: timestampSchema,
});

/**
 * Línea tal como la envía el front al crear una venta. `saleId`, `lineNumber` y
 * `lineTotal` los completa el repositorio dentro de la transacción.
 *
 * ARTÍCULO RÁPIDO: la línea puede venir SIN `articleId`, para cobrar algo que no
 * está en el catálogo. En ese caso `description` y `unitPrice` son obligatorios
 * —sin ellos la línea no se podría ni imprimir ni cobrar— y la venta no mueve
 * stock, porque no hay nada en inventario que descontar.
 */
export const CreateSaleLineInputSchema = z
  .object({
    articleId: idSchema.optional(),
    description: z.string().trim().min(1).max(120).optional(),
    quantity: qtySchema.refine((v) => Number(v) > 0, 'debe ser mayor a 0'),
    unitPrice: moneySchema.refine((v) => Number(v) > 0, 'debe ser mayor a 0'),
    discount: moneySchema.default('0.0000'),
    vatRate: vatRateSchema.default('21.00'),
  })
  .superRefine((line, ctx) => {
    if (!line.articleId && !line.description) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['description'],
        message: 'Un artículo rápido necesita una descripción',
      });
    }
  });

export type SaleLineOutput = z.infer<typeof SaleLineSchema>;
export type CreateSaleLineInput = z.infer<typeof CreateSaleLineInputSchema>;
