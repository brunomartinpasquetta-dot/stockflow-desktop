CREATE TABLE `promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_promotions_article` ON `promotions` (`article_id`);--> statement-breakpoint
CREATE TABLE `promotion_items` (
	`id` text PRIMARY KEY NOT NULL,
	`promotion_id` text NOT NULL,
	`article_id` text NOT NULL,
	`quantity` text DEFAULT '1.000' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`promotion_id`) REFERENCES `promotions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_promotion_items_promotion` ON `promotion_items` (`promotion_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_promotion_items_promotion_article` ON `promotion_items` (`promotion_id`,`article_id`);
