import { z } from 'zod';

import { validateCUIT } from '../utils/cuit';
import {
  docTypeSchema,
  fiscalCategorySchema,
  idSchema,
  moneySchema,
  timestampSchema,
} from './common';

/** Shape completo de `customers` (matches DB). */
export const CustomerSchema = z.object({
  id: idSchema,
  lastName: z.string().min(1),
  firstName: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  docType: docTypeSchema.nullable(),
  docNumber: z.string().nullable(),
  category: fiscalCategorySchema,
  priceList: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  creditLimit: moneySchema,
  email: z.string().email().nullable(),
  facebook: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

const customerBase = z.object({
  lastName: z.string().min(1),
  firstName: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  phone: z.string().nullish(),
  mobile: z.string().nullish(),
  docType: docTypeSchema.nullish(),
  docNumber: z.string().nullish(),
  category: fiscalCategorySchema,
  priceList: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  creditLimit: moneySchema.default('0.0000'),
  email: z.string().email().nullish(),
  facebook: z.string().nullish(),
});

/** Coherencia docType ↔ docNumber. */
function refineDoc(
  data: { docType?: string | null; docNumber?: string | null },
  ctx: z.RefinementCtx,
): void {
  const { docType, docNumber } = data;
  if (!docType || docType === 'CF') return;
  if (!docNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['docNumber'],
      message: `docNumber es obligatorio cuando docType = ${docType}`,
    });
    return;
  }
  if (docType === 'DNI' && !/^\d{7,8}$/.test(docNumber)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['docNumber'],
      message: 'El DNI debe tener 7 u 8 dígitos',
    });
  }
  if ((docType === 'CUIT' || docType === 'CUIL') && !validateCUIT(docNumber)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['docNumber'],
      message: `${docType} inválido (formato o dígito verificador)`,
    });
  }
}

/** Input para crear un cliente. */
export const CreateCustomerSchema = customerBase.superRefine(refineDoc);

/** Input para actualizar un cliente. */
export const UpdateCustomerSchema = customerBase.partial().superRefine(refineDoc);

export type CustomerOutput = z.infer<typeof CustomerSchema>;
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;
