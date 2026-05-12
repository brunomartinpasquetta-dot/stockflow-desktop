import { z } from 'zod';

import { validateCUIT } from '../utils/cuit';
import { idSchema, timestampSchema } from './common';

/** Shape completo de `suppliers` (matches DB). */
export const SupplierSchema = z.object({
  id: idSchema,
  code: z.string().min(1),
  name: z.string().min(1),
  address: z.string().nullable(),
  city: z.string().nullable(),
  cuit: z.string().nullable(),
  ingBrutos: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const supplierBase = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  address: z.string().nullish(),
  city: z.string().nullish(),
  cuit: z
    .string()
    .nullish()
    .refine((v) => v == null || v === '' || validateCUIT(v), {
      message: 'CUIT inválido',
    }),
  ingBrutos: z.string().nullish(),
  phone: z.string().nullish(),
  mobile: z.string().nullish(),
});

export const CreateSupplierSchema = supplierBase;
export const UpdateSupplierSchema = supplierBase.partial();

export type SupplierOutput = z.infer<typeof SupplierSchema>;
export type CreateSupplierInput = z.infer<typeof CreateSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof UpdateSupplierSchema>;
