CREATE TABLE `payment_methods` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`is_physical_cash` integer DEFAULT 0 NOT NULL,
	`commission_pct` text DEFAULT '0.00' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "payment_methods_type_check" CHECK("payment_methods"."type" in ('cash', 'transfer', 'debit_card', 'credit_card', 'mp', 'check', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_methods_name_unique` ON `payment_methods` (`name`);--> statement-breakpoint
INSERT INTO `payment_methods` (`id`, `name`, `type`, `is_physical_cash`, `commission_pct`, `active`, `sort_order`, `created_at`, `updated_at`) VALUES
	('pm-efectivo', 'Efectivo', 'cash', 1, '0.00', 1, 1, 1778580000000, 1778580000000),
	('pm-transferencia', 'Transferencia', 'transfer', 0, '0.00', 1, 2, 1778580000000, 1778580000000),
	('pm-tarjeta-credito', 'Tarjeta de Crédito', 'credit_card', 0, '0.00', 1, 3, 1778580000000, 1778580000000),
	('pm-tarjeta-debito', 'Tarjeta de Débito', 'debit_card', 0, '0.00', 1, 4, 1778580000000, 1778580000000);
--> statement-breakpoint
CREATE TABLE `sale_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`payment_method_id` text NOT NULL,
	`amount` text NOT NULL,
	`reference` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sale_payments_sale` ON `sale_payments` (`sale_id`);--> statement-breakpoint
INSERT INTO `sale_payments` (`id`, `sale_id`, `payment_method_id`, `amount`, `reference`, `created_at`)
	SELECT lower(hex(randomblob(16))), `id`, 'pm-efectivo', `total`, NULL, `created_at` FROM `sales` WHERE `payment_type` = 'cash';
--> statement-breakpoint
INSERT INTO `sale_payments` (`id`, `sale_id`, `payment_method_id`, `amount`, `reference`, `created_at`)
	SELECT lower(hex(randomblob(16))), `id`, 'pm-tarjeta-credito', `total`, (SELECT `name` FROM `cards` WHERE `cards`.`id` = `sales`.`card_id`), `created_at` FROM `sales` WHERE `payment_type` = 'card';
--> statement-breakpoint
INSERT INTO `sale_payments` (`id`, `sale_id`, `payment_method_id`, `amount`, `reference`, `created_at`)
	SELECT lower(hex(randomblob(16))), `id`, 'pm-efectivo', printf('%.4f', CAST(`total` AS REAL) - CAST(COALESCE(`card_amount`, '0') AS REAL)), NULL, `created_at` FROM `sales` WHERE `payment_type` = 'mixed' AND (CAST(`total` AS REAL) - CAST(COALESCE(`card_amount`, '0') AS REAL)) > 0;
--> statement-breakpoint
INSERT INTO `sale_payments` (`id`, `sale_id`, `payment_method_id`, `amount`, `reference`, `created_at`)
	SELECT lower(hex(randomblob(16))), `id`, 'pm-tarjeta-credito', printf('%.4f', CAST(COALESCE(`card_amount`, '0') AS REAL)), (SELECT `name` FROM `cards` WHERE `cards`.`id` = `sales`.`card_id`), `created_at` FROM `sales` WHERE `payment_type` = 'mixed' AND CAST(COALESCE(`card_amount`, '0') AS REAL) > 0;
--> statement-breakpoint
CREATE TABLE `__new_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`amount` text NOT NULL,
	`date` integer NOT NULL,
	`payment_method_id` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts_receivable`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_payments` (`id`, `account_id`, `amount`, `date`, `payment_method_id`, `notes`, `created_at`)
	SELECT `id`, `account_id`, `amount`, `date`,
		CASE `method` WHEN 'cash' THEN 'pm-efectivo' WHEN 'transfer' THEN 'pm-transferencia' WHEN 'card' THEN 'pm-tarjeta-credito' ELSE 'pm-efectivo' END,
		`notes`, `created_at` FROM `payments`;
--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
CREATE INDEX `idx_payments_account` ON `payments` (`account_id`);--> statement-breakpoint
CREATE TABLE `__new_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`type` text NOT NULL,
	`date` integer NOT NULL,
	`customer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`cash_register_id` text NOT NULL,
	`is_account_sale` integer DEFAULT 0 NOT NULL,
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
	CONSTRAINT "sales_type_check" CHECK("__new_sales"."type" in ('A', 'B', 'C', 'X')),
	CONSTRAINT "sales_status_check" CHECK("__new_sales"."status" in ('completed', 'voided', 'pending'))
);
--> statement-breakpoint
INSERT INTO `__new_sales` (`id`, `number`, `type`, `date`, `customer_id`, `seller_id`, `cash_register_id`, `is_account_sale`, `subtotal`, `discount`, `vat_amount`, `total`, `status`, `afip_cae`, `afip_expiry`, `afip_observations`, `afip_qr_url`, `notes`, `created_at`, `updated_at`)
	SELECT `id`, `number`, `type`, `date`, `customer_id`, `seller_id`, `cash_register_id`,
		CASE WHEN `payment_type` = 'account' THEN 1 ELSE 0 END,
		`subtotal`, `discount`, `vat_amount`, `total`, `status`, `afip_cae`, `afip_expiry`, `afip_observations`, `afip_qr_url`, `notes`, `created_at`, `updated_at` FROM `sales`;
--> statement-breakpoint
DROP TABLE `sales`;--> statement-breakpoint
ALTER TABLE `__new_sales` RENAME TO `sales`;--> statement-breakpoint
CREATE INDEX `idx_sales_date` ON `sales` (`date`);--> statement-breakpoint
CREATE INDEX `idx_sales_customer` ON `sales` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_seller` ON `sales` (`seller_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sales_number` ON `sales` (`type`,`number`);--> statement-breakpoint
ALTER TABLE `cash_movements` ADD `payment_method_id` text REFERENCES payment_methods(id);
