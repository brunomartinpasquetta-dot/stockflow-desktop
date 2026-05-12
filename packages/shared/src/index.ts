import { z } from 'zod';

/**
 * Contratos compartidos entre desktop y cloud.
 *
 * Exporta:
 *  - Schemas Zod de dominio (validación runtime de inputs/outputs), en `./schemas`.
 *  - Helpers (`./utils`): aritmética decimal sobre strings, validación de CUIT.
 *  - Tipos TypeScript derivados de las tablas Drizzle de `@stockflow/db` (re-export),
 *    para tipar entidades sin acoplar las apps al ORM.
 *  - Un placeholder de licencia (los schemas de licenciamiento llegan más adelante).
 */
export const LicenseSchema = z.object({});
export type License = z.infer<typeof LicenseSchema>;

export * from './utils';
export * from './schemas';

// Tipos de entidades derivados de las tablas de la base local (`typeof tabla.$inferSelect`).
export type {
  Company,
  NewCompany,
  User,
  NewUser,
  Family,
  NewFamily,
  Supplier,
  NewSupplier,
  Article,
  NewArticle,
  Customer,
  NewCustomer,
  Card,
  NewCard,
  PaymentMethod,
  NewPaymentMethod,
  CashRegister,
  NewCashRegister,
  CashMovement,
  NewCashMovement,
  Sale,
  NewSale,
  SaleLine,
  NewSaleLine,
  SalePayment,
  NewSalePayment,
  Purchase,
  NewPurchase,
  PurchaseLine,
  NewPurchaseLine,
  AccountReceivable,
  NewAccountReceivable,
  Payment,
  NewPayment,
} from '@stockflow/db';
