CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`sale_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`user_id` text NOT NULL,
	`cash_register_id` text,
	`date` integer NOT NULL,
	`refund_method` text DEFAULT 'cash' NOT NULL,
	`total` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_register_id`) REFERENCES `cash_registers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "returns_refund_method_check" CHECK("returns"."refund_method" in ('cash', 'account'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_returns_number` ON `returns` (`number`);--> statement-breakpoint
CREATE INDEX `idx_returns_sale` ON `returns` (`sale_id`);--> statement-breakpoint
CREATE TABLE `return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`return_id` text NOT NULL,
	`sale_line_id` text NOT NULL,
	`article_id` text NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` text NOT NULL,
	`line_total` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sale_line_id`) REFERENCES `sale_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_return_lines_return` ON `return_lines` (`return_id`);--> statement-breakpoint
CREATE INDEX `idx_return_lines_sale_line` ON `return_lines` (`sale_line_id`);--> statement-breakpoint
CREATE TABLE `purchase_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`purchase_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`user_id` text NOT NULL,
	`cash_register_id` text,
	`date` integer NOT NULL,
	`refund_method` text DEFAULT 'cash' NOT NULL,
	`total` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_register_id`) REFERENCES `cash_registers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_returns_refund_method_check" CHECK("purchase_returns"."refund_method" in ('cash', 'account'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_purchase_returns_number` ON `purchase_returns` (`number`);--> statement-breakpoint
CREATE INDEX `idx_purchase_returns_purchase` ON `purchase_returns` (`purchase_id`);--> statement-breakpoint
CREATE TABLE `purchase_return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`return_id` text NOT NULL,
	`purchase_line_id` text NOT NULL,
	`article_id` text NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` text NOT NULL,
	`line_total` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `purchase_returns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`purchase_line_id`) REFERENCES `purchase_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_purchase_return_lines_return` ON `purchase_return_lines` (`return_id`);
