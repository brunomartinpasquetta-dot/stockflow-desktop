CREATE TABLE `role_area_access` (
	`role` text NOT NULL,
	`area` text NOT NULL,
	`allowed` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`role`, `area`)
);
