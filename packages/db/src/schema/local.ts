/**
 * Schema SQLite local del PDV (driver better-sqlite3, síncrono).
 *
 * Convenciones:
 *  - IDs: TEXT con UUID v7 (generado por defecto vía $defaultFn).
 *  - Decimales: TEXT con string formateado (precisión exacta, SQLite no tiene DECIMAL).
 *  - Timestamps: INTEGER unix milliseconds (Date.now()).
 *  - Booleans: INTEGER 0/1 expuesto como boolean (mode: 'boolean').
 *  - SQL en snake_case, TypeScript en camelCase.
 *
 * Tablas core derivadas del legacy StockFacil (Firebird .GDB):
 *  companies, users, families, suppliers, articles, customers, cards,
 *  cashRegisters, cashMovements, sales, saleLines, purchases, purchaseLines,
 *  accountsReceivable, payments.
 */
import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  check,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { v7 as uuidv7 } from 'uuid';

/** Helpers reutilizables. */
const pk = () => text('id').primaryKey().$defaultFn(() => uuidv7());
const createdAtCol = () =>
  integer('created_at').notNull().$defaultFn(() => Date.now());
const updatedAtCol = () =>
  integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());

/* ------------------------------------------------------------------ */
/* companies — datos de la empresa del cliente (una sola fila)         */
/* ------------------------------------------------------------------ */
export const companies = sqliteTable(
  'companies',
  {
    id: pk(),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    email: text('email'),
    cuit: text('cuit'),
    ingBrutos: text('ing_brutos'),
    /**
     * Modo de precios:
     *  - 'gross' = los precios cargados YA incluyen IVA (IVA contenido; default).
     *  - 'net'   = los precios cargados son netos; el IVA se suma al vender.
     */
    priceMode: text('price_mode', { enum: ['gross', 'net'] }).notNull().default('gross'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    priceModeCheck: check('companies_price_mode_check', sql`${t.priceMode} in ('gross', 'net')`),
  }),
);

/* ------------------------------------------------------------------ */
/* users                                                              */
/* ------------------------------------------------------------------ */
export const users = sqliteTable(
  'users',
  {
    id: pk(),
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    role: text('role', { enum: ['admin', 'manager', 'seller'] }).notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    roleCheck: check(
      'users_role_check',
      sql`${t.role} in ('admin', 'manager', 'seller')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* families — jerárquica (familia / subfamilia)                       */
/* ------------------------------------------------------------------ */
export const families = sqliteTable('families', {
  id: pk(),
  name: text('name').notNull(),
  parentId: text('parent_id').references((): AnySQLiteColumn => families.id),
  createdAt: createdAtCol(),
});

/* ------------------------------------------------------------------ */
/* suppliers                                                          */
/* ------------------------------------------------------------------ */
export const suppliers = sqliteTable('suppliers', {
  id: pk(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  address: text('address'),
  city: text('city'),
  cuit: text('cuit'),
  ingBrutos: text('ing_brutos'),
  phone: text('phone'),
  mobile: text('mobile'),
  createdAt: createdAtCol(),
  updatedAt: updatedAtCol(),
});

/* ------------------------------------------------------------------ */
/* articles                                                           */
/* ------------------------------------------------------------------ */
export const articles = sqliteTable(
  'articles',
  {
    id: pk(),
    barcode: text('barcode').notNull().unique(),
    description: text('description').notNull(),
    brand: text('brand'),
    familyId: text('family_id').references(() => families.id),
    supplierId: text('supplier_id').references(() => suppliers.id),
    costPrice: text('cost_price').notNull().default('0.0000'),
    listPrice1: text('list_price1').notNull().default('0.0000'),
    listPrice2: text('list_price2').notNull().default('0.0000'),
    listPrice3: text('list_price3').notNull().default('0.0000'),
    wholesalePrice: text('wholesale_price').notNull().default('0.0000'),
    wholesaleMinQty: text('wholesale_min_qty').notNull().default('0.000'),
    vatRate: text('vat_rate').notNull().default('21.00'),
    stock: text('stock').notNull().default('0.000'),
    minStock: text('min_stock').notNull().default('0.000'),
    idealStock: text('ideal_stock').notNull().default('0.000'),
    soldByWeight: integer('sold_by_weight', { mode: 'boolean' })
      .notNull()
      .default(false),
    unit: text('unit', { enum: ['UN', 'KG', 'GR', 'LT', 'ML'] })
      .notNull()
      .default('UN'),
    imagePath: text('image_path'),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    barcodeIdx: index('idx_articles_barcode').on(t.barcode),
    familyIdx: index('idx_articles_family').on(t.familyId),
    supplierIdx: index('idx_articles_supplier').on(t.supplierId),
    unitCheck: check(
      'articles_unit_check',
      sql`${t.unit} in ('UN', 'KG', 'GR', 'LT', 'ML')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* customers                                                          */
/* ------------------------------------------------------------------ */
export const customers = sqliteTable(
  'customers',
  {
    id: pk(),
    lastName: text('last_name').notNull(),
    firstName: text('first_name'),
    address: text('address'),
    city: text('city'),
    phone: text('phone'),
    mobile: text('mobile'),
    docType: text('doc_type', { enum: ['DNI', 'CUIT', 'CUIL', 'PASS', 'CF'] }),
    docNumber: text('doc_number'),
    category: text('category', { enum: ['RI', 'MT', 'CF', 'EX'] }).notNull(),
    priceList: integer('price_list').notNull().default(1),
    creditLimit: text('credit_limit').notNull().default('0.0000'),
    email: text('email'),
    facebook: text('facebook'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    lastNameIdx: index('idx_customers_lastname').on(t.lastName),
    categoryCheck: check(
      'customers_category_check',
      sql`${t.category} in ('RI', 'MT', 'CF', 'EX')`,
    ),
    priceListCheck: check(
      'customers_price_list_check',
      sql`${t.priceList} in (1, 2, 3)`,
    ),
    docTypeCheck: check(
      'customers_doc_type_check',
      sql`${t.docType} is null or ${t.docType} in ('DNI', 'CUIT', 'CUIL', 'PASS', 'CF')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* cards — tarjetas de crédito/débito                                 */
/* ------------------------------------------------------------------ */
export const cards = sqliteTable('cards', {
  id: pk(),
  name: text('name').notNull().unique(),
  commissionPct: text('commission_pct').notNull().default('0.00'),
  discountPct: text('discount_pct').notNull().default('0.00'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAtCol(),
});

/* ------------------------------------------------------------------ */
/* paymentMethods — medios de pago configurables                       */
/* ------------------------------------------------------------------ */
export const paymentMethods = sqliteTable(
  'payment_methods',
  {
    id: pk(),
    name: text('name').notNull().unique(),
    type: text('type', {
      enum: ['cash', 'transfer', 'debit_card', 'credit_card', 'mp', 'check', 'other'],
    }).notNull(),
    /** Sólo los medios con este flag afectan el arqueo físico del cajón. */
    isPhysicalCash: integer('is_physical_cash', { mode: 'boolean' })
      .notNull()
      .default(false),
    commissionPct: text('commission_pct').notNull().default('0.00'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    typeCheck: check(
      'payment_methods_type_check',
      sql`${t.type} in ('cash', 'transfer', 'debit_card', 'credit_card', 'mp', 'check', 'other')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* cashRegisters — aperturas/cierres de caja                          */
/* ------------------------------------------------------------------ */
export const cashRegisters = sqliteTable(
  'cash_registers',
  {
    id: pk(),
    number: integer('number').notNull(),
    openDate: integer('open_date').notNull(),
    closeDate: integer('close_date'),
    openingAmount: text('opening_amount').notNull(),
    closingAmount: text('closing_amount'),
    status: text('status', { enum: ['open', 'closed'] }).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** Observaciones del cierre (ej. diferencia de arqueo). */
    notes: text('notes'),
    createdAt: createdAtCol(),
  },
  (t) => ({
    statusIdx: index('idx_cash_status').on(t.status),
    statusCheck: check(
      'cash_registers_status_check',
      sql`${t.status} in ('open', 'closed')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* cashMovements — movimientos de caja (ingresos/egresos)             */
/* ------------------------------------------------------------------ */
export const cashMovements = sqliteTable(
  'cash_movements',
  {
    id: pk(),
    cashRegisterId: text('cash_register_id')
      .notNull()
      .references(() => cashRegisters.id),
    type: text('type', { enum: ['income', 'expense'] }).notNull(),
    description: text('description').notNull(),
    amount: text('amount').notNull(),
    date: integer('date').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    relatedSaleId: text('related_sale_id').references(() => sales.id),
    relatedPurchaseId: text('related_purchase_id').references(
      () => purchases.id,
    ),
    /** Medio de pago del movimiento (nullable: movimientos antiguos no lo tienen). */
    paymentMethodId: text('payment_method_id').references(() => paymentMethods.id),
    createdAt: createdAtCol(),
  },
  (t) => ({
    registerIdx: index('idx_cash_movements_register').on(t.cashRegisterId),
    typeCheck: check(
      'cash_movements_type_check',
      sql`${t.type} in ('income', 'expense')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* sales — ventas (cabecera)                                          */
/* ------------------------------------------------------------------ */
export const sales = sqliteTable(
  'sales',
  {
    id: pk(),
    number: integer('number').notNull(),
    type: text('type', { enum: ['A', 'B', 'C', 'X'] }).notNull(),
    date: integer('date').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id),
    cashRegisterId: text('cash_register_id')
      .notNull()
      .references(() => cashRegisters.id),
    /** true = venta a cuenta corriente (sin pagos hasta que se cobre, AR abierta). */
    isAccountSale: integer('is_account_sale', { mode: 'boolean' })
      .notNull()
      .default(false),
    subtotal: text('subtotal').notNull(),
    discount: text('discount').notNull().default('0.0000'),
    vatAmount: text('vat_amount').notNull().default('0.0000'),
    total: text('total').notNull(),
    status: text('status', { enum: ['completed', 'voided', 'pending'] })
      .notNull()
      .default('completed'),
    afipCAE: text('afip_cae'),
    afipExpiry: integer('afip_expiry'),
    afipObservations: text('afip_observations'),
    afipQrUrl: text('afip_qr_url'),
    notes: text('notes'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    dateIdx: index('idx_sales_date').on(t.date),
    customerIdx: index('idx_sales_customer').on(t.customerId),
    sellerIdx: index('idx_sales_seller').on(t.sellerId),
    numberIdx: uniqueIndex('idx_sales_number').on(t.type, t.number),
    typeCheck: check('sales_type_check', sql`${t.type} in ('A', 'B', 'C', 'X')`),
    statusCheck: check(
      'sales_status_check',
      sql`${t.status} in ('completed', 'voided', 'pending')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* salePayments — pagos de una venta (N por venta, sólo si no es CC)   */
/* ------------------------------------------------------------------ */
export const salePayments = sqliteTable(
  'sale_payments',
  {
    id: pk(),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    paymentMethodId: text('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id),
    amount: text('amount').notNull(),
    /** Ej. últimos 4 dígitos de tarjeta, número de transferencia. */
    reference: text('reference'),
    createdAt: createdAtCol(),
  },
  (t) => ({
    saleIdx: index('idx_sale_payments_sale').on(t.saleId),
  }),
);

/* ------------------------------------------------------------------ */
/* saleLines — líneas de venta                                        */
/* ------------------------------------------------------------------ */
export const saleLines = sqliteTable(
  'sale_lines',
  {
    id: pk(),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id, { onDelete: 'cascade' }),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id),
    lineNumber: integer('line_number').notNull(),
    quantity: text('quantity').notNull(),
    unitPrice: text('unit_price').notNull(),
    discount: text('discount').notNull().default('0.0000'),
    vatRate: text('vat_rate').notNull().default('21.00'),
    lineTotal: text('line_total').notNull(),
    createdAt: createdAtCol(),
  },
  (t) => ({
    saleIdx: index('idx_sale_lines_sale').on(t.saleId),
  }),
);

/* ------------------------------------------------------------------ */
/* purchases — compras (cabecera)                                     */
/* ------------------------------------------------------------------ */
export const purchases = sqliteTable(
  'purchases',
  {
    id: pk(),
    number: integer('number').notNull(),
    type: text('type', { enum: ['A', 'B', 'C', 'X'] }).notNull(),
    supplierInvoiceNumber: text('supplier_invoice_number'),
    date: integer('date').notNull(),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    paymentType: text('payment_type', { enum: ['cash', 'credit'] }).notNull(),
    subtotal: text('subtotal').notNull(),
    discount: text('discount').notNull().default('0.0000'),
    vatAmount: text('vat_amount').notNull().default('0.0000'),
    total: text('total').notNull(),
    status: text('status', { enum: ['completed', 'voided', 'pending'] })
      .notNull()
      .default('completed'),
    updatedPricesOnSave: integer('updated_prices_on_save', { mode: 'boolean' })
      .notNull()
      .default(false),
    notes: text('notes'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    dateIdx: index('idx_purchases_date').on(t.date),
    supplierIdx: index('idx_purchases_supplier').on(t.supplierId),
    typeCheck: check(
      'purchases_type_check',
      sql`${t.type} in ('A', 'B', 'C', 'X')`,
    ),
    paymentTypeCheck: check(
      'purchases_payment_type_check',
      sql`${t.paymentType} in ('cash', 'credit')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* purchaseLines — líneas de compra                                   */
/* ------------------------------------------------------------------ */
export const purchaseLines = sqliteTable(
  'purchase_lines',
  {
    id: pk(),
    purchaseId: text('purchase_id')
      .notNull()
      .references(() => purchases.id, { onDelete: 'cascade' }),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id),
    lineNumber: integer('line_number').notNull(),
    quantity: text('quantity').notNull(),
    costPrice: text('cost_price').notNull(),
    salePrice: text('sale_price').notNull(),
    vatRate: text('vat_rate').notNull().default('21.00'),
    lineTotal: text('line_total').notNull(),
    createdAt: createdAtCol(),
  },
  (t) => ({
    purchaseIdx: index('idx_purchase_lines_purchase').on(t.purchaseId),
  }),
);

/* ------------------------------------------------------------------ */
/* accountsReceivable — cuentas corrientes de clientes                */
/* ------------------------------------------------------------------ */
export const accountsReceivable = sqliteTable(
  'accounts_receivable',
  {
    id: pk(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id),
    total: text('total').notNull(),
    balance: text('balance').notNull(),
    status: text('status', { enum: ['open', 'paid', 'partial'] })
      .notNull()
      .default('open'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    customerIdx: index('idx_ar_customer').on(t.customerId),
    statusCheck: check(
      'accounts_receivable_status_check',
      sql`${t.status} in ('open', 'paid', 'partial')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* payments — cobranzas aplicadas a cuentas corrientes                */
/* ------------------------------------------------------------------ */
export const payments = sqliteTable(
  'payments',
  {
    id: pk(),
    accountId: text('account_id')
      .notNull()
      .references(() => accountsReceivable.id),
    amount: text('amount').notNull(),
    date: integer('date').notNull(),
    paymentMethodId: text('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id),
    notes: text('notes'),
    createdAt: createdAtCol(),
  },
  (t) => ({
    accountIdx: index('idx_payments_account').on(t.accountId),
  }),
);

/* ------------------------------------------------------------------ */
/* supplierAccountsPayable — cuentas corrientes con proveedores        */
/* ------------------------------------------------------------------ */
export const supplierAccountsPayable = sqliteTable(
  'supplier_accounts_payable',
  {
    id: pk(),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    purchaseId: text('purchase_id')
      .notNull()
      .references(() => purchases.id),
    total: text('total').notNull(),
    balance: text('balance').notNull(),
    status: text('status', { enum: ['open', 'paid', 'partial'] })
      .notNull()
      .default('open'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    supplierIdx: index('idx_sap_supplier').on(t.supplierId),
    statusCheck: check(
      'supplier_accounts_payable_status_check',
      sql`${t.status} in ('open', 'paid', 'partial')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* supplierPayments — pagos aplicados a cuentas corrientes de proveedor */
/* ------------------------------------------------------------------ */
export const supplierPayments = sqliteTable(
  'supplier_payments',
  {
    id: pk(),
    accountId: text('account_id')
      .notNull()
      .references(() => supplierAccountsPayable.id),
    paymentMethodId: text('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id),
    amount: text('amount').notNull(),
    date: integer('date').notNull(),
    reference: text('reference'),
    createdAt: createdAtCol(),
  },
  (t) => ({
    accountIdx: index('idx_supplier_payments_account').on(t.accountId),
  }),
);

/* ================================================================== */
/* Relaciones (joins type-safe)                                       */
/* ================================================================== */

export const familiesRelations = relations(families, ({ one, many }) => ({
  parent: one(families, {
    fields: [families.parentId],
    references: [families.id],
    relationName: 'family_parent',
  }),
  children: many(families, { relationName: 'family_parent' }),
  articles: many(articles),
}));

export const suppliersRelations = relations(suppliers, ({ many }) => ({
  articles: many(articles),
  purchases: many(purchases),
}));

export const articlesRelations = relations(articles, ({ one, many }) => ({
  family: one(families, {
    fields: [articles.familyId],
    references: [families.id],
  }),
  supplier: one(suppliers, {
    fields: [articles.supplierId],
    references: [suppliers.id],
  }),
  saleLines: many(saleLines),
  purchaseLines: many(purchaseLines),
}));

export const usersRelations = relations(users, ({ many }) => ({
  cashRegisters: many(cashRegisters),
  cashMovements: many(cashMovements),
  sales: many(sales),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  sales: many(sales),
  accountsReceivable: many(accountsReceivable),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ many }) => ({
  salePayments: many(salePayments),
  payments: many(payments),
  cashMovements: many(cashMovements),
}));

export const cashRegistersRelations = relations(
  cashRegisters,
  ({ one, many }) => ({
    user: one(users, {
      fields: [cashRegisters.userId],
      references: [users.id],
    }),
    movements: many(cashMovements),
    sales: many(sales),
  }),
);

export const cashMovementsRelations = relations(cashMovements, ({ one }) => ({
  cashRegister: one(cashRegisters, {
    fields: [cashMovements.cashRegisterId],
    references: [cashRegisters.id],
  }),
  user: one(users, {
    fields: [cashMovements.userId],
    references: [users.id],
  }),
  relatedSale: one(sales, {
    fields: [cashMovements.relatedSaleId],
    references: [sales.id],
  }),
  relatedPurchase: one(purchases, {
    fields: [cashMovements.relatedPurchaseId],
    references: [purchases.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [cashMovements.paymentMethodId],
    references: [paymentMethods.id],
  }),
}));

export const salesRelations = relations(sales, ({ one, many }) => ({
  customer: one(customers, {
    fields: [sales.customerId],
    references: [customers.id],
  }),
  seller: one(users, {
    fields: [sales.sellerId],
    references: [users.id],
  }),
  cashRegister: one(cashRegisters, {
    fields: [sales.cashRegisterId],
    references: [cashRegisters.id],
  }),
  lines: many(saleLines),
  payments: many(salePayments),
  accountsReceivable: many(accountsReceivable),
}));

export const saleLinesRelations = relations(saleLines, ({ one }) => ({
  sale: one(sales, {
    fields: [saleLines.saleId],
    references: [sales.id],
  }),
  article: one(articles, {
    fields: [saleLines.articleId],
    references: [articles.id],
  }),
}));

export const salePaymentsRelations = relations(salePayments, ({ one }) => ({
  sale: one(sales, {
    fields: [salePayments.saleId],
    references: [sales.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [salePayments.paymentMethodId],
    references: [paymentMethods.id],
  }),
}));

export const purchasesRelations = relations(purchases, ({ one, many }) => ({
  supplier: one(suppliers, {
    fields: [purchases.supplierId],
    references: [suppliers.id],
  }),
  lines: many(purchaseLines),
}));

export const purchaseLinesRelations = relations(purchaseLines, ({ one }) => ({
  purchase: one(purchases, {
    fields: [purchaseLines.purchaseId],
    references: [purchases.id],
  }),
  article: one(articles, {
    fields: [purchaseLines.articleId],
    references: [articles.id],
  }),
}));

export const accountsReceivableRelations = relations(
  accountsReceivable,
  ({ one, many }) => ({
    customer: one(customers, {
      fields: [accountsReceivable.customerId],
      references: [customers.id],
    }),
    sale: one(sales, {
      fields: [accountsReceivable.saleId],
      references: [sales.id],
    }),
    payments: many(payments),
  }),
);

export const paymentsRelations = relations(payments, ({ one }) => ({
  account: one(accountsReceivable, {
    fields: [payments.accountId],
    references: [accountsReceivable.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [payments.paymentMethodId],
    references: [paymentMethods.id],
  }),
}));

export const supplierAccountsPayableRelations = relations(
  supplierAccountsPayable,
  ({ one, many }) => ({
    supplier: one(suppliers, {
      fields: [supplierAccountsPayable.supplierId],
      references: [suppliers.id],
    }),
    purchase: one(purchases, {
      fields: [supplierAccountsPayable.purchaseId],
      references: [purchases.id],
    }),
    payments: many(supplierPayments),
  }),
);

/* ------------------------------------------------------------------ */
/* priceUpdateBatches — lote de actualización masiva de precios        */
/* ------------------------------------------------------------------ */
export const priceUpdateBatches = sqliteTable('price_update_batches', {
  id: pk(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  description: text('description').notNull(),
  filterJson: text('filter_json').notNull(),
  ruleJson: text('rule_json').notNull(),
  articlesAffected: integer('articles_affected').notNull().default(0),
  appliedAt: integer('applied_at').notNull(),
  rolledBackAt: integer('rolled_back_at'),
  createdAt: createdAtCol(),
});

/* ------------------------------------------------------------------ */
/* priceUpdateEntries — entradas individuales (un campo de un artículo) */
/* ------------------------------------------------------------------ */
export const priceUpdateEntries = sqliteTable(
  'price_update_entries',
  {
    id: pk(),
    batchId: text('batch_id')
      .notNull()
      .references(() => priceUpdateBatches.id, { onDelete: 'cascade' }),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id),
    field: text('field').notNull(),
    oldValue: text('old_value').notNull(),
    newValue: text('new_value').notNull(),
    createdAt: createdAtCol(),
  },
  (t) => ({
    byBatch: index('idx_pu_batch').on(t.batchId),
    byArticle: index('idx_pu_article').on(t.articleId),
  }),
);

export type PriceUpdateBatch = typeof priceUpdateBatches.$inferSelect;
export type NewPriceUpdateBatch = typeof priceUpdateBatches.$inferInsert;
export type PriceUpdateEntry = typeof priceUpdateEntries.$inferSelect;
export type NewPriceUpdateEntry = typeof priceUpdateEntries.$inferInsert;

export const supplierPaymentsRelations = relations(supplierPayments, ({ one }) => ({
  account: one(supplierAccountsPayable, {
    fields: [supplierPayments.accountId],
    references: [supplierAccountsPayable.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [supplierPayments.paymentMethodId],
    references: [paymentMethods.id],
  }),
}));

/* ================================================================== */
/* Tipos inferidos (select / insert)                                  */
/* ================================================================== */

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Family = typeof families.$inferSelect;
export type NewFamily = typeof families.$inferInsert;
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type Article = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
export type Card = typeof cards.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type NewPaymentMethod = typeof paymentMethods.$inferInsert;
export type CashRegister = typeof cashRegisters.$inferSelect;
export type NewCashRegister = typeof cashRegisters.$inferInsert;
export type CashMovement = typeof cashMovements.$inferSelect;
export type NewCashMovement = typeof cashMovements.$inferInsert;
export type Sale = typeof sales.$inferSelect;
export type NewSale = typeof sales.$inferInsert;
export type SaleLine = typeof saleLines.$inferSelect;
export type NewSaleLine = typeof saleLines.$inferInsert;
export type SalePayment = typeof salePayments.$inferSelect;
export type NewSalePayment = typeof salePayments.$inferInsert;
export type Purchase = typeof purchases.$inferSelect;
export type NewPurchase = typeof purchases.$inferInsert;
export type PurchaseLine = typeof purchaseLines.$inferSelect;
export type NewPurchaseLine = typeof purchaseLines.$inferInsert;
export type AccountReceivable = typeof accountsReceivable.$inferSelect;
export type NewAccountReceivable = typeof accountsReceivable.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type SupplierAccountPayable = typeof supplierAccountsPayable.$inferSelect;
export type NewSupplierAccountPayable = typeof supplierAccountsPayable.$inferInsert;
export type SupplierPayment = typeof supplierPayments.$inferSelect;
export type NewSupplierPayment = typeof supplierPayments.$inferInsert;

/** Objeto schema agregado (para pasar a drizzle({ schema })). */
export const localSchema = {
  companies,
  users,
  families,
  suppliers,
  articles,
  customers,
  cards,
  paymentMethods,
  cashRegisters,
  cashMovements,
  sales,
  saleLines,
  salePayments,
  purchases,
  purchaseLines,
  accountsReceivable,
  payments,
  supplierAccountsPayable,
  supplierPayments,
  priceUpdateBatches,
  priceUpdateEntries,
  familiesRelations,
  suppliersRelations,
  articlesRelations,
  usersRelations,
  customersRelations,
  paymentMethodsRelations,
  cashRegistersRelations,
  cashMovementsRelations,
  salesRelations,
  saleLinesRelations,
  salePaymentsRelations,
  purchasesRelations,
  purchaseLinesRelations,
  accountsReceivableRelations,
  paymentsRelations,
  supplierAccountsPayableRelations,
  supplierPaymentsRelations,
};
