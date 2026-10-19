import { z } from 'zod';

import {
  MENSAJE_CANTIDAD_ALTA,
  MENSAJE_IMPORTE_ALTO,
  superaElTope,
  type ClaveDeTope,
} from '../limites';

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

/**
 * Importe que PUEDE ser negativo. Para saldos y arqueos, no para montos que se
 * cargan (una venta o un egreso siempre son positivos).
 *
 * Hace falta porque un arqueo tiene que poder declarar la realidad: si el
 * cajón quedó en rojo (se pagó más de lo que había), el cajero debe poder
 * cerrar con ese número. Con `moneySchema` el cierre se rechazaba con
 * "Debe ser un decimal con hasta 4 decimales" —un mensaje que no explicaba
 * nada— y la caja quedaba imposible de cerrar.
 */
export const signedMoneySchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, 'Debe ser un decimal con hasta 4 decimales');

/** Decimal de cantidad/stock: hasta 3 decimales. Ej. "12.500". */
export const qtySchema = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'Debe ser un decimal con hasta 3 decimales');

/** Decimal de porcentaje: hasta 2 decimales. Ej. "21.00". */
export const pctSchema = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'Debe ser un porcentaje con hasta 2 decimales');

/*
 * Variantes CON TOPE de los decimales de arriba, para lo que se CARGA (entrada
 * de ventas, compras, presupuestos, caja, artículos…). Los esquemas de forma de
 * la base (`SaleSchema`, `ArticleSchema`…) siguen con los de arriba: leer un dato
 * viejo no puede fallar por un tope nuevo. Los topes viven en `../limites.ts`.
 *
 * `sinRuta` hace que el aviso llegue al usuario SOLO, sin el prefijo técnico
 * «lines.0.quantity:» (ver `ValidationError.fromZod`).
 */
const conTope = (clave: ClaveDeTope, mensaje: string) => ({
  check: (v: string) => !superaElTope(v, clave),
  opciones: { message: mensaje, params: { sinRuta: true, tope: clave } },
});

const tImporte = conTope('importe', MENSAJE_IMPORTE_ALTO);
const tPrecio = conTope('precio', MENSAJE_IMPORTE_ALTO);
const tCantidad = conTope('cantidad', MENSAJE_CANTIDAD_ALTA);
const tStock = conTope('stock', MENSAJE_CANTIDAD_ALTA);

/** Importe total (venta, pago, movimiento de caja, descuento global, crédito…): dinero con tope. */
export const importeSchema = moneySchema.refine(tImporte.check, tImporte.opciones);

/** Importe que puede ser negativo (arqueo de caja en rojo), con tope sobre el valor absoluto. */
export const signedImporteSchema = signedMoneySchema.refine(tImporte.check, tImporte.opciones);

/** Precio unitario, costo, precio de lista o descuento de un renglón: dinero con tope. */
export const precioSchema = moneySchema.refine(tPrecio.check, tPrecio.opciones);

/** Cantidad de un renglón de venta, compra, presupuesto o promoción: cantidad con tope. */
export const cantidadSchema = qtySchema.refine(tCantidad.check, tCantidad.opciones);

/** Existencia de un artículo (stock, mínimo, ideal, mínimo mayorista): cantidad con tope. */
export const stockSchema = qtySchema.refine(tStock.check, tStock.opciones);

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
