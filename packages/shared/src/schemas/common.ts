import { z } from 'zod';

/**
 * Piezas reutilizables para los schemas de entidad.
 * Los decimales viajan como string (la DB los guarda como TEXT).
 */

/** UUID v7 (texto). No validamos el formato exacto, sólo que no sea vacío. */
export const idSchema = z.string().min(1);

/** Timestamp unix en milisegundos. */
export const timestampSchema = z.number().int().nonnegative();

/** Decimal de dinero: hasta 4 decimales. Ej. "1234.5000". */
export const moneySchema = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Debe ser un decimal con hasta 4 decimales');

/** Decimal de cantidad/stock: hasta 3 decimales. Ej. "12.500". */
export const qtySchema = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Debe ser un decimal con hasta 3 decimales');

/** Decimal de porcentaje: hasta 2 decimales. Ej. "21.00". */
export const pctSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Debe ser un porcentaje con hasta 2 decimales');

/** Alícuotas de IVA admitidas en Argentina. */
export const vatRateSchema = z.enum(['0.00', '10.50', '21.00', '27.00']);
export type VatRate = z.infer<typeof vatRateSchema>;

/** Unidades de venta. */
export const unitSchema = z.enum(['UN', 'KG', 'GR', 'LT', 'ML']);
export type Unit = z.infer<typeof unitSchema>;

/** Tipos de comprobante. */
export const voucherTypeSchema = z.enum(['A', 'B', 'C', 'X']);
export type VoucherType = z.infer<typeof voucherTypeSchema>;

/** Tipos de documento de identidad. */
export const docTypeSchema = z.enum(['DNI', 'CUIT', 'CUIL', 'PASS', 'CF']);
export type DocType = z.infer<typeof docTypeSchema>;

/** Categorías fiscales de cliente. */
export const fiscalCategorySchema = z.enum(['RI', 'MT', 'CF', 'EX']);
export type FiscalCategory = z.infer<typeof fiscalCategorySchema>;

/** Rol de usuario. */
export const userRoleSchema = z.enum(['admin', 'manager', 'seller']);
export type UserRole = z.infer<typeof userRoleSchema>;
