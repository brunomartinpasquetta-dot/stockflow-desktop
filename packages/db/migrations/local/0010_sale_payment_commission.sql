ALTER TABLE `sale_payments` ADD `commission_pct` text DEFAULT '0.0000' NOT NULL;--> statement-breakpoint
ALTER TABLE `sale_payments` ADD `commission_amount` text DEFAULT '0.0000' NOT NULL;--> statement-breakpoint
ALTER TABLE `sale_payments` ADD `net_amount` text DEFAULT '0.0000' NOT NULL;