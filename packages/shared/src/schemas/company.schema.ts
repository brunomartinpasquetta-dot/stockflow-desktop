import { z } from 'zod';

import { validateCUIT } from '../utils/cuit';
import { idSchema, timestampSchema } from './common';

/** Shape completo de `companies` (matches DB, fila única). */
export const CompanySchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  cuit: z.string().nullable(),
  ingBrutos: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const companyBase = z.object({
  name: z.string().min(1),
  address: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish(),
  cuit: z
    .string()
    .nullish()
    .refine((v) => v == null || v === '' || validateCUIT(v), {
      message: 'CUIT inválido',
    }),
  ingBrutos: z.string().nullish(),
});

export const CreateCompanySchema = companyBase;
export const UpdateCompanySchema = companyBase.partial();

export type CompanyOutput = z.infer<typeof CompanySchema>;
export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>;
export type UpdateCompanyInput = z.infer<typeof UpdateCompanySchema>;
