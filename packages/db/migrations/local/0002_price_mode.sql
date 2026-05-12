ALTER TABLE `companies` ADD `price_mode` text DEFAULT 'gross' NOT NULL CHECK("companies"."price_mode" in ('gross', 'net'));
