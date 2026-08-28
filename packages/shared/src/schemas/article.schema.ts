import { z } from 'zod';

import {
  idSchema,
  moneySchema,
  qtySchema,
  timestampSchema,
  unitSchema,
  vatRateSchema,
} from './common';

/** Shape completo de `articles` (matches DB). */
export const ArticleSchema = z.object({
  id: idSchema,
  barcode: z.string().min(1),
  description: z.string().min(1).max(200),
  brand: z.string().nullable(),
  familyId: idSchema.nullable(),
  supplierId: idSchema.nullable(),
  costPrice: moneySchema,
  listPrice1: moneySchema,
  listPrice2: moneySchema,
  listPrice3: moneySchema,
  wholesalePrice: moneySchema,
  wholesaleMinQty: qtySchema,
  vatRate: z.string(),
  /** Utilidad % por lista sobre el costo. NULL = sin margen (no se recalcula). */
  margin1: z.string().nullable(),
  margin2: z.string().nullable(),
  margin3: z.string().nullable(),
  stock: qtySchema,
  minStock: qtySchema,
  idealStock: qtySchema,
  soldByWeight: z.boolean(),
  unit: unitSchema,
  imagePath: z.string().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** Input para crear un artículo (omite id, createdAt, updatedAt). */
export const CreateArticleSchema = z.object({
  barcode: z.string().min(1),
  description: z.string().min(1).max(200),
  brand: z.string().nullish(),
  familyId: idSchema.nullish(),
  supplierId: idSchema.nullish(),
  costPrice: moneySchema.default('0.0000'),
  listPrice1: moneySchema.default('0.0000'),
  listPrice2: moneySchema.default('0.0000'),
  listPrice3: moneySchema.default('0.0000'),
  wholesalePrice: moneySchema.default('0.0000'),
  wholesaleMinQty: qtySchema.default('0.000'),
  vatRate: vatRateSchema.default('21.00'),
  margin1: z.string().nullish(),
  margin2: z.string().nullish(),
  margin3: z.string().nullish(),
  stock: qtySchema.default('0.000'),
  minStock: qtySchema.default('0.000'),
  idealStock: qtySchema.default('0.000'),
  soldByWeight: z.boolean().default(false),
  unit: unitSchema.default('UN'),
  imagePath: z.string().nullish(),
  notes: z.string().nullish(),
  active: z.boolean().default(true),
  // NOTA: el prompt menciona "category opcional" en CreateArticleSchema, pero la
  // tabla `articles` no tiene columna category (la jerarquía es `familyId`).
});

/** Input para actualizar un artículo (todos los campos opcionales). */
export const UpdateArticleSchema = CreateArticleSchema.partial();

export type ArticleOutput = z.infer<typeof ArticleSchema>;
export type CreateArticleInput = z.infer<typeof CreateArticleSchema>;
export type UpdateArticleInput = z.infer<typeof UpdateArticleSchema>;
