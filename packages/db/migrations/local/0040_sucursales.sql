-- MULTISUCURSAL (ver docs/PLAN_MULTISUCURSAL.md): tabla de sucursales.
--
-- Sólo AGREGA una tabla y UNA fila. Ninguna otra tabla la referencia todavía
-- (las columnas branch_id llegan en las etapas 2 y 3), así que un comercio
-- común no nota nada: la pantalla de sucursales sólo aparece con la licencia
-- Multisucursal.
--
-- "Casa central" nace acá, en la propia migración, con un id FIJO e igual en
-- todas las bases (SUCURSAL_CENTRAL_ID en packages/db/src/schema/local.ts).
-- Así, cuando la etapa 2 asigne el stock existente a la casa central, el id
-- es conocido de antemano y no depende de qué haya corrido antes en cada PC.
-- INSERT OR IGNORE: si la fila ya existe (base restaurada, migración repetida)
-- no se toca; se conserva el nombre que le haya puesto el comercio.
--
-- `is_main`: a lo sumo UNA sucursal principal (índice único parcial).
CREATE TABLE IF NOT EXISTS `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`is_main` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_branches_code` ON `branches` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_branches_main` ON `branches` (`is_main`) WHERE `is_main` = 1;--> statement-breakpoint
INSERT OR IGNORE INTO `branches` (`id`, `name`, `code`, `active`, `is_main`, `created_at`, `updated_at`)
VALUES (
	'01a10435-d800-7000-8000-000000000001',
	'Casa central',
	'CENTRAL',
	1,
	1,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
