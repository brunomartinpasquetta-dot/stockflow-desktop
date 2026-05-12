import { z } from 'zod';

import { idSchema, timestampSchema } from './common';

/** Shape completo de `families` (matches DB). */
export const FamilySchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  parentId: idSchema.nullable(),
  createdAt: timestampSchema,
});

export const CreateFamilySchema = z.object({
  name: z.string().min(1).max(100),
  parentId: idSchema.nullish(),
});

export const UpdateFamilySchema = CreateFamilySchema.partial();

export type FamilyOutput = z.infer<typeof FamilySchema>;
export type CreateFamilyInput = z.infer<typeof CreateFamilySchema>;
export type UpdateFamilyInput = z.infer<typeof UpdateFamilySchema>;
