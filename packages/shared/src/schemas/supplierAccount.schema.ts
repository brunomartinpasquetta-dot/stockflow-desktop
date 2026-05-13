import { z } from 'zod';

import { idSchema, moneySchema, timestampSchema } from './common';
import { PaymentInputSchema } from './paymentMethod.schema';

/** Shape completo de `supplier_accounts_payable` (matches DB). */
export const SupplierAccountPayableSchema = z.object({
  id: idSchema,
  supplierId: idSchema,
  purchaseId: idSchema,
  total: moneySchema,
  balance: moneySchema,
  status: z.enum(['open', 'paid', 'partial']),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** Input para abrir una cuenta corriente con un proveedor a partir de una compra. */
export const CreateSupplierAccountPayableSchema = z.object({
  supplierId: idSchema,
  purchaseId: idSchema,
  total: moneySchema,
});

export const UpdateSupplierAccountPayableSchema = z.object({
  balance: moneySchema.optional(),
  status: z.enum(['open', 'paid', 'partial']).optional(),
});

/** Shape completo de `supplier_payments` (matches DB). */
export const SupplierPaymentSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  paymentMethodId: idSchema,
  amount: moneySchema,
  date: timestampSchema,
  reference: z.string().nullable(),
  createdAt: timestampSchema,
});

/** Input para registrar un pago (posiblemente mixto) a una cuenta corriente de proveedor. */
export const CreateSupplierPaymentSchema = z.object({
  accountId: idSchema,
  payments: z.array(PaymentInputSchema).min(1, 'Debe registrarse al menos un pago'),
  date: timestampSchema.optional(),
  notes: z.string().nullish(),
  /** Caja donde impacta el egreso de la parte en efectivo. */
  cashRegisterId: idSchema,
  /** Usuario que registra el pago. */
  userId: idSchema,
});

export type SupplierAccountPayableOutput = z.infer<typeof SupplierAccountPayableSchema>;
export type CreateSupplierAccountPayableInput = z.infer<typeof CreateSupplierAccountPayableSchema>;
export type SupplierPaymentOutput = z.infer<typeof SupplierPaymentSchema>;
export type CreateSupplierPaymentInput = z.infer<typeof CreateSupplierPaymentSchema>;
