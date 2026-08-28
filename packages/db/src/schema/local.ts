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
  primaryKey,
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
    /**
     * Permitir vender sin stock (stock queda en negativo). Default ON: la
     * mayoría de los comercios lo necesitan (venta a descubierto). OFF = se
     * bloquea la venta cuando stock < cantidad (BUG-OP-01).
     */
    allowNegativeStock: integer('allow_negative_stock', { mode: 'boolean' }).notNull().default(true),
    /**
     * Logo del comercio para la factura, como data URL. Se guarda la IMAGEN y
     * no una ruta: una ruta se rompe si el archivo se mueve o se eligió desde
     * un pendrive, y la factura sale sin logo sin avisar. Así viaja con el
     * backup y sobrevive a las actualizaciones.
     */
    logoDataUrl: text('logo_data_url'),
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
/* role_area_access — permisos configurables por rol y área funcional   */
/* ------------------------------------------------------------------ */
/**
 * Habilita/deshabilita ÁREAS funcionales por rol (manager/seller). `admin`
 * SIEMPRE tiene acceso total: nunca se lee esta tabla para admin. El motor de
 * permisos (@stockflow/core) recompone las acciones efectivas como la unión de
 * las áreas con `allowed = 1`.
 */
export const roleAreaAccess = sqliteTable(
  'role_area_access',
  {
    role: text('role', { enum: ['admin', 'manager', 'seller'] }).notNull(),
    area: text('area').notNull(),
    allowed: integer('allowed', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.role, t.area] }),
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
    /**
     * Utilidad % de cada lista sobre el COSTO (c/IVA, modo 'gross'). La usa
     * Compras para recalcular las listas al cambiar el costo. NULL = sin
     * margen conocido: esa lista no se toca. Se siembran en la 0022.
     */
    margin1: text('margin1'),
    margin2: text('margin2'),
    margin3: text('margin3'),
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
    /**
     * Comisión del medio de pago aplicada a este pago (el comercio la ABSORBE).
     * `commissionPct`: % copiado del medio de pago al momento de la venta.
     * `commissionAmount`: amount * commissionPct / 100 (4 decimales).
     * `netAmount`: amount - commissionAmount (lo que efectivamente recibe el comercio).
     */
    commissionPct: text('commission_pct').notNull().default('0.0000'),
    commissionAmount: text('commission_amount').notNull().default('0.0000'),
    netAmount: text('net_amount').notNull().default('0.0000'),
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
    /**
     * NULL = ARTÍCULO RÁPIDO: se vendió algo que no está en el catálogo y la
     * línea se describe sola (ver `description`). No mueve stock, porque no hay
     * nada en inventario que descontar.
     */
    articleId: text('article_id').references(() => articles.id),
    /**
     * Descripción escrita a mano. Sólo se usa cuando NO hay artículo; si lo
     * hay, la descripción sale de él, así sigue al artículo si lo renombran.
     */
    description: text('description'),
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
/* returns — DEVOLUCIONES de ventas (total o parcial por líneas).       */
/* Restauran stock (promo → componentes) y reintegran en efectivo       */
/* (egreso de caja) o como crédito en la cuenta corriente (baja la AR). */
/* Serie propia de numeración (DEV-N).                                  */
/* ------------------------------------------------------------------ */
export const returns = sqliteTable(
  'returns',
  {
    id: pk(),
    number: integer('number').notNull(),
    saleId: text('sale_id')
      .notNull()
      .references(() => sales.id),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    /** Caja que pagó el reintegro (null si fue crédito en cuenta). */
    cashRegisterId: text('cash_register_id').references(() => cashRegisters.id),
    date: integer('date').notNull(),
    refundMethod: text('refund_method', { enum: ['cash', 'account'] })
      .notNull()
      .default('cash'),
    total: text('total').notNull(),
    notes: text('notes'),
    createdAt: createdAtCol(),
  },
  (t) => ({
    numberIdx: uniqueIndex('idx_returns_number').on(t.number),
    saleIdx: index('idx_returns_sale').on(t.saleId),
  }),
);

export const returnLines = sqliteTable(
  'return_lines',
  {
    id: pk(),
    returnId: text('return_id')
      .notNull()
      .references(() => returns.id, { onDelete: 'cascade' }),
    saleLineId: text('sale_line_id')
      .notNull()
      .references(() => saleLines.id),
    /** null = se devolvió un artículo rápido: sólo se reintegra la plata. */
    articleId: text('article_id').references(() => articles.id),
    quantity: text('quantity').notNull(),
    unitPrice: text('unit_price').notNull(),
    lineTotal: text('line_total').notNull(),
    createdAt: createdAtCol(),
  },
  (t) => ({
    returnIdx: index('idx_return_lines_return').on(t.returnId),
    saleLineIdx: index('idx_return_lines_sale_line').on(t.saleLineId),
  }),
);

/* Devoluciones de COMPRAS al proveedor: el stock BAJA (la mercadería    */
/* vuelve al proveedor) y el reintegro entra en efectivo o baja la deuda.*/
export const purchaseReturns = sqliteTable(
  'purchase_returns',
  {
    id: pk(),
    number: integer('number').notNull(),
    purchaseId: text('purchase_id')
      .notNull()
      .references(() => purchases.id),
    supplierId: text('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    cashRegisterId: text('cash_register_id').references(() => cashRegisters.id),
    date: integer('date').notNull(),
    refundMethod: text('refund_method', { enum: ['cash', 'account'] })
      .notNull()
      .default('cash'),
    total: text('total').notNull(),
    notes: text('notes'),
    createdAt: createdAtCol(),
  },
  (t) => ({
    numberIdx: uniqueIndex('idx_purchase_returns_number').on(t.number),
    purchaseIdx: index('idx_purchase_returns_purchase').on(t.purchaseId),
  }),
);

export const purchaseReturnLines = sqliteTable(
  'purchase_return_lines',
  {
    id: pk(),
    returnId: text('return_id')
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: 'cascade' }),
    purchaseLineId: text('purchase_line_id')
      .notNull()
      .references(() => purchaseLines.id),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id),
    quantity: text('quantity').notNull(),
    unitPrice: text('unit_price').notNull(),
    lineTotal: text('line_total').notNull(),
    createdAt: createdAtCol(),
  },
  (t) => ({
    returnIdx: index('idx_purchase_return_lines_return').on(t.returnId),
  }),
);

/* ------------------------------------------------------------------ */
/* promotions — combos/promos. La promo se VENDE como un artículo       */
/* "espejo" real (fila en `articles`, marca 'PROMO'): así el carrito,   */
/* el ticket, el IVA y los reportes funcionan sin casos especiales.     */
/* Esta tabla marca qué artículos son promos y sus componentes; al      */
/* vender/anular, el stock se mueve sobre los COMPONENTES (el stock del */
/* espejo no se toca). Nombre/precio/costo viven en el artículo espejo. */
/* ------------------------------------------------------------------ */
export const promotions = sqliteTable(
  'promotions',
  {
    id: pk(),
    /** Artículo espejo (uno por promo). Activar/desactivar = `articles.active`. */
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    articleIdx: uniqueIndex('idx_promotions_article').on(t.articleId),
  }),
);

export const promotionItems = sqliteTable(
  'promotion_items',
  {
    id: pk(),
    promotionId: text('promotion_id')
      .notNull()
      .references(() => promotions.id, { onDelete: 'cascade' }),
    /** Componente real cuyo stock se descuenta al vender la promo. */
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id),
    /** Unidades del componente por CADA promo vendida (3 decimales). */
    quantity: text('quantity').notNull().default('1.000'),
    createdAt: createdAtCol(),
  },
  (t) => ({
    promotionIdx: index('idx_promotion_items_promotion').on(t.promotionId),
    promotionArticleIdx: uniqueIndex('idx_promotion_items_promotion_article').on(t.promotionId, t.articleId),
  }),
);

export const promotionsRelations = relations(promotions, ({ one, many }) => ({
  article: one(articles, { fields: [promotions.articleId], references: [articles.id] }),
  items: many(promotionItems),
}));

export const promotionItemsRelations = relations(promotionItems, ({ one }) => ({
  promotion: one(promotions, { fields: [promotionItems.promotionId], references: [promotions.id] }),
  article: one(articles, { fields: [promotionItems.articleId], references: [articles.id] }),
}));

/* ------------------------------------------------------------------ */
/* quotes — presupuestos (cabecera). NO es comprobante fiscal: tiene su */
/* propia numeración secuencial. No toca stock hasta convertirse en venta. */
/* ------------------------------------------------------------------ */
export const quotes = sqliteTable(
  'quotes',
  {
    id: pk(),
    number: integer('number').notNull(),
    /** Tipo de comprobante que tendrá la venta al convertirse. */
    type: text('type', { enum: ['A', 'B', 'C', 'X'] }).notNull().default('B'),
    date: integer('date').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id),
    /** Días de validez desde `date`; el estado 'vencido' se calcula en lectura. */
    validityDays: integer('validity_days').notNull().default(30),
    subtotal: text('subtotal').notNull(),
    discount: text('discount').notNull().default('0.0000'),
    vatAmount: text('vat_amount').notNull().default('0.0000'),
    total: text('total').notNull(),
    status: text('status', { enum: ['pending', 'accepted', 'rejected', 'converted'] })
      .notNull()
      .default('pending'),
    /** Venta resultante al convertir (traza); null mientras no se convierte. */
    saleId: text('sale_id').references(() => sales.id),
    notes: text('notes'),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    dateIdx: index('idx_quotes_date').on(t.date),
    customerIdx: index('idx_quotes_customer').on(t.customerId),
    statusIdx: index('idx_quotes_status').on(t.status),
    numberIdx: uniqueIndex('idx_quotes_number').on(t.number),
    typeCheck: check('quotes_type_check', sql`${t.type} in ('A', 'B', 'C', 'X')`),
    statusCheck: check(
      'quotes_status_check',
      sql`${t.status} in ('pending', 'accepted', 'rejected', 'converted')`,
    ),
  }),
);

/* ------------------------------------------------------------------ */
/* quoteLines — líneas de presupuesto (precios congelados)             */
/* ------------------------------------------------------------------ */
export const quoteLines = sqliteTable(
  'quote_lines',
  {
    id: pk(),
    quoteId: text('quote_id')
      .notNull()
      .references(() => quotes.id, { onDelete: 'cascade' }),
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
    quoteIdx: index('idx_quote_lines_quote').on(t.quoteId),
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

/**
 * AUDITORÍA — registro append-only de operaciones (lo llena la capa IPC).
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: pk(),
    createdAt: integer('created_at').notNull(),
    userId: text('user_id'),
    username: text('username').notNull(),
    channel: text('channel').notNull(),
    area: text('area').notNull(),
    description: text('description').notNull(),
  },
  (t) => ({
    createdIdx: index('idx_audit_created').on(t.createdAt),
    userIdx: index('idx_audit_user').on(t.userId),
  }),
);
export type AuditLogEntry = typeof auditLog.$inferSelect;

/* ------------------------------------------------------------------ */
/* FACTURACIÓN ELECTRÓNICA ARCA (ex AFIP)                              */
/* ------------------------------------------------------------------ */

/** Configuración fiscal (singleton, id='singleton'). */
export const fiscalConfig = sqliteTable('fiscal_config', {
  id: text('id').primaryKey(),
  environment: text('environment', { enum: ['homologacion', 'produccion'] })
    .notNull()
    .default('homologacion'),
  cuit: text('cuit').notNull(),
  businessName: text('business_name'),
  address: text('address'),
  /** Condición del EMISOR frente al IVA. */
  vatCondition: text('vat_condition', { enum: ['RI', 'MT'] }).notNull().default('RI'),
  grossIncome: text('gross_income'),
  activityStartDate: integer('activity_start_date'),
  certPath: text('cert_path'),
  keyAlias: text('key_alias'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAtCol(),
  updatedAt: updatedAtCol(),
});
export type FiscalConfig = typeof fiscalConfig.$inferSelect;

/** Puntos de venta habilitados en ARCA (uno por terminal que factura). */
export const salePoints = sqliteTable(
  'sale_points',
  {
    id: pk(),
    number: integer('number').notNull(),
    description: text('description').notNull(),
    /** Terminal asignada (null = cualquiera puede usarlo). */
    terminalId: text('terminal_id'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({ numberIdx: uniqueIndex('idx_sale_points_number').on(t.number) }),
);
export type SalePoint = typeof salePoints.$inferSelect;

/** Comprobantes fiscales emitidos (facturas y notas de crédito/débito). */
export const fiscalVouchers = sqliteTable(
  'fiscal_vouchers',
  {
    id: pk(),
    /** Código ARCA: 1=FA 6=FB 11=FC / 3=NCA 8=NCB 13=NCC / 2=NDA 7=NDB 12=NDC */
    voucherCode: integer('voucher_code').notNull(),
    letter: text('letter', { enum: ['A', 'B', 'C'] }).notNull(),
    kind: text('kind', { enum: ['invoice', 'credit_note', 'debit_note'] })
      .notNull()
      .default('invoice'),
    salePoint: integer('sale_point').notNull(),
    number: integer('number').notNull(),
    date: integer('date').notNull(),
    saleId: text('sale_id').references(() => sales.id),
    /** Comprobante ajustado por una nota de crédito/débito. */
    relatedVoucherId: text('related_voucher_id'),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    /** Datos del receptor congelados al emitir (ARCA los exige inmutables). */
    customerDocType: integer('customer_doc_type').notNull(),
    customerDocNumber: text('customer_doc_number').notNull(),
    customerName: text('customer_name').notNull(),
    netAmount: text('net_amount').notNull().default('0.0000'),
    vatAmount: text('vat_amount').notNull().default('0.0000'),
    exemptAmount: text('exempt_amount').notNull().default('0.0000'),
    untaxedAmount: text('untaxed_amount').notNull().default('0.0000'),
    total: text('total').notNull(),
    cae: text('cae'),
    caeExpiry: integer('cae_expiry'),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'error'] })
      .notNull()
      .default('pending'),
    observations: text('observations'),
    errors: text('errors'),
    qrUrl: text('qr_url'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => ({
    numIdx: uniqueIndex('idx_fiscal_vouchers_num').on(t.voucherCode, t.salePoint, t.number),
    dateIdx: index('idx_fiscal_vouchers_date').on(t.date),
    saleIdx: index('idx_fiscal_vouchers_sale').on(t.saleId),
    customerIdx: index('idx_fiscal_vouchers_customer').on(t.customerId),
  }),
);
export type FiscalVoucher = typeof fiscalVouchers.$inferSelect;

/** Desglose de alícuotas de IVA por comprobante (ARCA lo exige detallado). */
export const fiscalVoucherVat = sqliteTable(
  'fiscal_voucher_vat',
  {
    id: pk(),
    voucherId: text('voucher_id')
      .notNull()
      .references(() => fiscalVouchers.id, { onDelete: 'cascade' }),
    /** Id de alícuota ARCA: 3=0% 4=10.5% 5=21% 6=27% */
    vatId: integer('vat_id').notNull(),
    baseAmount: text('base_amount').notNull(),
    vatAmount: text('vat_amount').notNull(),
  },
  (t) => ({ voucherIdx: index('idx_fiscal_vat_voucher').on(t.voucherId) }),
);
export type FiscalVoucherVat = typeof fiscalVoucherVat.$inferSelect;

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
/* mp_config — configuración de la integración MercadoPago QR          */
/* ------------------------------------------------------------------ */
export const mpConfig = sqliteTable('mp_config', {
  id: text('id').primaryKey(),
  companyId: text('company_id').references(() => companies.id),
  mpUserId: text('mp_user_id').notNull(),
  /** Access token cifrado (safeStorage Electron / AES-GCM fallback / "plain:" en tests). */
  accessTokenEncrypted: text('access_token_encrypted').notNull(),
  webhookSecret: text('webhook_secret').notNull(),
  storeId: text('store_id'),
  webhookUrlConfigured: integer('webhook_url_configured').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/* ------------------------------------------------------------------ */
/* mp_pos_devices — asociación caja ↔ POS MercadoPago + QR              */
/* ------------------------------------------------------------------ */
export const mpPosDevices = sqliteTable('mp_pos_devices', {
  id: text('id').primaryKey(),
  cashRegisterId: text('cash_register_id')
    .notNull()
    .references(() => cashRegisters.id)
    .unique(),
  externalPosId: text('external_pos_id').notNull().unique(),
  mpPosId: text('mp_pos_id').notNull(),
  qrUrl: text('qr_url').notNull(),
  qrImageBase64: text('qr_image_base64'),
  active: integer('active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/* ------------------------------------------------------------------ */
/* mp_orders — órdenes de cobro QR (PUT order)                          */
/* ------------------------------------------------------------------ */
export const mpOrders = sqliteTable(
  'mp_orders',
  {
    id: text('id').primaryKey(),
    mpPosDeviceId: text('mp_pos_device_id')
      .notNull()
      .references(() => mpPosDevices.id),
    saleId: text('sale_id').references(() => sales.id),
    externalReference: text('external_reference').notNull().unique(),
    amount: text('amount').notNull(),
    description: text('description').notNull(),
    /** pending | approved | rejected | cancelled | expired */
    status: text('status').notNull(),
    mpPaymentId: text('mp_payment_id').unique(),
    mpMerchantOrderId: text('mp_merchant_order_id'),
    expiresAt: integer('expires_at').notNull(),
    paidAt: integer('paid_at'),
    createdAt: integer('created_at').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
  },
  (t) => ({
    byStatus: index('idx_mp_orders_status').on(t.status),
    byExpires: index('idx_mp_orders_expires').on(t.expiresAt),
    byExternalRef: index('idx_mp_orders_external_ref').on(t.externalReference),
  }),
);

export type MpConfig = typeof mpConfig.$inferSelect;
export type NewMpConfig = typeof mpConfig.$inferInsert;
export type MpPosDevice = typeof mpPosDevices.$inferSelect;
export type NewMpPosDevice = typeof mpPosDevices.$inferInsert;
export type MpOrder = typeof mpOrders.$inferSelect;
export type NewMpOrder = typeof mpOrders.$inferInsert;

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

/* ------------------------------------------------------------------ */
/* cashGeneral — saldo histórico global (caja general / caja fuerte)   */
/* ------------------------------------------------------------------ */
export const cashGeneral = sqliteTable('cash_general', {
  id: text('id').primaryKey(),
  currentBalance: text('current_balance').notNull().default('0'),
  /** Saldo en efectivo físico (parte de current_balance). */
  cashBalance: text('cash_balance').notNull().default('0'),
  /** Saldo electrónico: transferencias, tarjetas, QR (parte de current_balance). */
  electronicBalance: text('electronic_balance').notNull().default('0'),
  lastUpdate: integer('last_update').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const cashGeneralMovements = sqliteTable(
  'cash_general_movements',
  {
    id: text('id').primaryKey(),
    /** 'income' | 'expense' | 'transfer_from_daily' */
    type: text('type').notNull(),
    amount: text('amount').notNull(),
    description: text('description').notNull(),
    /** 'deposit' | 'withdrawal' | 'service' | 'salary' | 'other' (nullable) */
    category: text('category'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    referenceId: text('reference_id'),
    balanceAfter: text('balance_after').notNull(),
    /** true = efectivo físico, false = electrónico (transfer/tarjeta/QR). */
    isCash: integer('is_cash', { mode: 'boolean' }).notNull().default(true),
    /** Saldo de efectivo tras este movimiento. */
    balanceAfterCash: text('balance_after_cash').notNull().default('0'),
    /** Saldo electrónico tras este movimiento. */
    balanceAfterElectronic: text('balance_after_electronic').notNull().default('0'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    byDate: index('idx_cgm_date').on(t.createdAt),
    byType: index('idx_cgm_type').on(t.type),
  }),
);

export type CashGeneral = typeof cashGeneral.$inferSelect;
export type NewCashGeneral = typeof cashGeneral.$inferInsert;
export type CashGeneralMovement = typeof cashGeneralMovements.$inferSelect;
export type NewCashGeneralMovement = typeof cashGeneralMovements.$inferInsert;

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
export type RoleAreaAccess = typeof roleAreaAccess.$inferSelect;
export type NewRoleAreaAccess = typeof roleAreaAccess.$inferInsert;
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
export type Return = typeof returns.$inferSelect;
export type NewReturn = typeof returns.$inferInsert;
export type ReturnLine = typeof returnLines.$inferSelect;
export type NewReturnLine = typeof returnLines.$inferInsert;
export type PurchaseReturn = typeof purchaseReturns.$inferSelect;
export type NewPurchaseReturn = typeof purchaseReturns.$inferInsert;
export type PurchaseReturnLine = typeof purchaseReturnLines.$inferSelect;
export type NewPurchaseReturnLine = typeof purchaseReturnLines.$inferInsert;
export type Promotion = typeof promotions.$inferSelect;
export type NewPromotion = typeof promotions.$inferInsert;
export type PromotionItem = typeof promotionItems.$inferSelect;
export type NewPromotionItem = typeof promotionItems.$inferInsert;
export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
export type QuoteLine = typeof quoteLines.$inferSelect;
export type NewQuoteLine = typeof quoteLines.$inferInsert;
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
  roleAreaAccess,
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
  cashGeneral,
  cashGeneralMovements,
  mpConfig,
  mpPosDevices,
  mpOrders,
  auditLog,
  fiscalConfig,
  salePoints,
  fiscalVouchers,
  fiscalVoucherVat,
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
