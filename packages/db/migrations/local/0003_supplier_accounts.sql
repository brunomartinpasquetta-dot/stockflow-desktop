CREATE TABLE `supplier_accounts_payable` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`purchase_id` text NOT NULL,
	`total` text NOT NULL,
	`balance` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "supplier_accounts_payable_status_check" CHECK("supplier_accounts_payable"."status" in ('open', 'paid', 'partial'))
);
--> statement-breakpoint
CREATE INDEX `idx_sap_supplier` ON `supplier_accounts_payable` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `supplier_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`payment_method_id` text NOT NULL,
	`amount` text NOT NULL,
	`date` integer NOT NULL,
	`reference` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `supplier_accounts_payable`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_supplier_payments_account` ON `supplier_payments` (`account_id`);
