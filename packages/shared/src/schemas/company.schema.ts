import { z } from 'zod';

import { validateCUIT } from '../utils/cuit';
import { idSchema, timestampSchema } from './common';

/** Modo de precios de la empresa: 'gross' = precios con IVA incluido / 'net' = precios netos + IVA aparte. */
export const priceModeSchema = z.enum(['gross', 'net']);

/** Shape completo de `companies` (matches DB, fila única). */
export const CompanySchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  cuit: z.string().nullable(),
  ingBrutos: z.string().nullable(),
  priceMode: priceModeSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const companyBase = z.object({
  name: z.string().min(1),
  address: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.union([z.string().email(), z.literal(''), z.null()]).optional(),
  cuit: z
    .string()
    .nullish()
    .refine((v) => v == null || v === '' || validateCUIT(v), {
      message: 'CUIT inválido',
    }),
  ingBrutos: z.string().nullish(),
  priceMode: priceModeSchema.optional(),
});

export const CreateCompanySchema = companyBase;
export const UpdateCompanySchema = companyBase.partial();

export type CompanyOutput = z.infer<typeof CompanySchema>;
export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
