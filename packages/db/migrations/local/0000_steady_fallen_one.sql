CREATE TABLE `accounts_receivable` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`sale_id` text NOT NULL,
	`total` text NOT NULL,
	`balance` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "accounts_receivable_status_check" CHECK("accounts_receivable"."status" in ('open', 'paid', 'partial'))
);
--> statement-breakpoint
CREATE INDEX `idx_ar_customer` ON `accounts_receivable` (`customer_id`);--> statement-breakpoint
CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`barcode` text NOT NULL,
	`description` text NOT NULL,
	`brand` text,
	`family_id` text,
	`supplier_id` text,
	`cost_price` text DEFAULT '0.0000' NOT NULL,
	`list_price1` text DEFAULT '0.0000' NOT NULL,
	`list_price2` text DEFAULT '0.0000' NOT NULL,
	`list_price3` text DEFAULT '0.0000' NOT NULL,
	`wholesale_price` text DEFAULT '0.0000' NOT NULL,
	`wholesale_min_qty` text DEFAULT '0.000' NOT NULL,
	`vat_rate` text DEFAULT '21.00' NOT NULL,
	`stock` text DEFAULT '0.000' NOT NULL,
	`min_stock` text DEFAULT '0.000' NOT NULL,
	`ideal_stock` text DEFAULT '0.000' NOT NULL,
	`sold_by_weight` integer DEFAULT false NOT NULL,
	`unit` text DEFAULT 'UN' NOT NULL,
	`image_path` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`family_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "articles_unit_check" CHECK("articles"."unit" in ('UN', 'KG', 'GR', 'LT', 'ML'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_barcode_unique` ON `articles` (`barcode`);--> statement-breakpoint
CREATE INDEX `idx_articles_barcode` ON `articles` (`barcode`);--> statement-breakpoint
CREATE INDEX `idx_articles_family` ON `articles` (`family_id`);--> statement-breakpoint
CREATE INDEX `idx_articles_supplier` ON `articles` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`commission_pct` text DEFAULT '0.00' NOT NULL,
	`discount_pct` text DEFAULT '0.00' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_name_unique` ON `cards` (`name`);--> statement-breakpoint
CREATE TABLE `cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`cash_register_id` text NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`amount` text NOT NULL,
	`date` integer NOT NULL,
	`user_id` text NOT NULL,
	`related_sale_id` text,
	`related_purchase_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`cash_register_id`) REFERENCES `cash_registers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`related_sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`related_purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cash_movements_type_check" CHECK("cash_movements"."type" in ('income', 'expense'))
);
--> statement-breakpoint
CREATE INDEX `idx_cash_movements_register` ON `cash_movements` (`cash_register_id`);--> statement-breakpoint
CREATE TABLE `cash_registers` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`open_date` integer NOT NULL,
	`close_date` integer,
	`opening_amount` text NOT NULL,
	`closing_amount` text,
	`status` text NOT NULL,
	`user_id` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cash_registers_status_check" CHECK("cash_registers"."status" in ('open', 'closed'))
);
--> statement-breakpoint
CREATE INDEX `idx_cash_status` ON `cash_registers` (`status`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`phone` text,
	`email` text,
	`cuit` text,
	`ing_brutos` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`last_name` text NOT NULL,
	`first_name` text,
	`address` text,
	`city` text,
	`phone` text,
	`mobile` text,
	`doc_type` text,
	`doc_number` text,
	`category` text NOT NULL,
	`price_list` integer DEFAULT 1 NOT NULL,
	`credit_limit` text DEFAULT '0.0000' NOT NULL,
	`email` text,
	`facebook` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "customers_category_check" CHECK("customers"."category" in ('RI', 'MT', 'CF', 'EX')),
	CONSTRAINT "customers_price_list_check" CHECK("customers"."price_list" in (1, 2, 3)),
	CONSTRAINT "customers_doc_type_check" CHECK("customers"."doc_type" is null or "customers"."doc_type" in ('DNI', 'CUIT', 'CUIL', 'PASS', 'CF'))
);
--> statement-breakpoint
CREATE INDEX `idx_customers_lastname` ON `customers` (`last_name`);--> statement-breakpoint
CREATE TABLE `families` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `families`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`amount` text NOT NULL,
	`date` integer NOT NULL,
	`method` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts_receivable`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_method_check" CHECK("payments"."method" in ('cash', 'transfer', 'card'))
);
--> statement-breakpoint
CREATE TABLE `purchase_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`article_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`quantity` text NOT NULL,
	`cost_price` text NOT NULL,
	`sale_price` text NOT NULL,
	`vat_rate` text DEFAULT '21.00' NOT NULL,
	`line_total` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_purchase_lines_purchase` ON `purchase_lines` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`type` text NOT NULL,
	`supplier_invoice_number` text,
	`date` integer NOT NULL,
	`supplier_id` text NOT NULL,
	`payment_type` text NOT NULL,
	`subtotal` text NOT NULL,
	`discount` text DEFAULT '0.0000' NOT NULL,
	`vat_amount` text DEFAULT '0.0000' NOT NULL,
	`total` text NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`updated_prices_on_save` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchases_type_check" CHECK("purchases"."type" in ('A', 'B', 'C', 'X')),
	CONSTRAINT "purchases_payment_type_check" CHECK("purchases"."payment_type" in ('cash', 'credit'))
);
--> statement-breakpoint
CREATE INDEX `idx_purchases_date` ON `purchases` (`date`);--> statement-breakpoint
CREATE INDEX `idx_purchases_supplier` ON `purchases` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `sale_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`article_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` text NOT NULL,
	`discount` text DEFAULT '0.0000' NOT NULL,
	`vat_rate` text DEFAULT '21.00' NOT NULL,
	`line_total` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sale_lines_sale` ON `sale_lines` (`sale_id`);--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`type` text NOT NULL,
	`date` integer NOT NULL,
	`customer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`cash_register_id` text NOT NULL,
	`payment_type` text NOT NULL,
	`card_id` text,
	`card_amount` text DEFAULT '0.0000',
	`subtotal` text NOT NULL,
	`discount` text DEFAULT '0.0000' NOT NULL,
	`vat_amount` text DEFAULT '0.0000' NOT NULL,
	`total` text NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`afip_cae` text,
	`afip_expiry` integer,
	`afip_observations` text,
	`afip_qr_url` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_register_id`) REFERENCES `cash_registers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sales_type_check" CHECK("sales"."type" in ('A', 'B', 'C', 'X')),
	CONSTRAINT "sales_payment_type_check" CHECK("sales"."payment_type" in ('cash', 'card', 'mixed', 'account')),
	CONSTRAINT "sales_status_check" CHECK("sales"."status" in ('completed', 'voided', 'pending'))
);
--> statement-breakpoint
CREATE INDEX `idx_sales_date` ON `sales` (`date`);--> statement-breakpoint
CREATE INDEX `idx_sales_customer` ON `sales` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_seller` ON `sales` (`seller_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sales_number` ON `sales` (`type`,`number`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`city` text,
	`cuit` text,
	`ing_brutos` text,
	`phone` text,
	`mobile` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_code_unique` ON `suppliers` (`code`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`full_name` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('admin', 'manager', 'seller'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);