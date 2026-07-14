import { z } from 'zod';

import { idSchema, moneySchema, qtySchema } from './common';

/**
 * Promociones/combos. La promo se vende como un artículo "espejo" (marca
 * PROMO); estos schemas validan el ALTA/MODIFICACIÓN desde el ABM: nombre y
 * precio van al artículo espejo, los items definen qué stock se descuenta.
 */
export const PromotionItemInputSchema = z.object({
  articleId: idSchema,
  /** Unidades del componente por cada promo vendida (acepta decimales). */
  quantity: qtySchema,
});

export const CreatePromotionSchema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 letras').max(200),
  /** Precio de venta de la promo (va a las 3 listas del artículo espejo). */
  price: moneySchema,
  items: z.array(PromotionItemInputSchema).min(1, 'La promo necesita al menos un artículo'),
  notes: z.string().max(500).nullish(),
});

export const UpdatePromotionSchema = CreatePromotionSchema.partial().extend({
  active: z.boolean().optional(),
});

export type PromotionItemInput = z.infer<typeof PromotionItemInputSchema>;
export type CreatePromotionInput = z.infer<typeof CreatePromotionSchema>;
export type UpdatePromotionInput = z.infer<typeof UpdatePromotionSchema>;
