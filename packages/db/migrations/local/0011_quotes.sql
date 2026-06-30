CREATE TABLE `quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`number` integer NOT NULL,
	`type` text DEFAULT 'B' NOT NULL,
	`date` integer NOT NULL,
	`customer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`validity_days` integer DEFAULT 30 NOT NULL,
	`subtotal` text NOT NULL,
	`discount` text DEFAULT '0.0000' NOT NULL,
	`vat_amount` text DEFAULT '0.0000' NOT NULL,
	`total` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`sale_id` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "quotes_type_check" CHECK("quotes"."type" in ('A', 'B', 'C', 'X')),
	CONSTRAINT "quotes_status_check" CHECK("quotes"."status" in ('pending', 'accepted', 'rejected', 'converted'))
);
--> statement-breakpoint
CREATE INDEX `idx_quotes_date` ON `quotes` (`date`);--> statement-breakpoint
CREATE INDEX `idx_quotes_customer` ON `quotes` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_quotes_status` ON `quotes` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_quotes_number` ON `quotes` (`number`);--> statement-breakpoint
CREATE TABLE `quote_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`quote_id` text NOT NULL,
	`article_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`quantity` text NOT NULL,
	`unit_price` text NOT NULL,
	`discount` text DEFAULT '0.0000' NOT NULL,
	`vat_rate` text DEFAULT '21.00' NOT NULL,
	`line_total` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`quote_id`) REFERENCES `quotes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_quote_lines_quote` ON `quote_lines` (`quote_id`);
