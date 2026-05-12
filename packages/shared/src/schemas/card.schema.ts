import { z } from 'zod';

import { idSchema, pctSchema, timestampSchema } from './common';

/** Shape completo de `cards` (matches DB). */
export const CardSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  commissionPct: pctSchema,
  discountPct: pctSchema,
  active: z.boolean(),
  createdAt: timestampSchema,
});

export const CreateCardSchema = z.object({
  name: z.string().min(1).max(60),
  commissionPct: pctSchema.default('0.00'),
  discountPct: pctSchema.default('0.00'),
  active: z.boolean().default(true),
});

export const UpdateCardSchema = CreateCardSchema.partial();

export type CardOutput = z.infer<typeof CardSchema>;
export type CreateCardInput = z.infer<typeof CreateCardSchema>;
export type UpdateCardInput = z.infer<typeof UpdateCardSchema>;
