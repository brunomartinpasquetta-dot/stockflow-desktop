/**
 * Seed de datos iniciales obligatorios para una base local recién creada.
 *
 * Idempotente: cada registro se inserta sólo si su clave de negocio no existe,
 * por lo que `seedLocalDb` puede ejecutarse en cada arranque sin duplicar nada
 * (equivalente a `INSERT OR IGNORE`).
 */
import { and, eq, isNull } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

import type { LocalDatabase } from './local/client';
import { companies, customers, families, paymentMethods, users } from './schema/local';

const BCRYPT_COST = 10;

/** Medios de pago pre-cargados (IDs fijos: referenciables sin lookup en migraciones). */
const DEFAULT_PAYMENT_METHODS = [
  { id: 'pm-efectivo', name: 'Efectivo', type: 'cash' as const, isPhysicalCash: true, sortOrder: 1 },
  { id: 'pm-transferencia', name: 'Transferencia', type: 'transfer' as const, isPhysicalCash: false, sortOrder: 2 },
  { id: 'pm-tarjeta-credito', name: 'Tarjeta de Crédito', type: 'credit_card' as const, isPhysicalCash: false, sortOrder: 3 },
  { id: 'pm-tarjeta-debito', name: 'Tarjeta de Débito', type: 'debit_card' as const, isPhysicalCash: false, sortOrder: 4 },
];

export interface SeedResult {
  adminCreated: boolean;
  consumidorFinalCreated: boolean;
  defaultFamilyCreated: boolean;
  companyCreated: boolean;
  paymentMethodsCreated: number;
}

/** Inserta los datos base si todavía no existen. Devuelve qué se creó. */
export function seedLocalDb(db: LocalDatabase): SeedResult {
  const result: SeedResult = {
    adminCreated: false,
    consumidorFinalCreated: false,
    defaultFamilyCreated: false,
    companyCreated: false,
    paymentMethodsCreated: 0,
  };

  // 1) Usuario admin
  const existingAdmin = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, 'admin'))
    .limit(1)
    .all();
  if (existingAdmin.length === 0) {
    db.insert(users)
      .values({
        username: 'admin',
        passwordHash: bcrypt.hashSync('admin', BCRYPT_COST),
        fullName: 'Administrador',
        role: 'admin',
        active: true,
      })
      .run();
    result.adminCreated = true;
  }

  // 2) Cliente CONSUMIDOR FINAL
  const existingCF = db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.lastName, 'CONSUMIDOR FINAL'))
    .limit(1)
    .all();
  if (existingCF.length === 0) {
    db.insert(customers)
      .values({
        lastName: 'CONSUMIDOR FINAL',
        category: 'CF',
        priceList: 1,
        docType: 'CF',
      })
      .run();
    result.consumidorFinalCreated = true;
  }

  // 3) Familia default "ARTICULOS"
  const existingFamily = db
    .select({ id: families.id })
    .from(families)
    .where(and(eq(families.name, 'ARTICULOS'), isNull(families.parentId)))
    .limit(1)
    .all();
  if (existingFamily.length === 0) {
    db.insert(families).values({ name: 'ARTICULOS', parentId: null }).run();
    result.defaultFamilyCreated = true;
  }

  // 4) Empresa stub (una sola fila)
  const existingCompany = db
    .select({ id: companies.id })
    .from(companies)
    .limit(1)
    .all();
  if (existingCompany.length === 0) {
    const now = Date.now();
    db.insert(companies)
      .values({ name: 'Mi Empresa', createdAt: now, updatedAt: now })
      .run();
    result.companyCreated = true;
  }

  // 5) Medios de pago por defecto (Efectivo / Transferencia / T. Crédito / T. Débito)
  for (const pm of DEFAULT_PAYMENT_METHODS) {
    const exists = db
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(eq(paymentMethods.id, pm.id))
      .limit(1)
      .all();
    if (exists.length === 0) {
      const now = Date.now();
      db.insert(paymentMethods)
        .values({
          id: pm.id,
          name: pm.name,
          type: pm.type,
          isPhysicalCash: pm.isPhysicalCash,
          commissionPct: '0.00',
          active: true,
          sortOrder: pm.sortOrder,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      result.paymentMethodsCreated++;
    }
  }

  return result;
}
